# Migrate from File Storage to Turso

## Context

The Seeker Genesis Holders project indexes Solana blockchain data to track NFT holders. It currently stores ~132MB of data across JSON files organized by epoch. We need a web API to serve holder lookups and paginated lists. Reading from large JSON files won't scale for API use.

The NFT collection is **immutable and non-transferable** — once indexed, the data is final.

## Decision

Replace file-based storage with **Turso** (hosted libSQL/SQLite). Build a **Hono** web API with **Drizzle ORM** on top.

### Why Turso

- Data is modest (~40MB holders), read-heavy, simple queries
- Edge replicas for fast global reads
- Generous free tier (500 databases, 9GB storage, 500M row reads/month)
- SQLite export means anyone can get a verifiable copy of the DB
- `@libsql/client` works well with Bun

## Schema

```sql
CREATE TABLE holders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  holder     TEXT NOT NULL,       -- wallet address
  mint       TEXT NOT NULL UNIQUE, -- NFT mint address (one per NFT)
  ata        TEXT NOT NULL,       -- associated token account
  epoch      INTEGER NOT NULL,
  slot       TEXT NOT NULL,
  block_time INTEGER,
  signature  TEXT NOT NULL UNIQUE
);

CREATE INDEX idx_holders_holder ON holders(holder);
CREATE INDEX idx_holders_epoch ON holders(epoch);

CREATE TABLE epochs (
  epoch        INTEGER PRIMARY KEY,
  holder_count INTEGER NOT NULL DEFAULT 0,
  indexed_at   TEXT NOT NULL       -- ISO timestamp
);
```

### Key constraints

- `mint UNIQUE` — each NFT exists once, non-transferable
- `signature UNIQUE` — natural deduplication
- No signatures/transactions tables — pipeline artifacts stay in memory, only final holders are persisted

## Indexer Design

### Core primitive: `indexEpoch(epoch: number)`

```
indexEpoch(731):
  1. Calculate slot range: [731 * 432000, 732 * 432000 - 1]
  2. Fetch signatures from RPC for payer address within slot range
  3. For each signature, fetch transaction -> extract mint record
  4. In a DB transaction:
     - DELETE FROM holders WHERE epoch = 731
     - INSERT holders rows
     - UPSERT epochs row (epoch=731, holder_count=N, indexed_at=now)
  5. Done.
```

### Properties

- **Idempotent**: Running `indexEpoch(731)` twice produces the same result. Delete-then-insert in a transaction makes re-indexing safe.
- **No cursor needed**: The epoch slot range defines exactly what to fetch.
- **`indexAll()`**: Loop through relevant epochs (731-819+), call `indexEpoch()` for each.
- **Resumable**: If the process crashes, resume from the first epoch missing in the `epochs` table.
- **Verifiable**: Anyone can run `indexEpoch(N)` and compare against what's stored.

### Per-epoch re-indexing

Users (and the cron job) can re-index individual epochs. This is useful for:
- Verifying data integrity without re-indexing everything
- Picking up new mints in the latest (active) epoch
- Allowing untrusting users to spot-check specific epochs

## API Routes (Hono)

### `GET /api/holders/:wallet`

Lookup by wallet address. Returns the NFT(s) held, which mint, and since when.

- Fast: indexed lookup on `holder` column
- Returns `404` if wallet is not a holder

### `GET /api/holders`

Paginated list of all holders, ordered by slot (chronological).

- Query params: `?page=1&limit=20`
- Returns total count (from sum of `epochs.holder_count`)

### `GET /api/epochs`

Lists all indexed epochs with holder counts and indexed timestamps.

- Transparency: anyone can see exactly what's been indexed
- Useful for the re-indexing CLI to know what's missing

## Cron / GitHub Action

The existing `.github/workflows/sync.yaml` stays as an hourly cron. Changes:

**Before**: Check out repo, run indexer, git commit JSON files, push.

**After**: Install Bun, run indexer (writes directly to Turso). No git commit step needed.

Secrets needed: `SOLANA_ENDPOINT` (existing) + `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` (new).

The hourly cron indexes the latest epoch (which may still be active on-chain) and any missing epochs.

## File Cleanup

After migration is verified:
- Remove `data/` directory from the repo
- Remove `src/cache.ts` (file-based storage layer)
- Remove `src/build-holders.ts` (replaced by a SQL query)
- Update `.gitignore`

## Stack Summary

| Component | Technology |
|-----------|-----------|
| Database  | Turso (libSQL) |
| ORM       | Drizzle |
| API       | Hono |
| Runtime   | Bun |
| Indexer   | Existing RPC logic, writes to Turso |
| Cron      | GitHub Actions (hourly) |
