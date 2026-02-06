import { address } from '@solana/kit'
import { buildHoldersList } from './build-holders.ts'
import { syncSignatures } from './indexer.ts'
import { createSolanaClient } from './solana-client.ts'
import { processAllTransactions } from './tx-fetcher.ts'

const client = createSolanaClient()

const genesis = await client.rpc.getGenesisHash().send()

const payer = address('GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4')
const group = address('GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te')

console.log('Summary', {
  genesis,
  group,
  payer,
})

await syncSignatures()
await processAllTransactions()
await buildHoldersList()
