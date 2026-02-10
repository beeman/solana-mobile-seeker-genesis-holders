import type { Context, Next } from 'hono'

const UMAMI_URL = process.env.UMAMI_URL ?? 'https://stats.colmena.dev'
const UMAMI_WEBSITE_ID = process.env.UMAMI_WEBSITE_ID ?? ''
const UMAMI_HOST = process.env.UMAMI_HOST ?? 'seeker-genesis.colmena.dev'

export async function umamiTracking(c: Context, next: Next) {
  if (!UMAMI_WEBSITE_ID) {
    return next()
  }

  const start = Date.now()
  await next()
  const duration = Date.now() - start

  // Fire and forget — don't block the response
  fetch(`${UMAMI_URL}/api/send`, {
    body: JSON.stringify({
      payload: {
        data: {
          duration,
          method: c.req.method,
          status: c.res.status,
          userAgent: c.req.header('user-agent') ?? '',
        },
        hostname: UMAMI_HOST,
        language: '',
        referrer: c.req.header('referer') ?? '',
        screen: '',
        title: '',
        url: c.req.path,
        website: UMAMI_WEBSITE_ID,
      },
      type: 'event',
    }),
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Seeker Genesis API' },
    method: 'POST',
  }).catch(() => {
    // Silently ignore tracking failures
  })
}
