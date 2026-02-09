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
  firstBlockTime: int('first_block_time'),
  holderCount: int('holder_count').notNull().default(0),
  indexedAt: text('indexed_at').notNull(),
  lastBlockTime: int('last_block_time'),
})
