// ApeLevel x PARLAY: replay ERC-20 transfer logs backwards from an anchored reference balance.
// Uses existing snapshot_progress checkpoints and publishes only after complete replay.
const API_TOKEN = process.env.APELEVEL_PARLAY_CLOUDFLARE_TOKEN;
if (!API_TOKEN) throw new Error('GitHub secret APELEVEL_PARLAY_CLOUDFLARE_TOKEN is missing');
const ACCOUNT = 'c3cc3f89f506b5bf3a5aa260a5045ae0';
const DB = '0be45815-1f95-4cfa-b461-5c19989f0311';
const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB}/query`;
const RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
const TOKEN = '0xc4a481c39437680c54a2fdbe170d48a919ec98b7';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const PROPOSAL = 4;
const WINDOW = 500n;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hex = number => `0x${number.toString(16)}`;

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
      console.warn(`${method} HTTP ${response.status}; retrying after ${delay}ms`);
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

async function checkpoint() {
  const response = await d1('SELECT proposal_id, closing_block, reference_block, next_block, balances_json FROM snapshot_progress WHERE proposal_id = ?', [PROPOSAL]);
  return response.results[0];
}

async function verifyProposal() {
  const proposals = (await d1('SELECT id, status, end_time FROM proposals WHERE id = ?', [PROPOSAL])).results;
  if (!proposals.length) throw new Error('Proposal #4 not found');
  if (Date.parse(proposals[0].end_time) > Date.now()) throw new Error('Proposal #4 has not ended');
  return proposals[0];
}

async function processWindow(state) {
  const next = BigInt(state.next_block);
  const closing = BigInt(state.closing_block);
  if (next <= closing) return false;
  const from = next - WINDOW + 1n > closing ? next - WINDOW + 1n : closing + 1n;
  const logs = await rpc('eth_getLogs', [{
    address: TOKEN, fromBlock: hex(from), toBlock: hex(next), topics: [TRANSFER],
  }]);
  if (!Array.isArray(logs)) throw new Error('Historical Transfer logs response was not an array');
  const original = JSON.parse(state.balances_json);
  const balances = Object.fromEntries(Object.entries(original).map(([wallet, v]) => [wallet.toLowerCase(), BigInt(v)]));
  for (const log of logs) {
    if (log.address?.toLowerCase() !== TOKEN || log.topics?.length !== 3 || log.topics[0]?.toLowerCase() !== TRANSFER || !/^0x[0-9a-f]{64}$/i.test(log.data)) {
      throw new Error('Malformed Transfer event: refusing to advance snapshot');
    }
    const blockNumber = BigInt(log.blockNumber);
    if (blockNumber < from || blockNumber > next) throw new Error('Transfer event outside requested range');
    const fromWallet = `0x${log.topics[1].slice(-40).toLowerCase()}`;
    const toWallet = `0x${log.topics[2].slice(-40).toLowerCase()}`;
    const value = BigInt(log.data);
    if (Object.hasOwn(balances, toWallet)) balances[toWallet] -= value;
    if (Object.hasOwn(balances, fromWallet)) balances[fromWallet] += value;
  }
  const nextBlock = from - 1n;
  const newJson = JSON.stringify(Object.fromEntries(Object.entries(balances).map(([key, val]) => [key, val.toString()])));
  const change = await d1('UPDATE snapshot_progress SET next_block = ?, balances_json = ? WHERE proposal_id = ? AND next_block = ?',
    [nextBlock.toString(), newJson, PROPOSAL, state.next_block]);
  if (change.meta?.changes !== 1) {
    console.warn('Another processor advanced the checkpoint; reloading it safely');
    return true;
  }
  console.log(`Proposal #4: processed blocks ${from}-${next} (${logs.length} transfer events); next=${nextBlock}`);
  return true;
}

async function finalize(state) {
  if (BigInt(state.next_block) > BigInt(state.closing_block)) throw new Error('Refusing to finalize incomplete snapshot');
  const existing = (await d1('SELECT proposal_id FROM proposal_finalizations WHERE proposal_id = ?', [PROPOSAL])).results;
  if (existing.length) { console.log('Proposal #4 already finalized'); return; }
  const ballots = (await d1('SELECT id, option_id, wallet_address FROM votes WHERE proposal_id = ? ORDER BY id', [PROPOSAL])).results;
  if (ballots.length > 100) throw new Error('Over 100 ballots; stop for pagination support');
  const balances = JSON.parse(state.balances_json);
  let total = 0n;
  const weights = [];
  for (const ballot of ballots) {
    const value = balances[ballot.wallet_address.toLowerCase()];
    if (value == null) throw new Error(`Missing snapshot balance for ${ballot.wallet_address}`);
    const weight = BigInt(value);
    if (weight < 0n) throw new Error(`Negative reconstructed balance for ${ballot.wallet_address}`);
    weights.push({ id: ballot.id, weight });
    total += weight;
  }
  // Mark every ballot first. Results become public only AFTER successful weight updates.
  for (const entry of weights) {
    const res = await d1('UPDATE votes SET voting_power = ? WHERE id = ? AND proposal_id = ?', [entry.weight.toString(), entry.id, PROPOSAL]);
    if (res.meta?.changes !== 1) throw new Error(`Failed updating ballot ${entry.id}`);
  }
  // Both operations are idempotent. If interrupted, re-running completes them.
  await d1('INSERT OR IGNORE INTO proposal_finalizations (proposal_id, closing_block, finalized_at, total_voting_power) VALUES (?, ?, ?, ?)',
    [PROPOSAL, state.closing_block, new Date().toISOString(), total.toString()]);
  await d1("UPDATE proposals SET status = 'closed', snapshot_block = ? WHERE id = ? AND status = 'open'", [state.closing_block, PROPOSAL]);
  console.log(`FINALIZED Proposal #4: closing block ${state.closing_block}, voting power ${total}`);
}

async function main() {
  await verifyProposal();
  for (let i = 0; i < 200; i++) {
    const state = await checkpoint();
    if (!state) throw new Error('Missing snapshot_progress checkpoint for Proposal #4');
    if (BigInt(state.reference_block) <= BigInt(state.closing_block)) throw new Error('Invalid reference block');
    if (BigInt(state.next_block) <= BigInt(state.closing_block)) {
      await finalize(state);
      return;
    }
    await processWindow(state);
    await sleep(950); // no request bursts
  }
  throw new Error('Stopped after 200 windows; rerun workflow to continue');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
