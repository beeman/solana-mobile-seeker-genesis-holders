import { eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { createDb } from './db/index.ts'
import { epochs, holders } from './db/schema.ts'

const db = createDb()
const app = new Hono()

app.get('/', async (c) => {
  const [[countResult], epochData] = await Promise.all([
    db.select({ total: sql<number>`count(*)` }).from(holders),
    db.select().from(epochs).orderBy(epochs.epoch),
  ])
  const totalHolders = countResult?.total ?? 0

  const chartEpochs = epochData.filter((e) => e.holderCount > 0)
  const chartLabels = chartEpochs.map((e) => {
    if (!e.firstBlockTime) return `Epoch ${e.epoch}`
    return new Date(e.firstBlockTime * 1000).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
  })
  const chartData = chartEpochs.map((e) => e.holderCount)
  let cumulative = 0
  const cumulativeData = chartEpochs.map((e) => {
    cumulative += e.holderCount
    return cumulative
  })
  const chartConfig = {
    data: {
      datasets: [
        { backgroundColor: '#22d3ee', data: chartData, label: 'Per epoch', type: 'bar', yAxisID: 'epoch' },
        {
          borderColor: '#a78bfa',
          borderWidth: 2,
          data: cumulativeData,
          fill: false,
          label: 'Total',
          pointRadius: 0,
          type: 'line',
          yAxisID: 'total',
        },
      ],
      labels: chartLabels,
    },
    options: {
      legend: { labels: { fontColor: '#a1a1aa' } },
      scales: {
        xAxes: [{ gridLines: { color: '#27272a' }, ticks: { fontColor: '#a1a1aa' } }],
        yAxes: [
          {
            gridLines: { color: '#27272a' },
            id: 'epoch',
            position: 'left',
            ticks: { beginAtZero: true, fontColor: '#a1a1aa' },
          },
          {
            gridLines: { drawOnChartArea: false },
            id: 'total',
            position: 'right',
            ticks: { beginAtZero: true, fontColor: '#a78bfa' },
          },
        ],
      },
    },
    type: 'bar',
  }
  const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&backgroundColor=%230a0a0a&width=600&height=300`

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Seeker Genesis Holders API</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #e4e4e7; line-height: 1.6; padding: 2rem; }
    .container { max-width: 640px; margin: 0 auto; }
    h1 { font-size: 1.5rem; font-weight: 600; color: #fff; margin-bottom: 0.25rem; }
    .subtitle { color: #a1a1aa; margin-bottom: 2rem; }
    .stat { display: inline-block; background: #18181b; border: 1px solid #27272a; border-radius: 0.5rem; padding: 0.75rem 1rem; margin-bottom: 2rem; }
    .stat-value { font-size: 1.25rem; font-weight: 600; color: #22d3ee; }
    .stat-label { font-size: 0.875rem; color: #a1a1aa; }
    h2 { font-size: 1rem; font-weight: 600; color: #fff; margin-bottom: 0.75rem; margin-top: 1.5rem; }
    .endpoint { background: #18181b; border: 1px solid #27272a; border-radius: 0.5rem; padding: 0.75rem 1rem; margin-bottom: 0.5rem; }
    .method { color: #22d3ee; font-weight: 600; font-size: 0.75rem; margin-right: 0.5rem; }
    .path { font-family: ui-monospace, monospace; font-size: 0.875rem; }
    .path a { color: #e4e4e7; text-decoration: none; }
    .path a:hover { color: #22d3ee; }
    .desc { color: #a1a1aa; font-size: 0.8125rem; margin-top: 0.25rem; }
    footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #27272a; color: #52525b; font-size: 0.8125rem; }
    footer a { color: #a1a1aa; }
    pre { background: #18181b; border: 1px solid #27272a; border-radius: 0.5rem; padding: 1rem; overflow-x: auto; }
    pre code.hljs { background: transparent; padding: 0; font-family: ui-monospace, monospace; font-size: 0.8125rem; line-height: 1.5; }
    .snippet-desc { color: #a1a1aa; font-size: 0.8125rem; margin-bottom: 0.75rem; }
  </style>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css" />
</head>
<body>
  <div class="container">
    <h1>Seeker Genesis Holders API</h1>
    <p class="subtitle">Tracks ownership of Solana Mobile Seeker Genesis NFTs on the Solana blockchain.</p>

    <div class="stat">
      <div class="stat-value">${totalHolders.toLocaleString()}</div>
      <div class="stat-label">indexed holders</div>
    </div>

    <h2>Endpoints</h2>

    <div class="endpoint">
      <div><span class="method">GET</span><span class="path"><a href="/health">/health</a></span></div>
      <div class="desc">Health check &mdash; returns server status and total holder count.</div>
    </div>

    <div class="endpoint">
      <div><span class="method">GET</span><span class="path"><a href="/api/holders">/api/holders</a></span></div>
      <div class="desc">Paginated list of all holders. Query params: <code>page</code> (default 1), <code>limit</code> (default 20, max 100).</div>
    </div>

    <div class="endpoint">
      <div><span class="method">GET</span><span class="path">/api/holders/:wallet</span></div>
      <div class="desc">Look up a specific wallet. Returns mint details or 404 if not a holder.</div>
    </div>

    <div class="endpoint">
      <div><span class="method">GET</span><span class="path"><a href="/api/epochs">/api/epochs</a></span></div>
      <div class="desc">Lists all indexed epochs with holder counts and block time ranges.</div>
    </div>

    <h2>Token gate snippet</h2>
    <p class="snippet-desc">Drop this function into your TypeScript app to check if a wallet holds a Seeker Genesis NFT.</p>
    <pre><code class="language-typescript">import { type Address, assertIsAddress } from "@solana/kit";

const SEEKER_GENESIS_API = "https://seeker-genesis.colmena.dev";

interface SeekerGenesisMint {
  ata: string;
  blockTime: number;
  epoch: number;
  mint: string;
  signature: string;
  slot: string;
}

type SeekerGenesisResult =
  | { isHolder: true; mint: SeekerGenesisMint }
  | { isHolder: false; mint: null };

async function checkSeekerGenesisHolder(
  address: Address | string,
): Promise&lt;SeekerGenesisResult&gt; {
  assertIsAddress(address);
  const response = await fetch(
    \`\${SEEKER_GENESIS_API}/api/holders/\${address}\`,
  ).catch((error) =&gt; {
    throw new Error(
      \`Failed to connect to Seeker Genesis API: \${error}\`,
    );
  });

  if (response.status === 404) {
    return { isHolder: false, mint: null };
  }

  if (!response.ok) {
    throw new Error(
      \`API error: \${response.status} \${response.statusText}\`,
    );
  }

  const { mints } = (await response.json()) as { mints: SeekerGenesisMint[] };

  return mints[0]
    ? { isHolder: true, mint: mints[0] }
    : { isHolder: false, mint: null };
}</code></pre>

    <h2>Holders by epoch</h2>
    <img src="${chartUrl}" alt="Holders by epoch" style="width:100%;border-radius:0.5rem;" />

    <footer>
      Created by <a href="https://github.com/beeman">beeman</a> and <a href="https://github.com/obrera">obrera</a> using Claude &mdash; <a href="https://github.com/beeman/solana-mobile-seeker-genesis-holders">GitHub</a>
    </footer>
  </div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/typescript.min.js"></script>
  <script>hljs.highlightAll();</script>
</body>
</html>`

  return c.html(html)
})

app.get('/health', async (c) => {
  const [countResult] = await db.select({ total: sql<number>`count(*)` }).from(holders)

  return c.json({
    status: 'ok',
    totalHolders: countResult?.total ?? 0,
    uptime: Math.floor(process.uptime()),
  })
})

app.get('/api/holders/:wallet', async (c) => {
  const wallet = c.req.param('wallet')
  const results = await db.select().from(holders).where(eq(holders.holder, wallet))

  if (results.length === 0) {
    return c.json({ error: 'Wallet is not a holder' }, 404)
  }

  return c.json({
    count: results.length,
    holder: wallet,
    mints: results.map((r) => ({
      ata: r.ata,
      blockTime: r.blockTime,
      epoch: r.epoch,
      mint: r.mint,
      signature: r.signature,
      slot: r.slot,
    })),
  })
})

app.get('/api/holders', async (c) => {
  const page = Math.max(1, Number(c.req.query('page') ?? 1))
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 20)))
  const offset = (page - 1) * limit

  const [results, countResult] = await Promise.all([
    db.select().from(holders).orderBy(holders.slot).limit(limit).offset(offset),
    db.select({ total: sql<number>`sum(${epochs.holderCount})` }).from(epochs),
  ])

  const total = countResult[0]?.total ?? 0

  return c.json({
    data: results.map((r) => ({
      ata: r.ata,
      blockTime: r.blockTime,
      epoch: r.epoch,
      holder: r.holder,
      mint: r.mint,
      signature: r.signature,
      slot: r.slot,
    })),
    page,
    pageCount: Math.ceil(total / limit),
    total,
  })
})

app.get('/api/epochs', async (c) => {
  const results = await db.select().from(epochs).orderBy(epochs.epoch)

  return c.json({
    data: results,
    totalHolders: results.reduce((sum, e) => sum + e.holderCount, 0),
  })
})

export default {
  fetch: app.fetch,
  port: Number(Bun.env.PORT ?? 3000),
}
