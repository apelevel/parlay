// ApeLevel x PARLAY: automatically finalize every expired proposal via ERC-20 reverse replay.
// Runs outside Cloudflare's public-RPC throttle and resumes persisted D1 checkpoints.
const API_TOKEN = process.env.APELEVEL_PARLAY_CLOUDFLARE_TOKEN;
if (!API_TOKEN) throw new Error('Missing GitHub secret APELEVEL_PARLAY_CLOUDFLARE_TOKEN');
const ACCOUNT = 'c3cc3f89f506b5bf3a5aa260a5045ae0';
const DB = '0be45815-1f95-4cfa-b461-5c19989f0311';
const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB}/query`;
const RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
const TOKEN = '0xc4a481c39437680c54a2fdbe170d48a919ec98b7';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const WINDOW = 500n;
const MAX_WINDOWS_PER_PROPOSAL = 160;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hex = number => `0x${number.toString(16)}`;
const checkHex = value => typeof value === 'string' && /^0x[\da-f]+$/i.test(value);

async function d1(sql, params = []) {
  const res = await fetch(D1_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  const body = await res.json();
  if (!res.ok || !body.success || !body.result?.[0]?.success) {
    throw new Error(`D1 query failed: HTTP ${res.status} ${JSON.stringify(body.errors ?? body)}`);
  }
  return body.result[0];
}
async function rpc(method, params) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(RPC_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (response.status === 429 || response.status === 503) {
      const delay = Math.min(30000, 1500 * 2 ** attempt);
      console.warn(`${method} HTTP ${response.status}; retry after ${delay}ms`);
      await sleep(delay);
      continue;
    }
    if (!response.ok) throw new Error(`${method} HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error(`${method} RPC error: ${JSON.stringify(body.error)}`);
    if (body.result == null) throw new Error(`${method} returned no result`);
    return body.result;
  }
  throw new Error(`${method}: RPC rate limit persisted after retries`);
}
async function blockAt(n) {
  const b = await rpc('eth_getBlockByNumber', [hex(n), false]);
  if (!b || Array.isArray(b) || !checkHex(b.number) || !checkHex(b.timestamp) || BigInt(b.number) !== n) {
    throw new Error(`Invalid block response at ${n}`);
  }
  return b;
}
async function closingBlock(proposal, head) {
  const ms = Date.parse(proposal.end_time);
  if (!Number.isFinite(ms)) throw new Error(`Invalid deadline for proposal ${proposal.id}`);
  const target = BigInt(Math.floor(ms / 1000));
  let low = BigInt(proposal.snapshot_block); // creation block; confirmed earlier than closing
  let high = head;
  if (BigInt((await blockAt(low)).timestamp) > target) throw new Error('Creation block after deadline');
  if (BigInt((await blockAt(high)).timestamp) <= target) throw new Error('Chain has not passed deadline');
  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    const b = await blockAt(mid);
    if (BigInt(b.timestamp) <= target) low = mid;
    else high = mid - 1n;
  }
  return low;
}
async function balanceAt(wallet, block) {
  if (!/^0x[\da-f]{40}$/i.test(wallet)) throw new Error('Invalid wallet address');
  const data = '0x70a08231' + wallet.slice(2).toLowerCase().padStart(64, '0');
  const result = await rpc('eth_call', [{ to: TOKEN, data }, hex(block)]);
  if (!checkHex(result)) throw new Error(`Invalid balanceOf for ${wallet}`);
  return BigInt(result);
}
async function checkpoint(id) {
  const res = await d1('SELECT proposal_id, closing_block, reference_block, next_block, balances_json FROM snapshot_progress WHERE proposal_id = ?', [id]);
  return res.results[0];
}
async function ballotsFor(id) {
  const res = await d1('SELECT id, option_id, wallet_address FROM votes WHERE proposal_id = ? ORDER BY id', [id]);
  if (res.results.length > 100) throw new Error(`Proposal ${id}: over 100 ballots; pagination required`);
  return res.results;
}
async function initialize(proposal, ballots) {
  // Leave 12 blocks of confirmation margin to reduce short reorg risk.
  const height = await rpc('eth_blockNumber', []);
  if (!checkHex(height) || BigInt(height) <= 12n) throw new Error('Invalid chain height');
  const reference = BigInt(height) - 12n;
  const closing = await closingBlock(proposal, reference);
  const uniqueWallets = [...new Set(ballots.map(b => b.wallet_address.toLowerCase()))];
  const balances = {};
  for (const wallet of uniqueWallets) {
    balances[wallet] = (await balanceAt(wallet, reference)).toString();
  }
  await d1(`INSERT OR IGNORE INTO snapshot_progress
    (proposal_id, closing_block, reference_block, next_block, balances_json)
    VALUES (?, ?, ?, ?, ?)`,
    [proposal.id, closing.toString(), reference.toString(), reference.toString(), JSON.stringify(balances)]);
  const state = await checkpoint(proposal.id);
  if (!state) throw new Error(`Unable to initialize snapshot for proposal ${proposal.id}`);
  console.log(`Proposal ${proposal.id}: initialized snapshot closing=${closing} reference=${reference} wallets=${uniqueWallets.length}`);
  return state;
}
async function processWindow(proposal, state) {
  const next = BigInt(state.next_block);
  const closing = BigInt(state.closing_block);
  if (next <= closing) return;
  const from = next - WINDOW + 1n > closing ? next - WINDOW + 1n : closing + 1n;
  const logs = await rpc('eth_getLogs', [{ address: TOKEN, fromBlock: hex(from), toBlock: hex(next), topics: [TRANSFER] }]);
  if (!Array.isArray(logs)) throw new Error('Invalid historical transfer result');
  const current = JSON.parse(state.balances_json);
  const balances = Object.fromEntries(Object.entries(current).map(([wallet, v]) => [wallet.toLowerCase(), BigInt(v)]));
  for (const log of logs) {
    if (log.address?.toLowerCase() !== TOKEN || log.topics?.length !== 3 || log.topics[0]?.toLowerCase() !== TRANSFER || !/^0x[0-9a-f]{64}$/i.test(log.data)) {
      throw new Error('Malformed transfer log; refusing to advance checkpoint');
    }
    const block = BigInt(log.blockNumber);
    if (block < from || block > next) throw new Error('Out-of-range transfer log');
    const source = `0x${log.topics[1].slice(-40).toLowerCase()}`;
    const target = `0x${log.topics[2].slice(-40).toLowerCase()}`;
    const value = BigInt(log.data);
    if (Object.hasOwn(balances, target)) balances[target] -= value;
    if (Object.hasOwn(balances, source)) balances[source] += value;
  }
  const updated = JSON.stringify(Object.fromEntries(Object.entries(balances).map(([wallet, value]) => [wallet, value.toString()])));
  const newNext = from - 1n;
  const change = await d1('UPDATE snapshot_progress SET next_block = ?, balances_json = ? WHERE proposal_id = ? AND next_block = ?',
    [newNext.toString(), updated, proposal.id, state.next_block]);
  if (change.meta?.changes !== 1) console.warn(`Proposal ${proposal.id}: concurrent checkpoint, safely reloading`);
  else console.log(`Proposal ${proposal.id}: processed ${from}-${next} (${logs.length} transfers), next ${newNext}`);
}
async function finalize(proposal, state, ballots) {
  if (BigInt(state.next_block) > BigInt(state.closing_block)) throw new Error('Incomplete snapshot');
  const already = (await d1('SELECT proposal_id FROM proposal_finalizations WHERE proposal_id = ?', [proposal.id])).results;
  if (already.length) {
    console.log(`Proposal ${proposal.id} already finalized`);
    return;
  }
  const balances = JSON.parse(state.balances_json);
  let total = 0n;
  const weights = [];
  for (const ballot of ballots) {
    const value = balances[ballot.wallet_address.toLowerCase()];
    if (value == null) throw new Error(`Missing ${ballot.wallet_address} from snapshot`);
    const weight = BigInt(value);
    if (weight < 0n) throw new Error(`Negative historical balance for ${ballot.wallet_address}`);
    weights.push({ id: ballot.id, weight });
    total += weight;
  }
  // No finalization record until every ballot weight has been updated.
  for (const entry of weights) {
    const result = await d1('UPDATE votes SET voting_power = ? WHERE id = ? AND proposal_id = ?', [entry.weight.toString(), entry.id, proposal.id]);
    if (result.meta?.changes !== 1) throw new Error(`Unable to update ballot ${entry.id}`);
  }
  // Same idempotent publication sequence as the already-tested Proposal #4 recovery.
  await d1('INSERT OR IGNORE INTO proposal_finalizations (proposal_id, closing_block, finalized_at, total_voting_power) VALUES (?, ?, ?, ?)',
    [proposal.id, state.closing_block, new Date().toISOString(), total.toString()]);
  await d1("UPDATE proposals SET status = 'closed', snapshot_block = ? WHERE id = ? AND status = 'open'", [state.closing_block, proposal.id]);
  console.log(`FINALIZED Proposal ${proposal.id}: block ${state.closing_block}, total weight ${total}`);
}
async function processProposal(proposal) {
  const id = proposal.id;
  const ballots = await ballotsFor(id);
  let state = await checkpoint(id);
  if (!state) state = await initialize(proposal, ballots);
  if (BigInt(state.reference_block) <= BigInt(state.closing_block)) throw new Error(`Proposal ${id}: invalid reference`);
  for (let i = 0; i < MAX_WINDOWS_PER_PROPOSAL; i++) {
    state = await checkpoint(id);
    if (!state) throw new Error('Checkpoint disappeared');
    if (BigInt(state.next_block) <= BigInt(state.closing_block)) {
      await finalize(proposal, state, ballots);
      return;
    }
    await processWindow(proposal, state);
    await sleep(950);
  }
  console.log(`Proposal ${id}: checkpoint saved, next scheduled run will resume`);
}
async function main() {
  // Only expired proposals that have no finalization record; does not touch archived or open elections.
  const res = await d1(`SELECT p.id, p.status, p.snapshot_block, p.start_time, p.end_time
    FROM proposals p LEFT JOIN proposal_finalizations f ON f.proposal_id = p.id
    WHERE p.status = 'open' AND f.proposal_id IS NULL
      AND julianday(p.end_time) <= julianday('now')
    ORDER BY p.end_time ASC LIMIT 5`);
  console.log(`Expired proposals needing finalization: ${res.results.map(p => p.id).join(', ') || 'none'}`);
  let failures = 0;
  for (const proposal of res.results) {
    try { await processProposal(proposal); }
    catch (error) { failures++; console.error(`Proposal ${proposal.id} failed:`, error); }
  }
  if (failures) throw new Error(`${failures} proposal(s) could not be processed; next scheduled run will retry`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
