Welcome to your new TanStack Start app! 

# Getting Started

To run this application:

```bash
pnpm install
pnpm dev
```

# Building For Production

To build this application for production:

```bash
pnpm build
```

# Admin Backdoor

Personal bypass for the sole operator. Skips rate limits, doesn't persist messages, tags the session `is_admin=true` so demand-signal queries can exclude it. Intentionally minimal — the token is checked as a plain string against `env.ADMIN_TOKEN`.

## Setup (one-time)

1. Add a token to `.env`:
   ```
   ADMIN_TOKEN=pillowchat
   ```
   Any string works. Avoid guessable values (`admin`, `password`, `test`) — bots scan common route names and dictionaries. `/api/admin` returns 404 on wrong tokens so it looks like the route doesn't exist.
2. Apply the `is_admin` column migration if not already:
   ```bash
   pnpm db:up && pnpm db:migrate
   ```
3. Restart `pnpm dev` so the server picks up the new env var.

## Log in

Visit in a browser:
```
http://localhost:3000/api/admin?token=pillowchat
```
Server verifies, sets an `HttpOnly` `admin_token` cookie (90-day lifetime), redirects to `/chat`. The header shows an amber `ADMIN` pill in place of the message counter. Hover the pill for a reminder of what admin mode does.

## Log out / revoke

- **This browser only:** DevTools → Application → Cookies → delete `admin_token`.
- **Everywhere at once:** rotate `ADMIN_TOKEN` in `.env` (change the value), restart the server. All existing admin cookies stop matching.

## What the backdoor changes at runtime

| Where | Behavior |
|---|---|
| `src/lib/rate-limit.ts` | `checkRateLimits` short-circuits `{ ok: true }` — no session or IP limits |
| `src/routes/api/chat.ts` | Skips `messages` inserts (user + assistant), skips `message_count` bump, skips `message_sent` event |
| `sessions.is_admin` | Flipped to `true` on the first admin chat request (idempotent) |
| `src/routes/chat.tsx` | Fetches `/api/session-status` on mount, shows amber `ADMIN` badge |

`sessions.last_seen_at` is still updated (harmless), and `service_error` events still fire on upstream failures (operator visibility, filtered from analytics via `is_admin`).

## Disabling entirely

Leave `ADMIN_TOKEN` unset or empty. `/api/admin` returns 404 for every request, and `isAdmin(request)` returns `false` regardless of cookie contents.

## Data-analysis pattern

All demand-signal queries should exclude admin sessions:
```sql
SELECT ... FROM sessions WHERE is_admin = false ...
```

## Prod (VPS)

Same flow, but `ADMIN_TOKEN` lives in `/etc/companion-bot.env` (per 009 deployment plan). After editing it: `sudo systemctl restart companion-bot`. Bookmark `https://<your-domain>/api/admin?token=<value>` for one-click admin login.

**Honest caveat:** token in a GET query string ends up in Nginx access logs, browser history, and any Referer chain. Fine for smoke-test stakes; rotate the token if that's ever a concern.

## Testing

This project uses [Vitest](https://vitest.dev/) for testing. You can run the tests with:

```bash
pnpm test
```

## Styling

This project uses [Tailwind CSS](https://tailwindcss.com/) for styling.

### Removing Tailwind CSS

If you prefer not to use Tailwind CSS:

1. Remove the demo pages in `src/routes/demo/`
2. Replace the Tailwind import in `src/styles.css` with your own styles
3. Remove `tailwindcss()` from the plugins array in `vite.config.ts`
4. Uninstall the packages: `pnpm add @tailwindcss/vite tailwindcss --dev`


## Deploy with Nitro

This project uses Nitro as a generic server adapter, so it can run on any Node-compatible host.

```bash
npm run build
node dist/server/index.mjs
```

The build output is a self-contained Node server. To deploy, push the `dist/` directory to your host (Render, Fly.io, your own VPS, etc.) and run the server command above.

For host-specific presets (Vercel, Netlify, Cloudflare, AWS Lambda, etc.) and tuning, see https://v3.nitro.build/deploy.



## Routing

This project uses [TanStack Router](https://tanstack.com/router) with file-based routing. Routes are managed as files in `src/routes`.

### Adding A Route

To add a new route to your application just add a new file in the `./src/routes` directory.

TanStack will automatically generate the content of the route file for you.

Now that you have two routes you can use a `Link` component to navigate between them.

### Adding Links

To use SPA (Single Page Application) navigation you will need to import the `Link` component from `@tanstack/react-router`.

```tsx
import { Link } from "@tanstack/react-router";
```

Then anywhere in your JSX you can use it like so:

```tsx
<Link to="/about">About</Link>
```

This will create a link that will navigate to the `/about` route.

More information on the `Link` component can be found in the [Link documentation](https://tanstack.com/router/v1/docs/framework/react/api/router/linkComponent).

### Using A Layout

In the File Based Routing setup the layout is located in `src/routes/__root.tsx`. Anything you add to the root route will appear in all the routes. The route content will appear in the JSX where you render `{children}` in the `shellComponent`.

Here is an example layout that includes a header:

```tsx
import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'My App' },
    ],
  }),
  shellComponent: ({ children }) => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <header>
          <nav>
            <Link to="/">Home</Link>
            <Link to="/about">About</Link>
          </nav>
        </header>
        {children}
        <Scripts />
      </body>
    </html>
  ),
})
```

More information on layouts can be found in the [Layouts documentation](https://tanstack.com/router/latest/docs/framework/react/guide/routing-concepts#layouts).

## Server Functions

TanStack Start provides server functions that allow you to write server-side code that seamlessly integrates with your client components.

```tsx
import { createServerFn } from '@tanstack/react-start'

const getServerTime = createServerFn({
  method: 'GET',
}).handler(async () => {
  return new Date().toISOString()
})

// Use in a component
function MyComponent() {
  const [time, setTime] = useState('')
  
  useEffect(() => {
    getServerTime().then(setTime)
  }, [])
  
  return <div>Server time: {time}</div>
}
```

## API Routes

You can create API routes by using the `server` property in your route definitions:

```tsx
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'

export const Route = createFileRoute('/api/hello')({
  server: {
    handlers: {
      GET: () => json({ message: 'Hello, World!' }),
    },
  },
})
```

## Data Fetching

There are multiple ways to fetch data in your application. You can use TanStack Query to fetch data from a server. But you can also use the `loader` functionality built into TanStack Router to load the data for a route before it's rendered.

For example:

```tsx
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/people')({
  loader: async () => {
    const response = await fetch('https://swapi.dev/api/people')
    return response.json()
  },
  component: PeopleComponent,
})

function PeopleComponent() {
  const data = Route.useLoaderData()
  return (
    <ul>
      {data.results.map((person) => (
        <li key={person.name}>{person.name}</li>
      ))}
    </ul>
  )
}
```

Loaders simplify your data fetching logic dramatically. Check out more information in the [Loader documentation](https://tanstack.com/router/latest/docs/framework/react/guide/data-loading#loader-parameters).

# Demo files

Files prefixed with `demo` can be safely deleted. They are there to provide a starting point for you to play around with the features you've installed.

# Learn More

You can learn more about all of the offerings from TanStack in the [TanStack documentation](https://tanstack.com).

For TanStack Start specific documentation, visit [TanStack Start](https://tanstack.com/start).
