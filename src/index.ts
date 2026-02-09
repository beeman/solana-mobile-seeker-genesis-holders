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
