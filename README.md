# Solana Mobile Seeker Genesis Holders

Indexes and serves Solana Mobile Seeker Genesis NFT holder data. Tracks which wallets hold Seeker Genesis NFTs, which mint they hold, and since when.

The NFT collection is immutable and non-transferable — once indexed, the data is final.

## Tech Stack

- **Runtime:** Bun
- **Database:** Turso (libSQL)
- **ORM:** Drizzle
- **API:** Hono
- **Indexer:** @solana/kit

## Setup

### Prerequisites

- [Bun](https://bun.sh)
- A [Turso](https://turso.tech) database

### Install dependencies

```bash
bun install
```

### Environment variables

Create a `.env` file:

```env
SOLANA_ENDPOINT=<your_solana_rpc_endpoint>
TURSO_DATABASE_URL=<your_turso_database_url>
TURSO_AUTH_TOKEN=<your_turso_auth_token>
```

### Run database migrations

```bash
bunx drizzle-kit generate
bunx drizzle-kit migrate
```

## API

### Start the development server

```bash
bun run dev
```

The API runs on `http://localhost:3000` by default. Set the `PORT` env var to change it.

### Endpoints

#### `GET /api/holders/:wallet`

Check if a wallet holds a Seeker Genesis NFT. Returns the mint address, epoch, slot, and block time.

```bash
curl http://localhost:3000/api/holders/4pNxsmr4zu1RPQ6VLJBtZsm7cqCQwE9q6VSL8wJ8rzFX
```

```json
{
  "count": 1,
  "holder": "4pNxsmr4zu1RPQ6VLJBtZsm7cqCQwE9q6VSL8wJ8rzFX",
  "mints": [
    {
      "ata": "2UmMgeZUzvLbeZsNmuCdZ7wD57g6rFfYrFo37b7dV1mH",
      "blockTime": 1738085008,
      "epoch": 733,
      "mint": "CUSWiFEeAaUbDMDfSkEgyVg3aj8QTf15CCHAh5acQmAC",
      "signature": "3PN1vXGakR5TQz5Vwzc...",
      "slot": "316960068"
    }
  ]
}
```

Returns `404` if the wallet is not a holder.

#### `GET /api/holders`

Paginated list of all holders, ordered chronologically by slot.

| Param | Default | Description |
|-------|---------|-------------|
| `page` | `1` | Page number |
| `limit` | `20` | Items per page (max 100) |

```bash
curl "http://localhost:3000/api/holders?page=1&limit=3"
```

```json
{
  "data": [
    {
      "ata": "2UmMgeZUzvLbeZsNmuCdZ7wD57g6rFfYrFo37b7dV1mH",
      "blockTime": 1738085008,
      "epoch": 733,
      "holder": "4pNxsmr4zu1RPQ6VLJBtZsm7cqCQwE9q6VSL8wJ8rzFX",
      "mint": "CUSWiFEeAaUbDMDfSkEgyVg3aj8QTf15CCHAh5acQmAC",
      "signature": "3PN1vXGakR5TQz5Vwzc...",
      "slot": "316960068"
    }
  ],
  "page": 1,
  "pageCount": 37412,
  "total": 112236
}
```

#### `GET /api/epochs`

Lists all indexed epochs with holder counts.

```bash
curl http://localhost:3000/api/epochs
```

```json
{
  "data": [
    {
      "epoch": 733,
      "holderCount": 1,
      "indexedAt": "2026-02-09T11:03:35.299Z"
    }
  ],
  "totalHolders": 112236
}
```

## Indexer

The indexer fetches data from the Solana blockchain and writes directly to Turso. It supports per-epoch indexing.

```bash
# Sync latest (default - used by cron)
bun run index

# Index a specific epoch
bun run index:epoch 731

# Index all epochs from scratch
bun run index:all
```

A GitHub Actions workflow runs `bun run index` every hour to pick up new data.

## Docker

### Build

```bash
bun run docker:build
```

### Run

```bash
bun run docker:run
```

This reads env vars from your `.env` file and exposes the API on `http://localhost:3000`.

### Push to GHCR

```bash
bun run docker:push
```

### Run with docker directly

```bash
docker run --rm -it -p 3000:3000 \
  -e TURSO_DATABASE_URL=<your_url> \
  -e TURSO_AUTH_TOKEN=<your_token> \
  ghcr.io/beeman/solana-mobile-seeker-genesis-holders
```

## Scripts

| Script | Description |
|--------|-------------|
| `bun run dev` | Start API with hot reload |
| `bun run serve` | Start API (production) |
| `bun run index` | Sync latest epochs |
| `bun run index:epoch <N>` | Index a specific epoch |
| `bun run index:all` | Index all epochs |
| `bun run docker:build` | Build Docker image |
| `bun run docker:run` | Run Docker container locally |
| `bun run docker:push` | Push image to GHCR |
| `bun test` | Run tests |
| `bun run lint` | Lint with Biome |
| `bun run check-types` | TypeScript type check |

## License

MIT
# test
