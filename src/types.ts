export interface SignatureRecord {
  signature: string
  slot: string
  blockTime: number | null
  err: unknown
  memo: string | null
}

export interface SyncCursor {
  newestSignature: string | null
  oldestSignature: string | null
  backfillComplete: boolean
  lastSyncedAt: string
}

export interface MintRecord {
  ata: string
  blockTime: number | null
  mint: string
  recipient: string
  signature: string
  slot: string
}

export interface HolderRecord {
  ata: string
  blockTime: number | null
  epoch: number
  holder: string
  mint: string
  signature: string
  slot: string
}

export interface EpochTransactions {
  mints: MintRecord[]
  processed: string[]
}
