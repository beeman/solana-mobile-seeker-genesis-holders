import { address, signature } from '@solana/kit'
import { appendSignaturesByEpoch, ensureCacheDir, prependSignaturesByEpoch, readCursor, writeCursor } from './cache.ts'
import { createSolanaClient } from './solana-client.ts'
import type { SignatureRecord, SyncCursor } from './types.ts'

const PAYER = address('GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4')
const PAGE_DELAY_MS = 200

type SolanaClient = ReturnType<typeof createSolanaClient>

function toSignatureRecord(tx: {
  signature: string
  slot: bigint
  blockTime: bigint | null
  err: unknown
  memo: string | null
}): SignatureRecord {
  return {
    blockTime: tx.blockTime != null ? Number(tx.blockTime) : null,
    err: tx.err,
    memo: tx.memo,
    signature: tx.signature as string,
    slot: tx.slot.toString(),
  }
}

async function forwardSync(client: SolanaClient, cursor: SyncCursor): Promise<SyncCursor> {
  if (!cursor.newestSignature) {
    console.log('[forward] No previous cursor, skipping forward sync.')
    return cursor
  }

  console.log(`[forward] Fetching signatures newer than ${cursor.newestSignature.slice(0, 12)}...`)
  const allNew: SignatureRecord[] = []
  let before: string | undefined

  while (true) {
    const config: Record<string, unknown> = { until: signature(cursor.newestSignature) }
    if (before) {
      config.before = signature(before)
    }

    const results = await client.rpc.getSignaturesForAddress(PAYER, config).send()

    if (results.length === 0) break

    const records = results.map(toSignatureRecord)
    allNew.push(...records)
    const lastRecord = records.at(-1)
    if (lastRecord) {
      before = lastRecord.signature
    }

    console.log(`[forward] Fetched ${results.length} signatures (total new: ${allNew.length})`)
    await Bun.sleep(PAGE_DELAY_MS)
  }

  if (allNew.length === 0) {
    console.log('[forward] No new signatures found.')
    return cursor
  }

  await prependSignaturesByEpoch(allNew)
  const firstRecord = allNew[0]
  const updated: SyncCursor = {
    ...cursor,
    lastSyncedAt: new Date().toISOString(),
    newestSignature: firstRecord ? firstRecord.signature : cursor.newestSignature,
  }
  await writeCursor(updated)
  console.log(`[forward] Added ${allNew.length} new signatures.`)
  return updated
}

async function backfill(client: SolanaClient, cursor: SyncCursor): Promise<SyncCursor> {
  if (cursor.backfillComplete) {
    console.log('[backfill] Already complete, skipping.')
    return cursor
  }

  console.log('[backfill] Starting backfill...')
  let before = cursor.oldestSignature ? signature(cursor.oldestSignature) : undefined
  let totalAdded = 0

  while (true) {
    const config: Record<string, unknown> = {}
    if (before) {
      config.before = before
    }

    const results = await client.rpc.getSignaturesForAddress(PAYER, config).send()

    if (results.length === 0) {
      const updated: SyncCursor = {
        ...cursor,
        backfillComplete: true,
        lastSyncedAt: new Date().toISOString(),
      }
      await writeCursor(updated)
      console.log(`[backfill] Complete. Total added this run: ${totalAdded}`)
      return updated
    }

    const records = results.map(toSignatureRecord)
    await appendSignaturesByEpoch(records)
    totalAdded += records.length

    const oldestRecord = records.at(-1)
    if (oldestRecord) {
      before = signature(oldestRecord.signature)

      // Update cursor after every page for crash recovery
      if (!cursor.newestSignature) {
        const firstRecord = records[0]
        if (firstRecord) {
          cursor.newestSignature = firstRecord.signature
        }
      }
      cursor.oldestSignature = oldestRecord.signature
      cursor.lastSyncedAt = new Date().toISOString()
      await writeCursor(cursor)

      console.log(
        `[backfill] Fetched ${results.length} signatures (total this run: ${totalAdded}, oldest slot: ${oldestRecord.slot})`,
      )
    }
    await Bun.sleep(PAGE_DELAY_MS)
  }
}

export async function syncSignatures(): Promise<void> {
  await ensureCacheDir()
  const client = createSolanaClient()

  let cursor = await readCursor()
  cursor = await forwardSync(client, cursor)
  cursor = await backfill(client, cursor)

  console.log(`[sync] Done. Backfill complete: ${cursor.backfillComplete}, last synced: ${cursor.lastSyncedAt}`)
}
