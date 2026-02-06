import { createEmptyClient } from '@solana/kit'
import { rpc } from '@solana/kit-plugin-rpc'

export function createSolanaClient() {
  const endpoint = Bun.env.SOLANA_ENDPOINT
  if (!endpoint) {
    throw new Error('SOLANA_ENDPOINT env var not set.')
  }
  return createEmptyClient().use(rpc(endpoint))
}
