import { describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/libsql'
import { Hono } from 'hono'
import * as schema from './db/schema.ts'
import { epochs, holders } from './db/schema.ts'

async function createTestApp() {
  const db = drizzle({ connection: { url: ':memory:' }, schema })

  await db.run(sql`CREATE TABLE IF NOT EXISTS holders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    holder TEXT NOT NULL,
    mint TEXT NOT NULL UNIQUE,
    ata TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    slot TEXT NOT NULL,
    block_time INTEGER,
    signature TEXT NOT NULL UNIQUE
  )`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS idx_holders_holder ON holders(holder)`)
  await db.run(sql`CREATE INDEX IF NOT EXISTS idx_holders_epoch ON holders(epoch)`)
  await db.run(sql`CREATE TABLE IF NOT EXISTS epochs (
    epoch INTEGER PRIMARY KEY,
    first_block_time INTEGER,
    holder_count INTEGER NOT NULL DEFAULT 0,
    indexed_at TEXT NOT NULL,
    last_block_time INTEGER
  )`)

  const app = new Hono()

  app.get('/api/holders/:wallet', async (c) => {
    const wallet = c.req.param('wallet')
    const results = await db.select().from(holders).where(eq(holders.holder, wallet))
    if (results.length === 0) return c.json({ error: 'Wallet is not a holder' }, 404)
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

  app.get('/api/epochs', async (c) => {
    const results = await db.select().from(epochs).orderBy(epochs.epoch)
    return c.json({
      data: results,
      totalHolders: results.reduce((sum, e) => sum + e.holderCount, 0),
    })
  })

  return { app, db }
}

async function seedTestData(db: Awaited<ReturnType<typeof createTestApp>>['db']) {
  await db.run(
    sql`INSERT INTO holders (holder, mint, ata, epoch, slot, block_time, signature) VALUES ('wallet1', 'mint1', 'ata1', 731, '316960068', 1738085008, 'sig1')`,
  )
  await db.run(
    sql`INSERT INTO holders (holder, mint, ata, epoch, slot, block_time, signature) VALUES ('wallet2', 'mint2', 'ata2', 731, '316960100', 1738085100, 'sig2')`,
  )
  await db.run(sql`INSERT INTO epochs (epoch, holder_count, indexed_at) VALUES (731, 2, '2026-02-09T00:00:00.000Z')`)
}

describe('GET /api/holders/:wallet', () => {
  test('returns holder data for a valid wallet', async () => {
    const { app, db } = await createTestApp()
    await seedTestData(db)

    const res = await app.request('/api/holders/wallet1')
    expect(res.status).toBe(200)

    const json = (await res.json()) as { count: number; holder: string; mints: Array<{ mint: string }> }
    expect(json.holder).toBe('wallet1')
    expect(json.count).toBe(1)
    expect(json.mints[0]?.mint).toBe('mint1')
  })

  test('returns 404 for unknown wallet', async () => {
    const { app } = await createTestApp()
    const res = await app.request('/api/holders/unknown')
    expect(res.status).toBe(404)
  })
})

describe('GET /api/holders', () => {
  test('returns paginated holders', async () => {
    const { app, db } = await createTestApp()
    await seedTestData(db)

    const res = await app.request('/api/holders?page=1&limit=1')
    expect(res.status).toBe(200)

    const json = (await res.json()) as { data: unknown[]; pageCount: number; total: number }
    expect(json.data.length).toBe(1)
    expect(json.total).toBe(2)
    expect(json.pageCount).toBe(2)
  })
})

describe('GET /api/epochs', () => {
  test('returns indexed epochs', async () => {
    const { app, db } = await createTestApp()
    await seedTestData(db)

    const res = await app.request('/api/epochs')
    expect(res.status).toBe(200)

    const json = (await res.json()) as { data: Array<{ epoch: number }>; totalHolders: number }
    expect(json.data.length).toBe(1)
    expect(json.data[0]?.epoch).toBe(731)
    expect(json.totalHolders).toBe(2)
  })
})
