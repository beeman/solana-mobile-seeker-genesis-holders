import { listSignatureEpochs, readEpochTransactions } from './cache.ts'
import type { HolderRecord } from './types.ts'

export async function buildHoldersList(): Promise<void> {
  const epochs = await listSignatureEpochs()
  const holders: HolderRecord[] = []

  for (const epoch of epochs) {
    const txData = await readEpochTransactions(epoch)
    for (const mint of txData.mints) {
      holders.push({
        ata: mint.ata,
        blockTime: mint.blockTime,
        epoch,
        holder: mint.recipient,
        mint: mint.mint,
        signature: mint.signature,
        slot: mint.slot,
      })
    }
  }

  holders.sort((a, b) => Number(a.slot) - Number(b.slot))

  await Bun.write('data/holders.json', JSON.stringify(holders, null, 2))
  console.log(`[build-holders] Wrote ${holders.length} holders to data/holders.json`)
}
