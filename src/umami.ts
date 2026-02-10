import { Umami } from '@umami/node'
import type { Context, Next } from 'hono'

const UMAMI_HOST_URL = process.env.UMAMI_URL ?? 'https://stats.colmena.dev'
const UMAMI_WEBSITE_ID = process.env.UMAMI_WEBSITE_ID ?? ''

const client = UMAMI_WEBSITE_ID
  ? new Umami({
      hostUrl: UMAMI_HOST_URL,
      websiteId: UMAMI_WEBSITE_ID,
    })
  : null

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

export async function umamiTracking(c: Context, next: Next) {
  if (!client) {
    return next()
  }

  const start = Date.now()
  await next()
  const duration = Date.now() - start

  const url = c.req.path

  // Fire and forget — don't block the response
  const data: Record<string, string | number> = {
    duration,
    method: c.req.method,
    status: c.res.status,
    userAgent: c.req.header('user-agent') ?? '',
  }

  const wallet = c.req.param('wallet')
  if (wallet) {
    data.wallet = wallet
  }

  client
    .track({
      data,
      name: resolveEventName(url),
      url,
    })
    .catch(() => {
      // Silently ignore tracking failures
    })
}
