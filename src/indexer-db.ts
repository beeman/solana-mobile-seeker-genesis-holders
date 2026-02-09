import { address, signature as solSignature } from '@solana/kit'
import { eq } from 'drizzle-orm'
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

async function fetchMintRecords(
  client: SolanaClient,
  signatures: SignatureRecord[],
  epoch: number,
): Promise<MintRecord[]> {
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

  // 3. Compute epoch time range from block times
  const blockTimes = mints.map((m) => m.blockTime).filter((t): t is number => t !== null)
  const firstBlockTime = blockTimes.length > 0 ? Math.min(...blockTimes) : null
  const lastBlockTime = blockTimes.length > 0 ? Math.max(...blockTimes) : null

  // 4. Write to DB in a transaction (idempotent: delete + re-insert)
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
        firstBlockTime,
        holderCount: mints.length,
        indexedAt: new Date().toISOString(),
        lastBlockTime,
      })
      .onConflictDoUpdate({
        set: {
          firstBlockTime,
          holderCount: mints.length,
          indexedAt: new Date().toISOString(),
          lastBlockTime,
        },
        target: epochs.epoch,
      })
  })

  console.log(`[index] Epoch ${epoch}: committed ${mints.length} holders to database`)
  return { holderCount: mints.length }
}

export async function indexAll(db: Db, startEpoch = 731, endEpoch?: number): Promise<void> {
  const client = createSolanaClient()
  const slot = await client.rpc.getSlot().send()
  const currentEpoch = endEpoch ?? Math.floor(Number(slot) / SLOTS_PER_EPOCH)

  console.log(`[index] Indexing epochs ${startEpoch} to ${currentEpoch}`)

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

  // Always re-index current epoch (may have new mints) and any missing previous ones
  await indexAll(db, 731, currentEpoch)
}
