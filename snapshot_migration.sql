-- Run once against the existing production D1 database. Does not modify existing ballots.
CREATE TABLE IF NOT EXISTS snapshot_progress (
  proposal_id INTEGER PRIMARY KEY,
  closing_block TEXT NOT NULL,
  reference_block TEXT NOT NULL,
  next_block TEXT NOT NULL,
  balances_json TEXT NOT NULL
);
