import type { D1Database, ScheduledEvent, ExecutionContext } from '@cloudflare/workers-types';
import { recoverMessageAddress, isAddress, getAddress } from 'viem';
import { ADMIN_WALLET } from './admin';

type Env = { DB: D1Database; ASSETS: { fetch(request: Request): Promise<Response> } };
type Auth = { nonce: string; expiresAt: number; signature: `0x${string}` };
type CreateBody = Auth & { title: string; description: string; options: string[]; durationHours: number };
type DeleteBody = Auth & { proposalId: number };
type VoteBody = { proposalId: number; optionId: number; walletAddress: string; nonce: string; signature: `0x${string}` };
type Proposal = { id: number; title: string; description: string | null; snapshot_block: string; start_time: string; end_time: string; status: string };
type Ballot = { id: number; option_id: number; wallet_address: string; signature: string; signed_message: string };
type Block = { number: string; timestamp: string };
const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const TOKEN = '0xc4a481c39437680c54a2fdbe170d48a919ec98b7';
const json = (value: unknown, status = 200) => Response.json(value, { status });
const sigOK = (s: unknown): s is `0x${string}` => typeof s === 'string' && /^0x[0-9a-f]{130}$/i.test(s);
const nonceOK = (s: unknown) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const authOK = (a: Auth) => nonceOK(a.nonce) && Number.isSafeInteger(a.expiresAt) && sigOK(a.signature);

// Public RPC requests are bounded and errors include their actual RPC messages.
type RpcResult = string | Block | TransferLog[];
type TransferLog = { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string };
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const WINDOW_BLOCKS = 500n;
const WINDOWS_PER_RUN = 1; // Public RPC: one transfer-log window per cron run to avoid bursts.
const hex = (v: bigint) => `0x${v.toString(16)}`;
const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function rpc(method: string, params: unknown[]): Promise<RpcResult> {
  let lastError = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(RPC, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
      });
      // HTTP 429 is an explicit rate limit; do not immediately retry and amplify it.
      if (response.status === 429) throw new Error('HTTP 429 (public RPC rate limit)');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as { result?: RpcResult | null; error?: { code?: number; message?: string } };
      if (payload.error) throw new Error(`RPC ${payload.error.code}: ${payload.error.message || 'unknown error'}`);
      if (payload.result == null) throw new Error('Empty RPC result');
      return payload.result;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      // Rate limits are handled by the next minute's scheduled invocation.
      if (lastError.includes('HTTP 429')) break;
      if (attempt < 2) await pause(300 * (attempt + 1));
    }
  }
  throw new Error(`${method} failed: ${lastError}`);
}

async function blockAt(number: bigint): Promise<Block> {
  const result = await rpc('eth_getBlockByNumber', [hex(number), false]);
  if (typeof result !== 'object' || Array.isArray(result) || !/^0x[0-9a-f]+$/i.test(result.timestamp) || !/^0x[0-9a-f]+$/i.test(result.number)) {
    throw new Error(`Invalid block at ${number}`);
  }
  return result;
}

// Bound the search to the proposal's creation block rather than block zero.
async function closingBlock(p: Proposal, headNumber: bigint): Promise<bigint> {
  const deadlineMs = Date.parse(p.end_time);
  if (!Number.isFinite(deadlineMs)) throw new Error('Invalid deadline');
  const deadlineSeconds = BigInt(Math.floor(deadlineMs / 1000));
  let low = BigInt(p.snapshot_block);
  let high = headNumber;
  const first = await blockAt(low);
  if (BigInt(first.timestamp) > deadlineSeconds) throw new Error('Creation block is later than deadline');
  const latest = await blockAt(high);
  if (BigInt(latest.timestamp) <= deadlineSeconds) throw new Error('Chain has not passed proposal deadline');
  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    const block = await blockAt(mid);
    if (BigInt(block.timestamp) <= deadlineSeconds) low = mid;
    else high = mid - 1n;
  }
  return low;
}

async function balanceAt(wallet: string, block: bigint): Promise<bigint> {
  const data = '0x70a08231' + wallet.toLowerCase().slice(2).padStart(64, '0');
  const result = await rpc('eth_call', [{ to: TOKEN, data }, hex(block)]);
  if (typeof result !== 'string' || !/^0x[0-9a-f]+$/i.test(result)) throw new Error('Invalid token balance response');
  return BigInt(result);
}

type SnapshotProgress = {
  proposal_id: number;
  closing_block: string;
  reference_block: string;
  next_block: string;
  balances_json: string;
};

async function initializeProgress(env: Env, p: Proposal, ballots: Ballot[]): Promise<SnapshotProgress> {
  const head = await rpc('eth_blockNumber', []);
  if (typeof head !== 'string') throw new Error('Invalid head block');
  const reference = BigInt(head);
  const closing = await closingBlock(p, reference);
  // Pin every balanceOf call to exactly the same block as the log replay endpoint.
  // This intentionally fails rather than silently combining inconsistent states.
  const balances: Record<string, string> = {};
  const wallets = Array.from(new Set(ballots.map(b => b.wallet_address.toLowerCase())));
  for (const wallet of wallets) {
    balances[wallet] = (await balanceAt(wallet, reference)).toString();
  }
  await env.DB.prepare(`INSERT OR IGNORE INTO snapshot_progress
    (proposal_id, closing_block, reference_block, next_block, balances_json)
    VALUES (?, ?, ?, ?, ?)`)
    .bind(p.id, closing.toString(), reference.toString(), reference.toString(), JSON.stringify(balances)).run();
  const result = await env.DB.prepare('SELECT * FROM snapshot_progress WHERE proposal_id = ?').bind(p.id).first<SnapshotProgress>();
  if (!result) throw new Error('Unable to initialize snapshot checkpoint');
  console.log(`Snapshot initialized for proposal ${p.id}: closing ${closing}, reference ${reference}, wallets ${wallets.length}`);
  return result;
}

async function processWindow(env: Env, p: Proposal, state: SnapshotProgress): Promise<boolean> {
  const closing = BigInt(state.closing_block);
  const next = BigInt(state.next_block);
  if (next <= closing) return true;
  const from = next - WINDOW_BLOCKS + 1n > closing ? next - WINDOW_BLOCKS + 1n : closing + 1n;
  const result = await rpc('eth_getLogs', [{ address: TOKEN, fromBlock: hex(from), toBlock: hex(next), topics: [TRANSFER_TOPIC] }]);
  if (!Array.isArray(result)) throw new Error('Invalid Transfer log response');
  const balances = JSON.parse(state.balances_json) as Record<string, string>;
  const amounts: Record<string, bigint> = {};
  for (const [wallet, value] of Object.entries(balances)) amounts[wallet] = BigInt(value);
  for (const log of result) {
    if (log.address.toLowerCase() !== TOKEN || log.topics.length !== 3 || log.topics[0].toLowerCase() !== TRANSFER_TOPIC || !/^0x[0-9a-f]{64}$/i.test(log.data)) {
      throw new Error('Malformed PARLAY transfer log; refusing to finalize');
    }
    const fromWallet = '0x' + log.topics[1].slice(-40).toLowerCase();
    const toWallet = '0x' + log.topics[2].slice(-40).toLowerCase();
    const value = BigInt(log.data);
    // Moving backward: incoming tokens are removed and outgoing tokens restored.
    if (Object.prototype.hasOwnProperty.call(amounts, toWallet)) amounts[toWallet] -= value;
    if (Object.prototype.hasOwnProperty.call(amounts, fromWallet)) amounts[fromWallet] += value;
  }
  const updated = Object.fromEntries(Object.entries(amounts).map(([w, v]) => [w, v.toString()]));
  const newNext = from - 1n;
  // Checkpoint is committed only AFTER all returned logs have been accounted for.
  const write = await env.DB.prepare(`UPDATE snapshot_progress SET next_block = ?, balances_json = ?
    WHERE proposal_id = ? AND next_block = ?`)
    .bind(newNext.toString(), JSON.stringify(updated), p.id, state.next_block).run();
  if (write.meta.changes !== 1) throw new Error('Concurrent snapshot update; will retry');
  console.log(`Proposal ${p.id}: processed Transfer logs ${from}-${next}; next ${newNext}`);
  return newNext <= closing;
}

async function completeFinalization(env: Env, p: Proposal, state: SnapshotProgress, ballots: Ballot[]): Promise<void> {
  if (BigInt(state.next_block) > BigInt(state.closing_block)) return;
  const balances = JSON.parse(state.balances_json) as Record<string, string>;
  const weighted: { id: number; weight: bigint }[] = [];
  let total = 0n;
  for (const ballot of ballots) {
    const value = balances[ballot.wallet_address.toLowerCase()];
    if (value === undefined) throw new Error(`Missing wallet ${ballot.wallet_address} in snapshot`);
    const weight = BigInt(value);
    if (weight < 0n) throw new Error(`Negative reconstructed balance for ${ballot.wallet_address}; token may not support transfer-based accounting`);
    weighted.push({ id: ballot.id, weight });
    total += weight;
  }
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO proposal_finalizations (proposal_id, closing_block, finalized_at, total_voting_power) VALUES (?, ?, ?, ?)')
      .bind(p.id, state.closing_block, new Date().toISOString(), total.toString()),
    ...weighted.map(w => env.DB.prepare('UPDATE votes SET voting_power = ? WHERE id = ? AND proposal_id = ?')
      .bind(w.weight.toString(), w.id, p.id)),
    env.DB.prepare("UPDATE proposals SET status = 'closed', snapshot_block = ? WHERE id = ? AND status = 'open'")
      .bind(state.closing_block, p.id)
  ]);
  console.log(`Finalized proposal ${p.id}: block ${state.closing_block}, weight ${total}`);
}

async function finalizeOne(env: Env, p: Proposal): Promise<void> {
  const existing = await env.DB.prepare('SELECT proposal_id FROM proposal_finalizations WHERE proposal_id = ?').bind(p.id).first();
  if (existing) return;
  const { results: ballots } = await env.DB.prepare('SELECT id, option_id, wallet_address, signature, signed_message FROM votes WHERE proposal_id = ? ORDER BY id')
    .bind(p.id).all<Ballot>();
  if (ballots.length > 100) throw new Error(`Proposal ${p.id}: more than 100 ballots; needs expanded batch support`);
  let state = await env.DB.prepare('SELECT * FROM snapshot_progress WHERE proposal_id = ?').bind(p.id).first<SnapshotProgress>();
  if (!state) state = await initializeProgress(env, p, ballots);
  for (let i = 0; i < WINDOWS_PER_RUN; i++) {
    if (BigInt(state.next_block) <= BigInt(state.closing_block)) break;
    await processWindow(env, p, state);
    const refreshed = await env.DB.prepare('SELECT * FROM snapshot_progress WHERE proposal_id = ?').bind(p.id).first<SnapshotProgress>();
    if (!refreshed) throw new Error('Snapshot progress disappeared');
    state = refreshed;
  }
  if (BigInt(state.next_block) <= BigInt(state.closing_block)) await completeFinalization(env, p, state, ballots);
}

async function finalizeDue(env: Env): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id, title, description, snapshot_block, start_time, end_time, status FROM proposals WHERE status = 'open' AND julianday(end_time) <= julianday('now') ORDER BY end_time ASC LIMIT 3").all<Proposal>();
  for (const p of results) {
    try { await finalizeOne(env, p); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Finalization failed for proposal ${p.id}; will retry: ${message}`);
    }
  }
}
async function adminAuthorized(message: string, signature: `0x${string}`) {
  const signer = await recoverMessageAddress({ message, signature });
  return signer.toLowerCase() === ADMIN_WALLET.toLowerCase();
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(finalizeDue(env));
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/proposals' && request.method === 'GET') {
      try {
        const { results: proposals } = await env.DB.prepare("SELECT id, title, description, snapshot_block, start_time, end_time, status FROM proposals WHERE status IN ('open', 'closed') ORDER BY id DESC LIMIT 50").all<Proposal>();
        if (!proposals.length) return json({ success: true, proposals: [] });
        const ids = proposals.map(p => p.id);
        const placeholders = ids.map(() => '?').join(',');
        const { results: options } = await env.DB.prepare(`SELECT id, proposal_id, title, description FROM proposal_options WHERE proposal_id IN (${placeholders}) ORDER BY id`).bind(...ids).all<{ id: number; proposal_id: number; title: string; description: string | null }>();
        const { results: finalizations } = await env.DB.prepare(`SELECT proposal_id, closing_block, total_voting_power FROM proposal_finalizations WHERE proposal_id IN (${placeholders})`).bind(...ids).all<{ proposal_id: number; closing_block: string; total_voting_power: string }>();
        const { results: voteRows } = await env.DB.prepare(`SELECT proposal_id, option_id, voting_power FROM votes WHERE proposal_id IN (${placeholders})`).bind(...ids).all<{ proposal_id: number; option_id: number; voting_power: string }>();
        return json({ success: true, proposals: proposals.map(p => {
          const final = finalizations.find(f => f.proposal_id === p.id);
          const ownOptions = options.filter(o => o.proposal_id === p.id);
          const total = final ? BigInt(final.total_voting_power) : 0n;
          return {
            ...p,
            options: ownOptions,
            results_finalized: !!final,
            proof_url: final ? `/api/proposals/${p.id}/proof` : null,
            results: final ? ownOptions.map(o => {
              const weight = voteRows.filter(v => v.proposal_id === p.id && v.option_id === o.id).reduce((sum, v) => sum + BigInt(v.voting_power), 0n);
              // Percentage is display-only; all raw integer values remain exact.
              return { option_id: o.id, voting_power: weight.toString(), percentage: total === 0n ? 0 : Number(weight * 10000n / total) / 100 };
            }) : undefined
          };
        }) });
      } catch (error) { console.error('Proposal listing:', error); return json({ success: false, error: 'Database error' }, 500); }
    }
    if (url.pathname === '/api/votes/status' && request.method === 'GET') {
      const wallet = url.searchParams.get('wallet');
      if (!wallet || !isAddress(wallet)) {
        return json({ success: false, error: 'Invalid wallet address' }, 400);
      }
      try {
        const { results } = await env.DB.prepare(
          'SELECT proposal_id FROM votes WHERE wallet_address = ?'
        ).bind(wallet.toLowerCase()).all<{ proposal_id: number }>();
        return json({
          success: true,
          votedProposalIds: results.map(row => row.proposal_id)
        });
      } catch (error) {
        console.error('Ballot status:', error);
        return json({ success: false, error: 'Unable to check ballot status' }, 500);
      }
    }
    const proofMatch = url.pathname.match(/^\/api\/proposals\/([1-9]\d*)\/proof$/);
    if (proofMatch && request.method === 'GET') {
      const id = Number(proofMatch[1]);
      const final = await env.DB.prepare('SELECT proposal_id, closing_block, finalized_at, total_voting_power FROM proposal_finalizations WHERE proposal_id = ?').bind(id).first();
      if (!final) return json({ success: false, error: 'Results not finalized' }, 404);
      const { results: ballots } = await env.DB.prepare('SELECT option_id, wallet_address, voting_power, signature, signed_message FROM votes WHERE proposal_id = ? ORDER BY id').bind(id).all();
      return json({ proposal_id: id, token: TOKEN, chain_id: 4663, token_decimals: 18, finalization: final, ballots, note: 'Public signatures and wallet addresses are provided for independent verification.' });
    }
    if (url.pathname === '/api/votes' && request.method === 'POST') {
      try {
        let body: VoteBody;
        try { body = await request.json() as VoteBody; } catch { return json({ success: false, error: 'Invalid request body' }, 400); }
        if (!body || !Number.isSafeInteger(body.proposalId) || body.proposalId <= 0 || !Number.isSafeInteger(body.optionId) || body.optionId <= 0 || !isAddress(body.walletAddress) || !nonceOK(body.nonce) || !sigOK(body.signature)) return json({ success: false, error: 'Invalid ballot' }, 400);
        const walletAddress = getAddress(body.walletAddress);
        const signedMessage = JSON.stringify({ action: 'CAST_PARLAY_VOTE', origin: url.origin, chainId: 4663, token: TOKEN, proposalId: body.proposalId, optionId: body.optionId, walletAddress, nonce: body.nonce });
        const signer = await recoverMessageAddress({ message: signedMessage, signature: body.signature });
        if (signer.toLowerCase() !== walletAddress.toLowerCase()) return json({ success: false, error: 'Wallet signature does not match' }, 403);
        const proposal = await env.DB.prepare('SELECT id, status, start_time, end_time FROM proposals WHERE id = ?').bind(body.proposalId).first<{ id: number; status: string; start_time: string; end_time: string }>();
        if (!proposal) return json({ success: false, error: 'Proposal not found' }, 404);
        const now = Date.now();
        if (proposal.status !== 'open' || now < Date.parse(proposal.start_time) || now >= Date.parse(proposal.end_time)) return json({ success: false, error: 'Voting is not open' }, 409);
        const option = await env.DB.prepare('SELECT id FROM proposal_options WHERE id = ? AND proposal_id = ?').bind(body.optionId, body.proposalId).first();
        if (!option) return json({ success: false, error: 'Invalid voting option' }, 400);
        const insert = await env.DB.prepare(`INSERT OR IGNORE INTO votes (proposal_id, option_id, wallet_address, voting_power, signature, signed_message) SELECT ?, ?, ?, '0', ?, ? WHERE EXISTS (SELECT 1 FROM proposals WHERE id = ? AND status = 'open' AND julianday(start_time) <= julianday('now') AND julianday(end_time) > julianday('now'))`).bind(body.proposalId, body.optionId, walletAddress.toLowerCase(), body.signature, signedMessage, body.proposalId).run();
        if (insert.meta.changes !== 1) return json({ success: false, error: 'Ballot not accepted. You may have already voted, or voting has closed.' }, 409);
        return json({ success: true, proposalId: body.proposalId, optionId: body.optionId, walletAddress, message: 'Ballot recorded. Voting power will be determined at the closing snapshot.' }, 201);
      } catch (error) { console.error('Vote submission:', error); return json({ success: false, error: 'Unable to record ballot' }, 500); }
    }
    const deleteMatch = url.pathname.match(/^\/api\/proposals\/([1-9]\d*)$/);
    if (deleteMatch && request.method === 'DELETE') {
      try {
        const proposalId = Number(deleteMatch[1]);
        let body: DeleteBody;
        try { body = await request.json() as DeleteBody; } catch { return json({ success: false, error: 'Invalid request body' }, 400); }
        if (!Number.isSafeInteger(proposalId) || !body || body.proposalId !== proposalId || !authOK(body)) return json({ success: false, error: 'Invalid deletion request' }, 400);
        const now = Date.now();
        if (body.expiresAt <= now || body.expiresAt > now + 300000) return json({ success: false, error: 'Authorization expired' }, 401);
        const message = JSON.stringify({ action: 'DELETE_PARLAY_PROPOSAL', origin: url.origin, proposalId, nonce: body.nonce, expiresAt: body.expiresAt });
        if (!await adminAuthorized(message, body.signature)) return json({ success: false, error: 'Not authorized' }, 403);
        const proposal = await env.DB.prepare('SELECT status FROM proposals WHERE id = ?').bind(proposalId).first<{ status: string }>();
        if (!proposal) return json({ success: false, error: 'Proposal not found' }, 404);
        if (!['open', 'closed'].includes(proposal.status)) return json({ success: false, error: 'Proposal cannot be archived' }, 409);
        await env.DB.batch([
          env.DB.prepare('INSERT INTO admin_nonces (nonce, expires_at) VALUES (?, ?)').bind(body.nonce, body.expiresAt),
          env.DB.prepare("UPDATE proposals SET status = 'archived' WHERE id = ? AND status IN ('open', 'closed')").bind(proposalId)
        ]);
        return json({ success: true, proposalId, message: 'Proposal archived successfully' });
      } catch (error) { console.error('Proposal deletion:', error); return json({ success: false, error: 'Unable to archive proposal' }, 500); }
    }
    if (url.pathname === '/api/proposals' && request.method === 'POST') {
      try {
        const body = await request.json() as CreateBody;
        if (!body || typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200 || typeof body.description !== 'string' || body.description.length > 2000 || !Array.isArray(body.options) || body.options.length < 2 || body.options.length > 10 || !body.options.every(o => typeof o === 'string' && !!o.trim() && o.length <= 200) || ![1 / 12, 24, 48, 72].includes(body.durationHours) || !authOK(body)) return json({ success: false, error: 'Invalid proposal data' }, 400);
        const now = Date.now();
        if (body.expiresAt <= now || body.expiresAt > now + 300000) return json({ success: false, error: 'Authorization expired' }, 401);
        const message = JSON.stringify({ action: 'CREATE_PARLAY_PROPOSAL', origin: url.origin, title: body.title, description: body.description, options: body.options, durationHours: body.durationHours, nonce: body.nonce, expiresAt: body.expiresAt });
        if (!await adminAuthorized(message, body.signature)) return json({ success: false, error: 'Not authorized' }, 403);
        const head = await rpc('eth_blockNumber', []);
        if (typeof head !== 'string') throw new Error('Invalid head block');
        const startTime = new Date(now).toISOString();
        const endTime = new Date(now + body.durationHours * 3600000).toISOString();
        // The proposal and nonce are atomic; option inserts follow separately.
        // A future hardening pass should make all three atomic.
        const creation = await env.DB.batch([
          env.DB.prepare('INSERT INTO admin_nonces (nonce, expires_at) VALUES (?, ?)').bind(body.nonce, body.expiresAt),
          env.DB.prepare("INSERT INTO proposals (title, description, snapshot_block, start_time, end_time, status) VALUES (?, ?, ?, ?, ?, 'open')").bind(body.title.trim(), body.description.trim(), BigInt(head).toString(), startTime, endTime)
        ]);
        const proposalId = Number(creation[1].meta.last_row_id);
        if (!Number.isSafeInteger(proposalId) || proposalId <= 0) throw new Error('Proposal ID unavailable');
        await env.DB.batch(body.options.map(o => env.DB.prepare('INSERT INTO proposal_options (proposal_id, title) VALUES (?, ?)').bind(proposalId, o.trim())));
        return json({ success: true, proposalId }, 201);
      } catch (error) { console.error('Proposal creation:', error); return json({ success: false, error: 'Unable to create proposal' }, 500); }
    }
    if (url.pathname.startsWith('/api/')) return json({ success: false, error: 'API endpoint not found' }, 404);
    return env.ASSETS.fetch(request);
  }
};
