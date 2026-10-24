
import { useEffect, useRef, useState } from 'react'
import {
  createPublicClient,
  http,
  formatUnits,
  erc20Abi,
  getAddress,
} from 'viem'
import { robinhood, PARLAY_TOKEN } from './chain'
import './App.css'

// PARLAY_WALLET_CHOOSER_V1: EIP-6963 discovery keeps wallet extensions separate.
type WalletProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
  isRabby?: boolean
  isMetaMask?: boolean
  isCoinbaseWallet?: boolean
  isPhantom?: boolean
  providers?: WalletProvider[]
}

type DetectedWallet = {
  id: string
  name: string
  kind: 'rabby' | 'metamask' | 'coinbase' | 'phantom' | 'other'
  provider: WalletProvider
}

function classifyWallet(name: string, rdns = '', provider?: WalletProvider): DetectedWallet['kind'] {
  const identity = `${name} ${rdns}`.toLowerCase()
  if (identity.includes('phantom') || provider?.isPhantom) return 'phantom'
  if (identity.includes('rabby') || provider?.isRabby) return 'rabby'
  if (identity.includes('coinbase') || provider?.isCoinbaseWallet) return 'coinbase'
  if (identity.includes('metamask') || provider?.isMetaMask) return 'metamask'
  return 'other'
}

type WalletAddress = `0x${string}`

type ProposalOption = {
  id: number
  proposal_id: number
  title: string
  description: string | null
}

type VotingResult = {
  option_id: number
  voting_power: string
  percentage: number
}

type Proposal = {
  id: number
  title: string
  description: string | null
  snapshot_block: string
  start_time: string
  end_time: string
  status: string
  options: ProposalOption[]
  results?: VotingResult[]
  proof_url?: string | null
  results_finalized?: boolean
  closing_block?: string | null
}

const publicClient = createPublicClient({
  chain: robinhood,
  transport: http(),
})

function formatCountdown(endTime: string, now: number) {
  const remaining = new Date(endTime).getTime() - now

  if (!Number.isFinite(remaining)) {
    return 'Deadline unavailable'
  }

  if (remaining <= 0) {
    return 'Voting closed'
  }

  const seconds = Math.floor(remaining / 1000)
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m remaining`
  }

  return `${hours}h ${minutes}m ${secs}s remaining`
}

function formatVotingPower(value: string) {
  try {
    return Number(formatUnits(BigInt(value), 18)).toLocaleString(undefined, { maximumFractionDigits: 4 })
  } catch {
    return value
  }
}

function App() {
  const [wallet, setWallet] = useState<WalletAddress | null>(null)
  const [balance, setBalance] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [walletChooserOpen, setWalletChooserOpen] = useState(false)
  const [detectedWallets, setDetectedWallets] = useState<DetectedWallet[]>([])
  const selectedProviderRef = useRef<WalletProvider | null>(null)

  useEffect(() => {
    const onAnnouncement = (event: Event) => {
      const detail = (event as CustomEvent<{
        info?: { uuid?: string; name?: string; rdns?: string }
        provider?: WalletProvider
      }>).detail
      if (!detail?.provider || !detail.info) return
      const { provider, info } = detail
      setDetectedWallets((current) => {
        const name = info.name || 'Browser Wallet'
        const kind = classifyWallet(name, info.rdns, provider)
        if (current.some((item) =>
          item.provider === provider ||
          (kind !== 'other' && item.kind === kind)
        )) return current
        return [...current, {
          id: info.uuid || `${name}-${current.length}`,
          name,
          kind,
          provider,
        }]
      })
    }

    window.addEventListener('eip6963:announceProvider', onAnnouncement)
    window.dispatchEvent(new Event('eip6963:requestProvider'))

    // Legacy fallback only when necessary, including multiple injected providers.
    // Wait briefly so announced providers can register first.
    const fallback = window.setTimeout(() => {
      const injected = (window as Window & { ethereum?: WalletProvider }).ethereum
      if (!injected) return
      const candidates = Array.isArray(injected.providers) ? injected.providers : [injected]
      setDetectedWallets((current) => {
        const next = [...current]
        for (const provider of candidates) {
          const kind = classifyWallet('', '', provider)
          if (next.some((item) =>
            item.provider === provider ||
            (kind !== 'other' && item.kind === kind)
          )) continue
          const label = kind === 'rabby' ? 'Rabby Wallet'
            : kind === 'metamask' ? 'MetaMask'
            : kind === 'coinbase' ? 'Coinbase Wallet'
            : kind === 'phantom' ? 'Phantom Wallet'
            : 'Browser Wallet'
          next.push({ id: `legacy-${next.length}`, name: label, kind, provider })
        }
        return next
      })
    }, 500)

    return () => {
      window.clearTimeout(fallback)
      window.removeEventListener('eip6963:announceProvider', onAnnouncement)
    }
  }, [])
  const [error, setError] = useState('')

  const [proposals, setProposals] = useState<Proposal[]>([])
  const [loading, setLoading] = useState(true)
  const [proposalError, setProposalError] = useState('')
  const [now, setNow] = useState(Date.now())
  const [selected, setSelected] = useState<Record<number, number>>({})
  const [submitting, setSubmitting] = useState<number | null>(null)
  const [voteErrors, setVoteErrors] = useState<Record<number, string>>({})
  const [voteSuccess, setVoteSuccess] = useState<Record<number, string>>({})

  const [votedProposalIds, setVotedProposalIds] = useState<number[]>([])
  const [checkingBallots, setCheckingBallots] = useState(false)
  const [ballotStatusVerified, setBallotStatusVerified] = useState(false)

  useEffect(() => {
    if (!wallet) {
      setVotedProposalIds([])
      setBallotStatusVerified(false)
      setCheckingBallots(false)
      return
    }

    let cancelled = false
    setCheckingBallots(true)
    setBallotStatusVerified(false)
    setVotedProposalIds([])

    fetch(`/api/votes/status?wallet=${encodeURIComponent(wallet)}`, {
      cache: 'no-store'
    })
      .then(async response => {
        const data = await response.json()
        if (!response.ok || !data.success) {
          throw new Error('Unable to verify ballot status')
        }
        return data.votedProposalIds as number[]
      })
      .then(ids => {
        if (!cancelled) {
          setVotedProposalIds(ids)
          setBallotStatusVerified(true)
        }
      })
      .catch(error => {
        if (!cancelled) {
          setError(error instanceof Error ? error.message : 'Ballot status unavailable')
        }
      })
      .finally(() => {
        if (!cancelled) setCheckingBallots(false)
      })

    return () => { cancelled = true }
  }, [wallet])


  useEffect(() => {
    let active = true

    async function loadProposals() {
      try {
        const response = await fetch('/api/proposals', {
          cache: 'no-store',
        })

        if (!response.ok) {
          throw new Error('Unable to load proposals.')
        }

        const data = await response.json() as {
          success: boolean
          proposals?: Proposal[]
          error?: string
        }

        if (!data.success || !Array.isArray(data.proposals)) {
          throw new Error(
            data.error || 'Invalid proposals response.'
          )
        }

        if (active) {
          setProposals(data.proposals)
          setProposalError('')
        }
      } catch (err) {
        if (active) {
          setProposalError(
            err instanceof Error
              ? err.message
              : 'Unable to load proposals.'
          )
        }
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    }

    void loadProposals()

    // Refresh proposals and finalized results every 30 seconds.
    const refresh = window.setInterval(() => {
      void loadProposals()
    }, 30000)

    // Update voting countdowns every second.
    const clock = window.setInterval(() => {
      setNow(Date.now())
    }, 1000)

    return () => {
      active = false
      window.clearInterval(refresh)
      window.clearInterval(clock)
    }
  }, [])

  function disconnectWallet() {
    selectedProviderRef.current = null
    setWallet(null)
    setBalance(null)
    setError('')
    setSelected({})
    setVoteErrors({})
    setVoteSuccess({})
    setVotedProposalIds([])
    setBallotStatusVerified(false)
  }

  async function connectWallet(provider: WalletProvider) {
    setConnecting(true)
    setError('')

    try {
      const accounts = await provider.request({
        method: 'eth_requestAccounts',
      }) as WalletAddress[]

      if (!accounts.length) throw new Error('No wallet account selected.')
      const address = getAddress(accounts[0])

      const [rawBalance, decimals] = await Promise.all([
        publicClient.readContract({
          address: PARLAY_TOKEN,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [address],
        }),
        publicClient.readContract({
          address: PARLAY_TOKEN,
          abi: erc20Abi,
          functionName: 'decimals',
        }),
      ])

      selectedProviderRef.current = provider
      setWallet(address)
      setBalance(formatUnits(rawBalance, decimals))
      setWalletChooserOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Wallet connection failed.')
    } finally {
      setConnecting(false)
    }
  }

  async function submitVote(proposal: Proposal) {
    const optionId = selected[proposal.id]
    if (!optionId || submitting !== null || voteSuccess[proposal.id]) return

    setVoteErrors((previous) => ({ ...previous, [proposal.id]: '' }))
    setSubmitting(proposal.id)

    try {
      const ethereum = selectedProviderRef.current
      if (!ethereum || !wallet) {
        throw new Error('Choose and connect your wallet before voting.')
      }

      // Check the active account and network again at signing time.
      const accounts = await ethereum.request({
        method: 'eth_requestAccounts',
      }) as WalletAddress[]
      if (!accounts.length) throw new Error('Connect a wallet first.')
      const address = getAddress(accounts[0])
      if (wallet && address.toLowerCase() !== wallet.toLowerCase()) {
        throw new Error('Wallet account changed. Reconnect your wallet before voting.')
      }

      const chainId = await ethereum.request({ method: 'eth_chainId' }) as string
      if (BigInt(chainId) !== 4663n) {
        throw new Error('Switch your wallet to Robinhood Chain (chain ID 4663) and try again.')
      }

      const nonce = crypto.randomUUID()
      // This JSON structure and property order must match src/worker.ts.
      const signedMessage = JSON.stringify({
        action: 'CAST_PARLAY_VOTE',
        origin: window.location.origin,
        chainId: 4663,
        token: '0xc4a481c39437680c54a2fdbe170d48a919ec98b7',
        proposalId: proposal.id,
        optionId,
        walletAddress: address,
        nonce,
      })

      const signature = await ethereum.request({
        method: 'personal_sign',
        params: [
          `0x${Array.from(new TextEncoder().encode(signedMessage))
            .map((byte) => byte.toString(16).padStart(2, '0')).join('')}`,
          address,
        ],
      }) as `0x${string}`

      const response = await fetch('/api/votes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proposalId: proposal.id,
          optionId,
          walletAddress: address,
          nonce,
          signature,
        }),
      })
      const result = await response.json() as {
        success?: boolean
        error?: string
      }
      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Your ballot could not be recorded.')
      }

      setWallet(address)
      setVoteSuccess((previous) => ({
        ...previous,
        [proposal.id]: 'Your signed ballot has been recorded. Voting power will be calculated at closing.',
      }))
    } catch (err) {
      setVoteErrors((previous) => ({
        ...previous,
        [proposal.id]: err instanceof Error ? err.message : 'Voting failed.',
      }))
    } finally {
      setSubmitting(null)
    }
  }

  const activeProposals = proposals.filter(
    (proposal) =>
      proposal.status === 'open' &&
      new Date(proposal.start_time).getTime() <= now &&
      new Date(proposal.end_time).getTime() > now
  )

  const closedProposals = proposals.filter(
    (proposal) =>
      proposal.status === 'closed' ||
      new Date(proposal.end_time).getTime() <= now
  )

  function renderResults(proposal: Proposal) {
    const finalized =
      proposal.results_finalized === true &&
      Array.isArray(proposal.results)

    if (!finalized) {
      return (
        <div className="balance">
          <span>FINAL VOTING RESULTS</span>

          <strong>AWAITING VERIFICATION</strong>

          <small>
            Verified results and voting proof are not yet available.
            No vote totals will be displayed until the voting
            verification system is operational.
          </small>
        </div>
      )
    }

    return (
      <div className="balance">
        <span>FINAL VOTING RESULTS</span>

        {proposal.options.map((option) => {
          const result = proposal.results?.find(
            (item) => item.option_id === option.id
          )

          const percentage = Math.max(
            0,
            Math.min(
              100,
              Number.isFinite(result?.percentage)
                ? result!.percentage
                : 0
            )
          )

          return (
            <div
              key={option.id}
              style={{ marginTop: 18, textAlign: 'left' }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 12,
                  marginBottom: 8,
                }}
              >
                <strong>{option.title}</strong>
                <strong>{percentage.toFixed(2)}%</strong>
              </div>

              <div
                style={{
                  width: '100%',
                  height: 12,
                  borderRadius: 999,
                  background: 'rgba(255,255,255,0.16)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${percentage}%`,
                    height: '100%',
                    borderRadius: 999,
                    background:
                      'linear-gradient(90deg, #16a34a, #e5c35b)',
                  }}
                />
              </div>

              <small>
                {result
                  ? formatVotingPower(result.voting_power)
                  : '0'}{' '}
                $PARLAY-weighted votes
              </small>
            </div>
          )
        })}

        {proposal.proof_url ? (
          <p style={{ marginTop: 22 }}>
            <a
              href={proposal.proof_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: '#f3d878',
                fontWeight: 700,
                textDecoration: 'underline',
              }}
            >
              VIEW VOTING PROOF ↗
            </a>
          </p>
        ) : (
          <small>
            Independent voting proof is not yet available.
          </small>
        )}
      </div>
    )
  }

  return (
    <main className="page">
      <header className="header">
        <div className="brand">$PARLAY</div>
        <span className="network">ROBINHOOD CHAIN</span>
      </header>

      <section className="hero">
        <div className="eyebrow">COMMUNITY GOVERNANCE</div>

        <h1>
          YOUR TOKENS.
          <br />
          <span>YOUR VOTE.</span>
        </h1>

        <p>
          Help decide which community wager PARLAY backs next.
          Voting power is determined by your token holdings.
        </p>

        <button
          className="connect"
          onClick={wallet ? disconnectWallet : () => setWalletChooserOpen(true)}
          disabled={connecting || submitting !== null}
        >
          {connecting
            ? 'CONNECTING...'
            : wallet
              ? `DISCONNECT WALLET (${wallet.slice(0, 6)}...${wallet.slice(-4)})`
              : 'CONNECT WALLET'}
        </button>

        {error && <p role="alert">{error}</p>}
        {walletChooserOpen && !wallet && (
          <div className="wallet-overlay" role="presentation" onMouseDown={(event) => {
            if (event.target === event.currentTarget && !connecting) setWalletChooserOpen(false)
          }}>
            <div className="wallet-dialog" role="dialog" aria-modal="true" aria-labelledby="wallet-dialog-title">
              <button type="button" className="wallet-close" aria-label="Close wallet chooser"
                onClick={() => setWalletChooserOpen(false)} disabled={connecting}>×</button>
              <h2 id="wallet-dialog-title">CHOOSE YOUR WALLET</h2>
              <p>Select the wallet you want to use for PARLAY voting.</p>
              {(['metamask', 'rabby', 'coinbase'] as const).map((kind) => {
                const available = detectedWallets.filter((item) => item.kind === kind)
                const label = kind === 'metamask' ? 'MetaMask'
                  : kind === 'rabby' ? 'Rabby Wallet' : 'Coinbase Wallet'
                return (
                  <div key={kind}>
                    {available.length ? available.map((item) => (
                      <button key={item.id} type="button" className="wallet-choice"
                        disabled={connecting} onClick={() => void connectWallet(item.provider)}>
                        <span className="wallet-symbol">{kind === 'metamask' ? '🦊' : kind === 'rabby' ? '🐰' : '🔵'}</span>
                        <span>{label}</span><span className="wallet-availability">CONNECT →</span>
                      </button>
                    )) : (
                      <button key={`${kind}-missing`} type="button" className="wallet-choice" disabled>
                        <span className="wallet-symbol">{kind === 'metamask' ? '🦊' : kind === 'rabby' ? '🐰' : '🔵'}</span>
                        <span>{label}</span><span className="wallet-availability">NOT DETECTED</span>
                      </button>
                    )}
                  </div>
                )
              })}
              {detectedWallets.filter((item) => item.kind === 'other').map((item) => (
                <button key={item.id} type="button" className="wallet-choice"
                  disabled={connecting} onClick={() => void connectWallet(item.provider)}>
                  <span className="wallet-symbol">◈</span><span>{item.name}</span>
                  <span className="wallet-availability">CONNECT →</span>
                </button>
              ))}
              {connecting && <p>Waiting for wallet approval...</p>}
              <p className="wallet-footnote">Browser extensions only. No seed phrase or private key is requested.</p>
              {error && <p role="alert">{error}</p>}
            </div>
          </div>
        )}

      </section>

      {loading && (
        <section className="proposal">
          <h2>Loading proposals...</h2>
        </section>
      )}

      {proposalError && (
        <section className="proposal">
          <h2>Unable to load proposals</h2>
          <p role="alert">{proposalError}</p>
        </section>
      )}

      {!loading &&
        !proposalError &&
        activeProposals.length === 0 && (
          <section className="proposal">
            <div className="section-top">
              <span>COMMUNITY GOVERNANCE</span>
              <span className="status">NO ACTIVE VOTES</span>
            </div>

            <h2>No active proposals</h2>

            <p>
              There are currently no open voting proposals.
              Check back when the developers publish the next one.
            </p>
          </section>
        )}

      {!proposalError &&
        activeProposals.map((proposal) => (
          <section className="proposal" key={proposal.id}>
            <div className="section-top">
              <span>
                PROPOSAL #
                {String(proposal.id).padStart(3, '0')}
              </span>

              <span className="status">OPEN</span>
            </div>

            <h2>{proposal.title}</h2>

            {proposal.description && (
              <p>{proposal.description}</p>
            )}

            <p>
              <strong>TIME REMAINING:</strong>{' '}
              {formatCountdown(proposal.end_time, now)}
            </p>

            <p>
              <small>
                Voting closes:{' '}
                {new Date(
                  proposal.end_time
                ).toLocaleString()}
              </small>
            </p>

            <div className="choices">
              {proposal.options?.map((option) => (
                <button
                  key={option.id}
                  className={`choice ${
                    selected[proposal.id] === option.id
                      ? 'active'
                      : ''
                  }`}
                  onClick={() =>
                    setSelected((previous) => ({
                      ...previous,
                      [proposal.id]: option.id,
                    }))
                  }
                >
                  <span className="circle">
                    {selected[proposal.id] === option.id
                      ? '✓'
                      : ''}
                  </span>

                  <span>
                    <strong>{option.title}</strong>

                    {option.description && (
                      <small>{option.description}</small>
                    )}
                  </span>
                </button>
              ))}
            </div>

            <div className="balance">
              <span>YOUR CURRENT $PARLAY BALANCE</span>

              <strong>
                {balance === null
                  ? '— PARLAY'
                  : `${Number(
                      balance
                    ).toLocaleString()} PARLAY`}
              </strong>

              <small>
                {wallet
                  ? 'Current balance on Robinhood Chain. Voting power will use the proposal snapshot.'
                  : 'Connect your wallet to view your token balance.'}
              </small>
            </div>

            <button
              className="vote"
              disabled={
                !selected[proposal.id] ||
                submitting !== null ||
                !!voteSuccess[proposal.id] ||
                checkingBallots ||
                !ballotStatusVerified ||
                votedProposalIds.includes(proposal.id)
              }
              onClick={() => void submitVote(proposal)}
            >
              {votedProposalIds.includes(proposal.id)
                ? 'THIS WALLET HAS ALREADY CAST A BALLOT'
                : checkingBallots
                  ? 'CHECKING BALLOT STATUS...'
                  : wallet && !ballotStatusVerified
                    ? 'BALLOT STATUS UNAVAILABLE'
                  : voteSuccess[proposal.id]
                    ? 'BALLOT RECORDED ✓'
                : submitting === proposal.id
                  ? 'SIGNING / SUBMITTING...'
                  : !selected[proposal.id]
                    ? 'SELECT AN OPTION TO VOTE'
                    : 'SIGN & SUBMIT VOTE'}
            </button>

            {voteErrors[proposal.id] && (
              <p role="alert" className="notice">{voteErrors[proposal.id]}</p>
            )}
            {voteSuccess[proposal.id] && (
              <p role="status" className="notice">{voteSuccess[proposal.id]}</p>
            )}
            <p className="notice">
              You can cast your vote at any time during the voting period.
              Your voting power will be based on the $PARLAY tokens held in
              your wallet at the closing snapshot, not when you sign.
              Tokens purchased before closing will count if you still hold
              them at the snapshot. Tokens sold or transferred out before
              closing will not count. Signing is gasless, and each wallet
              may submit only one ballot. Wallet addresses and signatures
              may be published for independent verification. Closing-snapshot
              weighting is calculated after the voting deadline.
            </p>
          </section>
        ))}

      {!proposalError &&
        closedProposals.length > 0 && (
          <section className="proposal">
            <div className="section-top">
              <span>PROPOSAL HISTORY</span>
              <span className="status">CLOSED</span>
            </div>

            <h2>Previous Proposals</h2>

            {closedProposals.map((proposal) => (
              <div
                key={proposal.id}
                style={{ marginTop: 28 }}
              >
                <h3>
                  #{String(proposal.id).padStart(3, '0')}
                  {' — '}
                  {proposal.title}
                </h3>

                {proposal.description && (
                  <p>{proposal.description}</p>
                )}

                <p>
                  Closed:{' '}
                  {new Date(
                    proposal.end_time
                  ).toLocaleString()}
                </p>

                <p>
                  <small>
                    {proposal.results_finalized
                      ? `Closing snapshot block: ${proposal.closing_block ?? proposal.snapshot_block}`
                      : 'Closing snapshot: awaiting verification'}
                  </small>
                </p>

                {renderResults(proposal)}
              </div>
            ))}
          </section>
        )}

      <a
        href="https://discord.gg/embpUdUBE"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="For support, legal terms and FAQ, visit our Discord"
        style={{
          position: 'fixed',
          right: 16,
          bottom: 20,
          zIndex: 100,
          display: 'block',
          maxWidth: 230,
          padding: '12px 16px',
          border: '1px solid #e5c35b',
          borderRadius: 12,
          background: '#155e35',
          color: '#fff7d6',
          fontSize: 12,
          fontWeight: 700,
          lineHeight: 1.45,
          textAlign: 'center',
          textDecoration: 'none',
          boxShadow: '0 5px 20px rgba(0,0,0,0.28)',
        }}
      >
        For support, legal terms and FAQ, please visit our Discord ↗
      </a>

      <footer>
        $PARLAY © 2026 · Community votes are advisory.
        Developers retain final execution authority.
      </footer>
    </main>
  )
}

export default App

