import { eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { createDb } from './db/index.ts'
import { epochs, holders } from './db/schema.ts'

const db = createDb()
const app = new Hono()

app.get('/health', async (c) => {
  const [countResult] = await db.select({ total: sql<number>`count(*)` }).from(holders)

  return c.json({
    status: 'ok',
    totalHolders: countResult?.total ?? 0,
    uptime: Math.floor(process.uptime()),
  })
})

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

export default {
  fetch: app.fetch,
  port: Number(Bun.env.PORT ?? 3000),
}
