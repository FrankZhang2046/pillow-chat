import { createFileRoute } from '@tanstack/react-router'
import { env } from '#/lib/env'

const MAX_AGE_SECONDS = 60 * 60 * 24 * 90

function buildAdminCookie(token: string): string {
  const parts = [
    `admin_token=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${MAX_AGE_SECONDS}`,
    'Path=/',
  ]
  if (process.env.NODE_ENV === 'production') parts.push('Secure')
  return parts.join('; ')
}

export const Route = createFileRoute('/api/admin')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!env.ADMIN_TOKEN) {
          return new Response('Not found', { status: 404 })
        }
        const url = new URL(request.url)
        const token = url.searchParams.get('token')
        if (!token || token !== env.ADMIN_TOKEN) {
          return new Response('Not found', { status: 404 })
        }
        return new Response(null, {
          status: 302,
          headers: {
            Location: '/chat',
            'Set-Cookie': buildAdminCookie(env.ADMIN_TOKEN),
          },
        })
      },
    },
  },
})
