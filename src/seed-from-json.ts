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

const sortedEpochs = [...byEpoch.keys()].sort((a, b) => a - b)

for (const epoch of sortedEpochs) {
  const records = byEpoch.get(epoch)
  if (!records) continue

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
