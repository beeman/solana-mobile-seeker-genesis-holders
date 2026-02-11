import type { Context, Next } from 'hono'

const UMAMI_HOST_URL = process.env.UMAMI_URL ?? 'https://stats.colmena.dev'
const UMAMI_WEBSITE_ID = process.env.UMAMI_WEBSITE_ID ?? ''
const UMAMI_HOSTNAME = process.env.UMAMI_HOSTNAME ?? 'seeker-genesis.colmena.dev'

const EVENT_ROUTES: [RegExp, string][] = [
  [/^\/api\/holders\/.+$/, 'api-holder-lookup'],
  [/^\/api\/holders$/, 'api-holders-list'],
  [/^\/api\/epochs$/, 'api-epochs-list'],
  [/^\/health$/, 'api-health'],
  [/^\/$/, 'landing-page'],
]

function resolveEventName(path: string): string {
  for (const [pattern, name] of EVENT_ROUTES) {
    if (pattern.test(path)) {
      return name
    }
  }
  return 'api-request'
}

function getClientIp(c: Context): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? ''
}

function sendToUmami(payload: Record<string, unknown>, headers: Record<string, string>) {
  fetch(`${UMAMI_HOST_URL}/api/send`, {
    body: JSON.stringify({ payload, type: 'event' }),
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    method: 'POST',
  }).catch(() => {
    // Silently ignore tracking failures
  })
}

export async function umamiTracking(c: Context, next: Next) {
  if (!UMAMI_WEBSITE_ID) {
    return next()
  }

  const start = Date.now()
  await next()
  const duration = Date.now() - start

  const url = c.req.path
  const clientIp = getClientIp(c)
  const userAgent = c.req.header('user-agent') ?? ''

  const data: Record<string, string | number> = {
    duration,
    method: c.req.method,
    status: c.res.status,
    userAgent,
  }

  const wallet = c.req.param('wallet')
  if (wallet) {
    data.wallet = wallet
  }

  // Call Umami directly so we can forward client IP + user-agent for geo/device detection
  const headers: Record<string, string> = {
    'User-Agent': userAgent,
  }
  if (clientIp) {
    headers['X-Forwarded-For'] = clientIp
  }

  sendToUmami(
    {
      data,
      hostname: UMAMI_HOSTNAME,
      name: resolveEventName(url),
      url,
      website: UMAMI_WEBSITE_ID,
    },
    headers,
  )
}
