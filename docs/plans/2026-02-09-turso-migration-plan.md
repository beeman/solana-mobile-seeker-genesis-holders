# Turso Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace file-based JSON storage with Turso (libSQL) via Drizzle ORM, rework the indexer to use per-epoch indexing, and build a Hono web API for holder lookups and paginated lists.

**Architecture:** The indexer writes directly to Turso instead of JSON files. A Hono API serves read-only queries. The core primitive is `indexEpoch(epoch)` which is idempotent and composable into `indexAll()`. GitHub Actions cron calls the indexer on a schedule.

**Tech Stack:** Bun, TypeScript, Turso (libSQL), Drizzle ORM, Hono, @solana/kit

**Design doc:** `docs/plans/2026-02-09-turso-migration-design.md`

---

### Task 1: Install Dependencies

**Files:**
- Modify: `package.json`

**Step 1: Install production dependencies**

```bash
bun add drizzle-orm @libsql/client hono
```

**Step 2: Install dev dependencies**

```bash
bun add -D drizzle-kit
```

**Step 3: Verify installation**

Run: `bun run check-types`
Expected: No new type errors (just installs, no code changes yet)

**Step 4: Commit**

```bash
git add package.json bun.lock
git commit -m "chore: add drizzle, libsql, and hono dependencies"
```

---

### Task 2: Drizzle Schema & Database Connection

**Files:**
- Create: `src/db/schema.ts`
- Create: `src/db/index.ts`
- Create: `drizzle.config.ts`
- Modify: `.env` (add Turso vars — do not commit)

**Step 1: Create the Drizzle schema**

Create `src/db/schema.ts`:

```typescript
import { index, int, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const holders = sqliteTable(
  'holders',
  {
    ata: text().notNull(),
    blockTime: int('block_time'),
    epoch: int().notNull(),
    holder: text().notNull(),
    id: int().primaryKey({ autoIncrement: true }),
    mint: text().notNull().unique(),
    signature: text().notNull().unique(),
    slot: text().notNull(),
  },
  (table) => [index('idx_holders_holder').on(table.holder), index('idx_holders_epoch').on(table.epoch)],
)

export const epochs = sqliteTable('epochs', {
  epoch: int().primaryKey(),
  holderCount: int('holder_count').notNull().default(0),
  indexedAt: text('indexed_at').notNull(),
})
```

**Step 2: Create the database connection module**

Create `src/db/index.ts`:

```typescript
import { drizzle } from 'drizzle-orm/libsql'
import * as schema from './schema.ts'

function getEnv(name: string): string {
  const value = Bun.env[name]
  if (!value) {
    throw new Error(`${name} env var not set.`)
  }
  return value
}

export function createDb() {
  return drizzle({
    connection: {
      authToken: getEnv('TURSO_AUTH_TOKEN'),
      url: getEnv('TURSO_DATABASE_URL'),
    },
    schema,
  })
}

export type Db = ReturnType<typeof createDb>
```

**Step 3: Create `drizzle.config.ts`**

```typescript
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dbCredentials: {
    authToken: process.env.TURSO_AUTH_TOKEN!,
    url: process.env.TURSO_DATABASE_URL!,
  },
  dialect: 'turso',
  out: './drizzle',
  schema: './src/db/schema.ts',
})
```

**Step 4: Add Turso env vars to `.env`**

Append to `.env`:

```
TURSO_DATABASE_URL=<your_turso_url>
TURSO_AUTH_TOKEN=<your_turso_token>
```

> **Note:** The user must create a Turso database first via `turso db create seeker-genesis-holders` and get credentials via `turso db tokens create seeker-genesis-holders`. Install the Turso CLI with `brew install tursodatabase/tap/turso` if needed.

**Step 5: Run type check**

Run: `bun run check-types`
Expected: PASS

**Step 6: Generate and run the initial migration**

```bash
bunx drizzle-kit generate
bunx drizzle-kit migrate
```

Expected: Creates `drizzle/` directory with SQL migration files. Tables are created in Turso.

**Step 7: Commit**

```bash
git add src/db/schema.ts src/db/index.ts drizzle.config.ts drizzle/
git commit -m "feat: add drizzle schema and turso database connection"
```

---

### Task 3: Rework Indexer — `indexEpoch()`

This is the core change. Replace the 3-phase pipeline (sync signatures → process transactions → build holders) with a single `indexEpoch()` function that does everything for one epoch and writes directly to the database.

**Files:**
- Create: `src/indexer-db.ts`
- Keep: `src/solana-client.ts` (unchanged)
- Keep: `src/types.ts` (reuse `MintRecord`, `SignatureRecord`)

**Step 1: Create `src/indexer-db.ts`**

```typescript
import { type Address, address, signature as solSignature } from '@solana/kit'
import { eq, sql } from 'drizzle-orm'
import type { Db } from './db/index.ts'
import { epochs, holders } from './db/schema.ts'
import { createSolanaClient } from './solana-client.ts'
import type { MintRecord, SignatureRecord } from './types.ts'

const PAYER = address('GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4')
const GROUP = 'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te'
const SLOTS_PER_EPOCH = 432_000
const PAGE_DELAY_MS = 200
const TX_DELAY_MS = 50
const MAX_RETRIES = 3
const RETRY_DELAY_MS = 1000

type SolanaClient = ReturnType<typeof createSolanaClient>

function toSignatureRecord(tx: {
  blockTime: bigint | null
  err: unknown
  memo: string | null
  signature: string
  slot: bigint
}): SignatureRecord {
  return {
    blockTime: tx.blockTime != null ? Number(tx.blockTime) : null,
    err: tx.err,
    memo: tx.memo,
    signature: tx.signature as string,
    slot: tx.slot.toString(),
  }
}

function extractMintRecord(
  tx: { blockTime: bigint | null; meta: unknown; transaction: unknown },
  sig: string,
  slot: string,
  blockTime: number | null,
): MintRecord | null {
  const meta = tx.meta as {
    err: unknown
    postTokenBalances?: Array<{
      accountIndex: number
      mint: string
      owner: string
      uiTokenAmount: { amount: string; decimals: number }
    }>
  }

  if (meta.err !== null) return null

  const transaction = tx.transaction as {
    message: { accountKeys: Array<{ pubkey: string }> }
  }

  const accountKeys = transaction.message.accountKeys
  const hasGroup = accountKeys.some((k) => k.pubkey === GROUP)
  if (!hasGroup) return null

  const balances = meta.postTokenBalances ?? []
  const nftBalance = balances.find((b) => b.uiTokenAmount.amount === '1' && b.uiTokenAmount.decimals === 0)
  if (!nftBalance) return null

  const ataKey = accountKeys[nftBalance.accountIndex]
  if (!ataKey) return null

  return {
    ata: ataKey.pubkey,
    blockTime,
    mint: nftBalance.mint,
    recipient: nftBalance.owner,
    signature: sig,
    slot,
  }
}

async function fetchSignaturesForEpoch(client: SolanaClient, epoch: number): Promise<SignatureRecord[]> {
  const startSlot = epoch * SLOTS_PER_EPOCH
  const endSlot = (epoch + 1) * SLOTS_PER_EPOCH - 1

  console.log(`[index] Epoch ${epoch}: fetching signatures (slots ${startSlot}-${endSlot})`)

  const allSignatures: SignatureRecord[] = []
  let before: string | undefined

  while (true) {
    const config: Record<string, unknown> = {}
    if (before) {
      config.before = solSignature(before)
    }

    const results = await client.rpc.getSignaturesForAddress(PAYER, config).send()
    if (results.length === 0) break

    const records = results.map(toSignatureRecord)

    // Filter to only signatures within this epoch's slot range
    const inRange = records.filter((r) => {
      const slot = Number(r.slot)
      return slot >= startSlot && slot <= endSlot
    })

    // If we've gone past this epoch's range (older slots), stop
    const lastRecord = records.at(-1)
    if (lastRecord && Number(lastRecord.slot) < startSlot) {
      allSignatures.push(...inRange)
      break
    }

    allSignatures.push(...inRange)

    if (lastRecord) {
      before = lastRecord.signature
    }

    console.log(`[index] Epoch ${epoch}: fetched page of ${results.length} (${allSignatures.length} in range)`)
    await Bun.sleep(PAGE_DELAY_MS)
  }

  console.log(`[index] Epoch ${epoch}: found ${allSignatures.length} signatures`)
  return allSignatures
}

async function fetchMintRecords(client: SolanaClient, signatures: SignatureRecord[], epoch: number): Promise<MintRecord[]> {
  const mints: MintRecord[] = []
  const validSigs = signatures.filter((s) => s.err === null)

  console.log(`[index] Epoch ${epoch}: processing ${validSigs.length} transactions`)

  for (const [i, record] of validSigs.entries()) {
    const sig = solSignature(record.signature)
    let tx: unknown
    let fetched = false

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        tx = await client.rpc
          .getTransaction(sig, {
            encoding: 'jsonParsed',
            maxSupportedTransactionVersion: 0,
          })
          .send()
        fetched = true
        break
      } catch (err) {
        const label = `${record.signature.slice(0, 12)}...`
        if (attempt < MAX_RETRIES) {
          console.warn(`[index] Epoch ${epoch}: retry ${attempt}/${MAX_RETRIES} for ${label}`)
          await Bun.sleep(RETRY_DELAY_MS * attempt)
        } else {
          console.error(`[index] Epoch ${epoch}: skipping ${label} after ${MAX_RETRIES} failures`)
          console.error(err)
        }
      }
    }

    if (fetched && tx !== null) {
      const mintRecord = extractMintRecord(
        tx as { blockTime: bigint | null; meta: unknown; transaction: unknown },
        record.signature,
        record.slot,
        record.blockTime,
      )
      if (mintRecord) {
        mints.push(mintRecord)
      }
    }

    if ((i + 1) % 50 === 0) {
      console.log(`[index] Epoch ${epoch}: ${i + 1}/${validSigs.length} processed (${mints.length} mints found)`)
    }

    await Bun.sleep(TX_DELAY_MS)
  }

  console.log(`[index] Epoch ${epoch}: found ${mints.length} mints`)
  return mints
}

export async function indexEpoch(db: Db, epoch: number): Promise<{ holderCount: number }> {
  const client = createSolanaClient()

  // 1. Fetch signatures for this epoch
  const signatures = await fetchSignaturesForEpoch(client, epoch)

  // 2. Fetch and extract mint records
  const mints = await fetchMintRecords(client, signatures, epoch)

  // 3. Write to DB in a transaction (idempotent: delete + re-insert)
  await db.transaction(async (tx) => {
    await tx.delete(holders).where(eq(holders.epoch, epoch))

    if (mints.length > 0) {
      await tx.insert(holders).values(
        mints.map((m) => ({
          ata: m.ata,
          blockTime: m.blockTime,
          epoch,
          holder: m.recipient,
          mint: m.mint,
          signature: m.signature,
          slot: m.slot,
        })),
      )
    }

    await tx
      .insert(epochs)
      .values({
        epoch,
        holderCount: mints.length,
        indexedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        set: {
          holderCount: mints.length,
          indexedAt: new Date().toISOString(),
        },
        target: epochs.epoch,
      })
  })

  console.log(`[index] Epoch ${epoch}: committed ${mints.length} holders to database`)
  return { holderCount: mints.length }
}

export async function indexAll(db: Db, startEpoch = 731, endEpoch?: number): Promise<void> {
  // Determine the current epoch from the chain
  const client = createSolanaClient()
  const slot = await client.rpc.getSlot().send()
  const currentEpoch = endEpoch ?? Math.floor(Number(slot) / SLOTS_PER_EPOCH)

  console.log(`[index] Indexing epochs ${startEpoch} to ${currentEpoch}`)

  // Check which epochs are already indexed
  const indexed = await db.select({ epoch: epochs.epoch }).from(epochs)
  const indexedSet = new Set(indexed.map((e) => e.epoch))

  let total = 0
  for (let epoch = startEpoch; epoch <= currentEpoch; epoch++) {
    if (indexedSet.has(epoch)) {
      console.log(`[index] Epoch ${epoch}: already indexed, skipping`)
      continue
    }

    const result = await indexEpoch(db, epoch)
    total += result.holderCount
  }

  console.log(`[index] Done. Indexed ${total} new holders.`)
}

export async function syncLatest(db: Db): Promise<void> {
  const client = createSolanaClient()
  const slot = await client.rpc.getSlot().send()
  const currentEpoch = Math.floor(Number(slot) / SLOTS_PER_EPOCH)

  // Always re-index current epoch (may have new mints)
  // Also index any missing previous epochs
  await indexAll(db, 731, currentEpoch)
}
```

**Step 2: Run type check**

Run: `bun run check-types`
Expected: PASS

**Step 3: Commit**

```bash
git add src/indexer-db.ts
git commit -m "feat: add database-backed indexer with per-epoch indexing"
```

---

### Task 4: CLI Entry Point for Indexing

Replace `src/index.ts` with a CLI that supports `--epoch N`, `--all`, and `--sync` (default for cron).

**Files:**
- Rewrite: `src/index.ts`

**Step 1: Rewrite `src/index.ts`**

```typescript
import { createDb } from './db/index.ts'
import { indexAll, indexEpoch, syncLatest } from './indexer-db.ts'

const db = createDb()

const args = Bun.argv.slice(2)
const command = args[0]

if (command === '--epoch') {
  const epoch = Number(args[1])
  if (Number.isNaN(epoch)) {
    console.error('Usage: bun run src/index.ts --epoch <number>')
    process.exit(1)
  }
  await indexEpoch(db, epoch)
} else if (command === '--all') {
  await indexAll(db)
} else {
  // Default: sync latest (for cron job)
  await syncLatest(db)
}
```

**Step 2: Run type check**

Run: `bun run check-types`
Expected: PASS

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add CLI entry point with --epoch, --all, and default sync"
```

---

### Task 5: Hono API

**Files:**
- Create: `src/api.ts`
- Modify: `package.json` (add `dev` and `serve` scripts)

**Step 1: Create `src/api.ts`**

```typescript
import { eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { createDb } from './db/index.ts'
import { epochs, holders } from './db/schema.ts'

const db = createDb()
const app = new Hono()

// GET /api/holders/:wallet — check if wallet holds an NFT
app.get('/api/holders/:wallet', async (c) => {
  const wallet = c.req.param('wallet')
  const results = await db.select().from(holders).where(eq(holders.holder, wallet))

  if (results.length === 0) {
    return c.json({ error: 'Wallet is not a holder' }, 404)
  }

  return c.json({
    count: results.length,
    holder: wallet,
    mints: results.map((r) => ({
      ata: r.ata,
      blockTime: r.blockTime,
      epoch: r.epoch,
      mint: r.mint,
      signature: r.signature,
      slot: r.slot,
    })),
  })
})

// GET /api/holders — paginated list of all holders
app.get('/api/holders', async (c) => {
  const page = Math.max(1, Number(c.req.query('page') ?? 1))
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 20)))
  const offset = (page - 1) * limit

  const [results, countResult] = await Promise.all([
    db.select().from(holders).orderBy(holders.slot).limit(limit).offset(offset),
    db.select({ total: sql<number>`sum(${epochs.holderCount})` }).from(epochs),
  ])

  const total = countResult[0]?.total ?? 0

  return c.json({
    data: results.map((r) => ({
      ata: r.ata,
      blockTime: r.blockTime,
      epoch: r.epoch,
      holder: r.holder,
      mint: r.mint,
      signature: r.signature,
      slot: r.slot,
    })),
    page,
    pageCount: Math.ceil(total / limit),
    total,
  })
})

// GET /api/epochs — list indexed epochs
app.get('/api/epochs', async (c) => {
  const results = await db.select().from(epochs).orderBy(epochs.epoch)

  return c.json({
    data: results,
    totalHolders: results.reduce((sum, e) => sum + e.holderCount, 0),
  })
})

export default {
  fetch: app.fetch,
  port: Number(Bun.env.PORT ?? 3000),
}
```

**Step 2: Add scripts to `package.json`**

Add to the `"scripts"` section:

```json
"dev": "bun run --hot src/api.ts",
"serve": "bun run src/api.ts",
"index": "bun run src/index.ts",
"index:epoch": "bun run src/index.ts --epoch",
"index:all": "bun run src/index.ts --all"
```

**Step 3: Run type check**

Run: `bun run check-types`
Expected: PASS

**Step 4: Test manually**

Run: `bun run dev`
Then in another terminal:
```bash
curl http://localhost:3000/api/epochs
curl http://localhost:3000/api/holders?page=1&limit=5
```

Expected: JSON responses (empty data if DB hasn't been populated yet)

**Step 5: Commit**

```bash
git add src/api.ts package.json
git commit -m "feat: add hono API with holder lookup, pagination, and epochs endpoints"
```

---

### Task 6: Seed Database from Existing Data

Write a one-time migration script that reads the existing `data/holders.json` and seeds the Turso database. This is much faster than re-indexing from the chain.

**Files:**
- Create: `src/seed-from-json.ts`

**Step 1: Create `src/seed-from-json.ts`**

```typescript
import { createDb } from './db/index.ts'
import { epochs, holders } from './db/schema.ts'
import type { HolderRecord } from './types.ts'

const db = createDb()

console.log('[seed] Reading holders.json...')
const raw = await Bun.file('data/holders.json').text()
const data: HolderRecord[] = JSON.parse(raw)
console.log(`[seed] Found ${data.length} holders`)

// Group by epoch
const byEpoch = new Map<number, HolderRecord[]>()
for (const record of data) {
  const list = byEpoch.get(record.epoch) ?? []
  list.push(record)
  byEpoch.set(record.epoch, list)
}

console.log(`[seed] ${byEpoch.size} epochs to insert`)

// Insert in batches per epoch
const sortedEpochs = [...byEpoch.keys()].sort((a, b) => a - b)

for (const epoch of sortedEpochs) {
  const records = byEpoch.get(epoch)!

  await db.transaction(async (tx) => {
    // Insert holders in chunks of 500 (SQLite variable limit)
    const chunkSize = 500
    for (let i = 0; i < records.length; i += chunkSize) {
      const chunk = records.slice(i, i + chunkSize)
      await tx.insert(holders).values(
        chunk.map((r) => ({
          ata: r.ata,
          blockTime: r.blockTime,
          epoch: r.epoch,
          holder: r.holder,
          mint: r.mint,
          signature: r.signature,
          slot: r.slot,
        })),
      )
    }

    await tx
      .insert(epochs)
      .values({
        epoch,
        holderCount: records.length,
        indexedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        set: {
          holderCount: records.length,
          indexedAt: new Date().toISOString(),
        },
        target: epochs.epoch,
      })
  })

  console.log(`[seed] Epoch ${epoch}: inserted ${records.length} holders`)
}

console.log('[seed] Done!')
```

**Step 2: Run the seed script**

> **Prerequisite:** User must have created a Turso database and set env vars in `.env`. Migrations must have been run (Task 2, Step 6).

```bash
bun run src/seed-from-json.ts
```

Expected: All holders inserted, log output showing per-epoch progress.

**Step 3: Verify with API**

```bash
bun run dev &
curl http://localhost:3000/api/epochs
curl http://localhost:3000/api/holders?page=1&limit=3
```

Expected: Epochs list shows all 137 epochs with holder counts. Holders returns paginated data.

**Step 4: Commit**

```bash
git add src/seed-from-json.ts
git commit -m "feat: add seed script to populate turso from existing holders.json"
```

---

### Task 7: Update GitHub Actions

**Files:**
- Modify: `.github/workflows/sync.yaml`

**Step 1: Update the workflow**

Replace the contents of `.github/workflows/sync.yaml`:

```yaml
name: Sync

on:
  schedule:
    - cron: '0 * * * *' # every hour
  workflow_dispatch:
    inputs:
      epoch:
        description: 'Specific epoch to re-index (leave empty for default sync)'
        required: false
        type: string

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@8e8c483db84b4bee98b60c0593521ed34d9990e8 # v6

      - name: Setup Environment
        uses: ./.github/actions/setup

      - name: Generate migrations
        run: bunx drizzle-kit generate
        env:
          TURSO_DATABASE_URL: ${{ secrets.TURSO_DATABASE_URL }}
          TURSO_AUTH_TOKEN: ${{ secrets.TURSO_AUTH_TOKEN }}

      - name: Run migrations
        run: bunx drizzle-kit migrate
        env:
          TURSO_DATABASE_URL: ${{ secrets.TURSO_DATABASE_URL }}
          TURSO_AUTH_TOKEN: ${{ secrets.TURSO_AUTH_TOKEN }}

      - name: Run sync
        run: |
          if [ -n "${{ inputs.epoch }}" ]; then
            bun run src/index.ts --epoch ${{ inputs.epoch }}
          else
            bun run src/index.ts
          fi
        env:
          SOLANA_ENDPOINT: ${{ secrets.SOLANA_ENDPOINT }}
          TURSO_DATABASE_URL: ${{ secrets.TURSO_DATABASE_URL }}
          TURSO_AUTH_TOKEN: ${{ secrets.TURSO_AUTH_TOKEN }}
```

Note: No more git commit/push step. The `workflow_dispatch` now accepts an optional `epoch` input for manual re-indexing of a specific epoch.

**Step 2: Commit**

```bash
git add .github/workflows/sync.yaml
git commit -m "feat: update sync workflow to write to turso instead of json files"
```

---

### Task 8: Cleanup Old File-Based Code

Only do this after verifying the migration works (seed script ran successfully, API returns correct data).

**Files:**
- Delete: `src/cache.ts`
- Delete: `src/build-holders.ts`
- Delete: `src/indexer.ts`
- Delete: `src/tx-fetcher.ts`
- Modify: `src/types.ts` (keep `MintRecord`, `SignatureRecord`, `HolderRecord` — remove `SyncCursor`, `EpochTransactions`)
- Modify: `.gitignore` (remove `data/` if tracked, add `drizzle/` meta if needed)

**Step 1: Remove old source files**

```bash
rm src/cache.ts src/build-holders.ts src/indexer.ts src/tx-fetcher.ts
```

**Step 2: Clean up `src/types.ts`**

Remove `SyncCursor` and `EpochTransactions` interfaces (no longer used). Keep `SignatureRecord`, `MintRecord`, and `HolderRecord`.

Updated `src/types.ts`:

```typescript
export interface SignatureRecord {
  signature: string
  slot: string
  blockTime: number | null
  err: unknown
  memo: string | null
}

export interface MintRecord {
  ata: string
  blockTime: number | null
  mint: string
  recipient: string
  signature: string
  slot: string
}

export interface HolderRecord {
  ata: string
  blockTime: number | null
  epoch: number
  holder: string
  mint: string
  signature: string
  slot: string
}
```

**Step 3: Remove `superjson` dependency**

```bash
bun remove superjson
```

**Step 4: Run type check and lint**

```bash
bun run check-types && bun run lint
```

Expected: PASS (no remaining imports of deleted files)

**Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove file-based storage layer and superjson dependency"
```

---

### Task 9: Add Tests

**Files:**
- Create: `src/db/schema.test.ts`
- Create: `src/api.test.ts`

**Step 1: Write schema validation test**

Create `src/db/schema.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test'
import { getTableColumns } from 'drizzle-orm'
import { epochs, holders } from './schema.ts'

describe('holders schema', () => {
  test('has expected columns', () => {
    const cols = getTableColumns(holders)
    expect(Object.keys(cols).sort()).toEqual(['ata', 'blockTime', 'epoch', 'holder', 'id', 'mint', 'signature', 'slot'])
  })

  test('mint column is unique', () => {
    const cols = getTableColumns(holders)
    expect(cols.mint.isUnique).toBe(true)
  })

  test('signature column is unique', () => {
    const cols = getTableColumns(holders)
    expect(cols.signature.isUnique).toBe(true)
  })
})

describe('epochs schema', () => {
  test('has expected columns', () => {
    const cols = getTableColumns(epochs)
    expect(Object.keys(cols).sort()).toEqual(['epoch', 'holderCount', 'indexedAt'])
  })

  test('epoch is primary key', () => {
    const cols = getTableColumns(epochs)
    expect(cols.epoch.primary).toBe(true)
  })
})
```

**Step 2: Run tests to verify they pass**

Run: `bun test`
Expected: All tests PASS

**Step 3: Write API route tests**

Create `src/api.test.ts` — tests against a local in-memory SQLite DB:

```typescript
import { describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { Hono } from 'hono'
import { eq, sql } from 'drizzle-orm'
import * as schema from './db/schema.ts'
import { epochs, holders } from './db/schema.ts'

function createTestApp() {
  const db = drizzle({ connection: { url: ':memory:' }, schema })

  // Create tables directly (no migration files needed for in-memory)
  db.run(sql`CREATE TABLE IF NOT EXISTS holders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    holder TEXT NOT NULL,
    mint TEXT NOT NULL UNIQUE,
    ata TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    slot TEXT NOT NULL,
    block_time INTEGER,
    signature TEXT NOT NULL UNIQUE
  )`)
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_holders_holder ON holders(holder)`)
  db.run(sql`CREATE INDEX IF NOT EXISTS idx_holders_epoch ON holders(epoch)`)
  db.run(sql`CREATE TABLE IF NOT EXISTS epochs (
    epoch INTEGER PRIMARY KEY,
    holder_count INTEGER NOT NULL DEFAULT 0,
    indexed_at TEXT NOT NULL
  )`)

  const app = new Hono()

  app.get('/api/holders/:wallet', async (c) => {
    const wallet = c.req.param('wallet')
    const results = await db.select().from(holders).where(eq(holders.holder, wallet))
    if (results.length === 0) return c.json({ error: 'Wallet is not a holder' }, 404)
    return c.json({ count: results.length, holder: wallet, mints: results })
  })

  app.get('/api/holders', async (c) => {
    const page = Math.max(1, Number(c.req.query('page') ?? 1))
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 20)))
    const offset = (page - 1) * limit
    const [results, countResult] = await Promise.all([
      db.select().from(holders).orderBy(holders.slot).limit(limit).offset(offset),
      db.select({ total: sql<number>`sum(${epochs.holderCount})` }).from(epochs),
    ])
    const total = countResult[0]?.total ?? 0
    return c.json({ data: results, page, pageCount: Math.ceil(total / limit), total })
  })

  app.get('/api/epochs', async (c) => {
    const results = await db.select().from(epochs).orderBy(epochs.epoch)
    return c.json({ data: results, totalHolders: results.reduce((sum, e) => sum + e.holderCount, 0) })
  })

  return { app, db }
}

function seedTestData(db: ReturnType<typeof drizzle>) {
  db.insert(holders).values({
    ata: 'ata1',
    blockTime: 1738085008,
    epoch: 731,
    holder: 'wallet1',
    mint: 'mint1',
    signature: 'sig1',
    slot: '316960068',
  }).run()

  db.insert(holders).values({
    ata: 'ata2',
    blockTime: 1738085100,
    epoch: 731,
    holder: 'wallet2',
    mint: 'mint2',
    signature: 'sig2',
    slot: '316960100',
  }).run()

  db.insert(epochs).values({
    epoch: 731,
    holderCount: 2,
    indexedAt: '2026-02-09T00:00:00.000Z',
  }).run()
}

describe('GET /api/holders/:wallet', () => {
  test('returns holder data for a valid wallet', async () => {
    const { app, db } = createTestApp()
    seedTestData(db)

    const res = await app.request('/api/holders/wallet1')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.holder).toBe('wallet1')
    expect(json.count).toBe(1)
    expect(json.mints[0].mint).toBe('mint1')
  })

  test('returns 404 for unknown wallet', async () => {
    const { app } = createTestApp()
    const res = await app.request('/api/holders/unknown')
    expect(res.status).toBe(404)
  })
})

describe('GET /api/holders', () => {
  test('returns paginated holders', async () => {
    const { app, db } = createTestApp()
    seedTestData(db)

    const res = await app.request('/api/holders?page=1&limit=1')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.length).toBe(1)
    expect(json.total).toBe(2)
    expect(json.pageCount).toBe(2)
  })
})

describe('GET /api/epochs', () => {
  test('returns indexed epochs', async () => {
    const { app, db } = createTestApp()
    seedTestData(db)

    const res = await app.request('/api/epochs')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.length).toBe(1)
    expect(json.data[0].epoch).toBe(731)
    expect(json.totalHolders).toBe(2)
  })
})
```

**Step 4: Run tests**

Run: `bun test`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/db/schema.test.ts src/api.test.ts
git commit -m "test: add schema validation and API route tests"
```

---

## Execution Order Summary

| Task | What | Depends on |
|------|------|-----------|
| 1 | Install dependencies | — |
| 2 | Drizzle schema + DB connection | Task 1 |
| 3 | Rework indexer (`indexEpoch`) | Task 2 |
| 4 | CLI entry point | Task 3 |
| 5 | Hono API | Task 2 |
| 6 | Seed DB from existing JSON | Task 2 |
| 7 | Update GitHub Actions | Task 4 |
| 8 | Cleanup old code | Tasks 3-7 verified |
| 9 | Add tests | Tasks 2, 5 |

> **Note:** Tasks 3-6 can be partially parallelized (3+5 are independent, 4 depends on 3, 6 depends on 2). Task 8 is intentionally last — only clean up after everything works.

## Prerequisites (User Action Required)

Before starting implementation:

1. **Create Turso database:**
   ```bash
   brew install tursodatabase/tap/turso
   turso auth login
   turso db create seeker-genesis-holders
   turso db show seeker-genesis-holders --url
   turso db tokens create seeker-genesis-holders
   ```

2. **Add credentials to `.env`:**
   ```
   TURSO_DATABASE_URL=libsql://seeker-genesis-holders-<username>.turso.io
   TURSO_AUTH_TOKEN=<token>
   ```

3. **Add GitHub Secrets:** `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`
