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
    expect(Object.keys(cols).sort()).toEqual(['epoch', 'firstBlockTime', 'holderCount', 'indexedAt', 'lastBlockTime'])
  })

  test('epoch is primary key', () => {
    const cols = getTableColumns(epochs)
    expect(cols.epoch.primary).toBe(true)
  })
})
