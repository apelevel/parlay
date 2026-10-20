
import { useState } from 'react'
import {
  createPublicClient,
  custom,
  http,
  formatUnits,
  erc20Abi,
} from 'viem'
import { robinhood, PARLAY_TOKEN } from './chain'
import './App.css'

type WalletAddress = `0x${string}`

const options = [
  { id: 'a', name: 'Parlay A', description: 'Community wager option 1' },
  { id: 'b', name: 'Parlay B', description: 'Community wager option 2' },
  { id: 'c', name: 'Parlay C', description: 'Community wager option 3' },
]

const publicClient = createPublicClient({
  chain: robinhood,
  transport: http(),
})

function App() {
  const [selected, setSelected] = useState('a')
  const [wallet, setWallet] = useState<WalletAddress | null>(null)
  const [balance, setBalance] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState('')

  async function connectWallet() {
    setConnecting(true)
    setError('')

    try {
      const ethereum = (
        window as Window & {
          ethereum?: Parameters<typeof custom>[0]
        }
      ).ethereum

      if (!ethereum) {
        throw new Error(
          'No browser wallet detected. Install or enable an EVM wallet extension.'
        )
      }

      const walletClient = createPublicClient({
        chain: robinhood,
        transport: custom(ethereum),
      })

      const accounts = await ethereum.request({
        method: 'eth_requestAccounts',
      }) as WalletAddress[]

      if (!accounts.length) {
        throw new Error('No wallet account selected.')
      }

      const address = accounts[0]

      // Read balance on Robinhood Chain, not Ethereum mainnet.
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

      setWallet(address)
      setBalance(formatUnits(rawBalance, decimals))

      // Keep this client available for the next voting step.
      void walletClient
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Wallet connection failed.'
      )
    } finally {
      setConnecting(false)
    }
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
          onClick={connectWallet}
          disabled={connecting}
        >
          {connecting
            ? 'CONNECTING...'
            : wallet
              ? `${wallet.slice(0, 6)}...${wallet.slice(-4)}`
              : 'CONNECT WALLET'}
        </button>

        {error && <p role="alert">{error}</p>}
      </section>

      <section className="proposal">
        <div className="section-top">
          <span>PROPOSAL #001</span>
          <span className="status">DEMO</span>
        </div>

        <h2>Choose the next community parlay</h2>
        <p>Select your preferred option below.</p>

        <div className="choices">
          {options.map(option => (
            <button
              key={option.id}
              className={`choice ${selected === option.id ? 'active' : ''}`}
              onClick={() => setSelected(option.id)}
            >
              <span className="circle">
                {selected === option.id ? '✓' : ''}
              </span>
              <span>
                <strong>{option.name}</strong>
                <small>{option.description}</small>
              </span>
            </button>
          ))}
        </div>

        <div className="balance">
          <span>YOUR VOTING POWER</span>

          <strong>
            {balance === null
              ? '— PARLAY'
              : `${Number(balance).toLocaleString()} PARLAY`}
          </strong>

          <small>
            {wallet
              ? 'Current token balance on Robinhood Chain.'
              : 'Connect your wallet to verify your token balance.'}
          </small>
        </div>

        <button className="vote" disabled>
          VOTING NOT YET ENABLED
        </button>

        <p className="notice">
          Demo interface only. No votes are currently recorded.
        </p>
      </section>

      <footer>
        $PARLAY © 2026 · Community votes are advisory.
        Developers retain final execution authority.
      </footer>
    </main>
  )
}

export default App
