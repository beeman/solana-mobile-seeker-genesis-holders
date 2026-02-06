import { signature } from '@solana/kit'
import {
  ensureCacheDir,
  listSignatureEpochs,
  readEpochSignatures,
  readEpochTransactions,
  writeEpochTransactions,
} from './cache.ts'
import { createSolanaClient } from './solana-client.ts'
import type { MintRecord } from './types.ts'

const GROUP = 'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te'
const TX_DELAY_MS = 50
const SAVE_INTERVAL = 20
const MAX_RETRIES = 3
const RETRY_DELAY_MS = 1000

type SolanaClient = ReturnType<typeof createSolanaClient>

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
    message: {
      accountKeys: Array<{ pubkey: string }>
    }
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

interface Progress {
  processed: number
  total: number
  startedAt: number
}

function formatEta(progress: Progress): string {
  const elapsed = Date.now() - progress.startedAt
  if (progress.processed === 0) return 'calculating...'
  const msPerTx = elapsed / progress.processed
  const remaining = progress.total - progress.processed
  const etaMs = remaining * msPerTx
  const etaSec = Math.round(etaMs / 1000)
  if (etaSec < 60) return `${etaSec}s`
  if (etaSec < 3600) return `${Math.floor(etaSec / 60)}m ${etaSec % 60}s`
  const h = Math.floor(etaSec / 3600)
  const m = Math.floor((etaSec % 3600) / 60)
  return `${h}h ${m}m`
}

async function processEpoch(client: SolanaClient, epoch: number, progress: Progress): Promise<void> {
  const signatures = await readEpochSignatures(epoch)
  const txData = await readEpochTransactions(epoch)

  const processedSet = new Set(txData.processed)
  const unprocessed = signatures.filter((s) => !processedSet.has(s.signature) && s.err === null)

  if (unprocessed.length === 0) {
    progress.processed += signatures.length
    console.log(`[tx-fetch] Epoch ${epoch}: all ${signatures.length} signatures already processed`)
    return
  }

  console.log(
    `[tx-fetch] Epoch ${epoch}: ${unprocessed.length} signatures to process (${processedSet.size} already done)`,
  )

  let sinceLastSave = 0

  for (const record of unprocessed) {
    const sig = signature(record.signature)

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
          console.warn(`[tx-fetch] Epoch ${epoch}: retry ${attempt}/${MAX_RETRIES} for ${label}`)
          await Bun.sleep(RETRY_DELAY_MS * attempt)
        } else {
          console.error(`[tx-fetch] Epoch ${epoch}: skipping ${label} after ${MAX_RETRIES} failures`)
          console.error(err)
        }
      }
    }

    if (!fetched) {
      txData.processed.push(record.signature)
      sinceLastSave++
      progress.processed++
      continue
    }

    if (tx === null) {
      txData.processed.push(record.signature)
      sinceLastSave++
    } else {
      const mintRecord = extractMintRecord(
        tx as { blockTime: bigint | null; meta: unknown; transaction: unknown },
        record.signature,
        record.slot,
        record.blockTime,
      )

      if (mintRecord) {
        txData.mints.push(mintRecord)
      }
      txData.processed.push(record.signature)
      sinceLastSave++
    }

    progress.processed++

    if (sinceLastSave >= SAVE_INTERVAL) {
      await writeEpochTransactions(epoch, txData)
      sinceLastSave = 0
      const pct = ((progress.processed / progress.total) * 100).toFixed(1)
      console.log(
        `[tx-fetch] Epoch ${epoch}: saved progress (${txData.processed.length} processed, ${txData.mints.length} mints) | ${pct}% overall, ETA ${formatEta(progress)}`,
      )
    }

    await Bun.sleep(TX_DELAY_MS)
  }

  await writeEpochTransactions(epoch, txData)
  console.log(
    `[tx-fetch] Epoch ${epoch}: complete (${txData.processed.length} processed, ${txData.mints.length} mints)`,
  )
}

export async function processAllTransactions(): Promise<void> {
  await ensureCacheDir()
  const client = createSolanaClient()
  const epochs = await listSignatureEpochs()

  let total = 0
  for (const epoch of epochs) {
    const sigs = await readEpochSignatures(epoch)
    total += sigs.length
  }

  const progress: Progress = { processed: 0, startedAt: Date.now(), total }
  console.log(`[tx-fetch] Found ${epochs.length} epochs, ${total} total signatures`)

  for (const [i, epoch] of epochs.entries()) {
    const pct = Math.round(((i + 1) / epochs.length) * 100)
    console.log(`[tx-fetch] [${i + 1}/${epochs.length} ${pct}%] Starting epoch ${epoch}`)
    await processEpoch(client, epoch, progress)
  }

  console.log('[tx-fetch] All epochs processed')
}
