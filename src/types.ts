export interface SignatureRecord {
  blockTime: number | null
  err: unknown
  memo: string | null
  signature: string
  slot: string
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
