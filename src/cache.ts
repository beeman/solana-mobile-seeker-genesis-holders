import { mkdir, readdir } from 'node:fs/promises'
import superjson from 'superjson'
import type { EpochTransactions, SignatureRecord, SyncCursor } from './types.ts'

const DATA_DIR = 'data'
const SIGNATURES_DIR = `${DATA_DIR}/signatures`
const TRANSACTIONS_DIR = `${DATA_DIR}/transactions`
const CURSOR_PATH = `${DATA_DIR}/cursor.json`
const SLOTS_PER_EPOCH = 432_000

const DEFAULT_CURSOR: SyncCursor = {
  backfillComplete: false,
  lastSyncedAt: new Date().toISOString(),
  newestSignature: null,
  oldestSignature: null,
}

export function epochFromSlot(slot: string): number {
  return Math.floor(Number(slot) / SLOTS_PER_EPOCH)
}

function epochPath(epoch: number): string {
  return `${SIGNATURES_DIR}/epoch-${epoch}.json`
}

function groupByEpoch(records: SignatureRecord[]): Map<number, SignatureRecord[]> {
  const map = new Map<number, SignatureRecord[]>()
  for (const record of records) {
    const epoch = epochFromSlot(record.slot)
    const list = map.get(epoch) ?? []
    list.push(record)
    map.set(epoch, list)
  }
  return map
}

export async function ensureCacheDir(): Promise<void> {
  await mkdir(SIGNATURES_DIR, { recursive: true })
  await mkdir(TRANSACTIONS_DIR, { recursive: true })
}

export async function readCursor(): Promise<SyncCursor> {
  const file = Bun.file(CURSOR_PATH)
  if (!(await file.exists())) {
    return { ...DEFAULT_CURSOR }
  }
  return superjson.parse(await file.text())
}

export async function writeCursor(cursor: SyncCursor): Promise<void> {
  await Bun.write(CURSOR_PATH, superjson.stringify(cursor))
}

export async function readEpochSignatures(epoch: number): Promise<SignatureRecord[]> {
  const file = Bun.file(epochPath(epoch))
  if (!(await file.exists())) {
    return []
  }
  return superjson.parse(await file.text())
}

async function writeEpochSignatures(epoch: number, records: SignatureRecord[]): Promise<void> {
  await Bun.write(epochPath(epoch), superjson.stringify(records))
}

export async function prependSignaturesByEpoch(records: SignatureRecord[]): Promise<void> {
  const grouped = groupByEpoch(records)
  for (const [epoch, epochRecords] of grouped) {
    const existing = await readEpochSignatures(epoch)
    await writeEpochSignatures(epoch, [...epochRecords, ...existing])
  }
}

export async function appendSignaturesByEpoch(records: SignatureRecord[]): Promise<void> {
  const grouped = groupByEpoch(records)
  for (const [epoch, epochRecords] of grouped) {
    const existing = await readEpochSignatures(epoch)
    await writeEpochSignatures(epoch, [...existing, ...epochRecords])
  }
}

function transactionsPath(epoch: number): string {
  return `${TRANSACTIONS_DIR}/epoch-${epoch}.json`
}

const DEFAULT_EPOCH_TRANSACTIONS: EpochTransactions = {
  mints: [],
  processed: [],
}

export async function readEpochTransactions(epoch: number): Promise<EpochTransactions> {
  const file = Bun.file(transactionsPath(epoch))
  if (!(await file.exists())) {
    return { ...DEFAULT_EPOCH_TRANSACTIONS, mints: [], processed: [] }
  }
  return superjson.parse(await file.text())
}

export async function writeEpochTransactions(epoch: number, data: EpochTransactions): Promise<void> {
  await Bun.write(transactionsPath(epoch), superjson.stringify(data))
}

export async function listSignatureEpochs(): Promise<number[]> {
  const files = await readdir(SIGNATURES_DIR)
  const epochs: number[] = []
  for (const file of files) {
    const match = file.match(/^epoch-(\d+)\.json$/)
    if (match?.[1]) {
      epochs.push(Number(match[1]))
    }
  }
  return epochs.sort((a, b) => a - b)
}
