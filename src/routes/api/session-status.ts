import { createFileRoute } from '@tanstack/react-router'
import { isAdmin } from '#/lib/session'

export const Route = createFileRoute('/api/session-status')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        return new Response(JSON.stringify({ isAdmin: isAdmin(request) }), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          },
        })
      },
    },
  },
})
