# Deploying MaskChat on Vercel (multi-service)

The root `vercel.json` defines one Vercel project with two [services](https://vercel.com/docs/services):

| Service | Root | What it is | Public paths |
|---------|------|------------|--------------|
| `web` | `client/` | React + Vite PWA, plus the `/admin` moderator pages (`client/public/admin`) | everything else |
| `api` | `server/` | Express + Socket.IO (`server/index.js`) | `/api/*`, `/socket.io/*` |

Both are on one domain, so the browser talks to the API at the same origin. No `VITE_SERVER_URL`, no CORS setup and no cross-site cookie issues (`COOKIE_SAMESITE` stays `lax`).

> **Beta, and untested here.** Vercel Services and Functions WebSockets are both public beta. This configuration follows their documentation, but it has not been deployed from this repo. Do a preview deployment and run the checks below before a pilot.

## Deploy

1. Import the repo in Vercel (repo root, no Root Directory override). Vercel reads `vercel.json` and builds both services.
2. Add the environment variables below for **Production** (and Preview if you use it).
3. Deploy, then verify.

CLI: `vercel --prod` from the repo root. Local run of both services: `vercel dev`.

## Environment variables

State must live outside the function. Without `REDIS_URL`, matchmaking, rooms and rate limits sit in one instance's memory, and Vercel can run several instances and recycle them. Add Redis (and Postgres for durable reports and bans) from the Vercel Marketplace or any provider.

```env
NODE_ENV=production
AUTH_MODE=trusted-token            # or configure OIDC (see SSO.md)
ALIAS_SECRET=<random>
IDENTITY_VERIFICATION_SECRET=<random>
OFFENDER_REF_SECRET=<random>
ADMIN_TOKEN=<32+ chars>
CLIENT_ORIGIN=https://your-domain.com
TRUST_PROXY=1
REDIS_URL=redis://...              # required on Vercel
POSTGRES_URL=postgres://...        # recommended
```

For OIDC, set `OIDC_POST_LOGIN_REDIRECT=https://your-domain.com` and register `https://your-domain.com/api/auth/oidc/callback` with the identity provider.

## How routing works

Top-level rewrites decide which service receives a request, in order: `/api/*` and `/socket.io/*` go to `api`, everything else goes to `web`. A service receives the original path (`/api/ready` arrives as `/api/ready`), which matches the Express routes. The `web` service rewrites unknown paths to `index.html` for the SPA and sets cache and security headers.

## Changes made for Vercel

- The client opens Socket.IO with `transports: ['websocket']`. Long-polling needs sticky routing, which serverless instances don't guarantee.
- The moderator pages moved from `server/admin/` to `client/public/admin/`, because Vercel ignores `express.static()` in Express functions. They are now served as ordinary static files (and by `express.static(clientDist)` in the Docker setup).

## Things to know

- **Connection lifetime.** WebSocket connections end when the function reaches its maximum duration. The client reconnects and rejoins automatically (`session:rejoin`), and the room survives in Redis during the grace period.
- **Bundle contents.** Vercel bundles the Express app as one function and removes unreferenced files. The server reads no data files at runtime, so nothing extra is needed.
- **Fallback.** If WebSockets on Vercel don't behave under real load, deploy `server/` to a persistent host (Render, Railway, Fly.io; see the root `Dockerfile` and `docs/DEPLOYMENT.md`) and keep only the client on Vercel: set `VITE_SERVER_URL` at build time, `COOKIE_SAMESITE=none` if the domains differ, and remove the `api` service and rewrites from `vercel.json`.

## Verify

- `https://your-domain.com/api/ready` returns OK.
- In DevTools, the Socket.IO connection upgrades to `wss://your-domain.com/socket.io/`, and `maskchat_verification` is sent with it.
- Two browser sessions get a real match, and messages flow both ways.
- Refresh mid-session and confirm the room rejoins.
- `https://your-domain.com/admin/` loads and accepts the `ADMIN_TOKEN`.
