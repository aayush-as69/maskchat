# Deploying MaskChat with Vercel

Vercel serverless functions cannot keep WebSocket connections open, and MaskChat's matching
and chat run over Socket.IO. So the deployment is split:

| Part | Where | Why |
|------|-------|-----|
| `client/` (React + Vite PWA) | **Vercel** | Static build, global CDN |
| `server/` (Express + Socket.IO) | **Render / Railway / Fly.io / any container host** | Needs a long-running process |

## 1. Deploy the server (persistent host)

Use the root `Dockerfile` (or `node server/index.js` from `server/`). Set:

```env
NODE_ENV=production
AUTH_MODE=trusted-token            # or configure OIDC (see SSO.md)
CLIENT_ORIGIN=https://your-app.vercel.app   # comma-separate multiple origins
ALIAS_SECRET=<random>
IDENTITY_VERIFICATION_SECRET=<random>
ADMIN_TOKEN=<32+ chars>
TRUST_PROXY=1
```

Add `POSTGRES_URL` and `REDIS_URL` as described in `docs/DEPLOYMENT.md` if you run more than one
instance. Pick a host that supports WebSockets and (for a single instance) sticky sessions are not needed.

### Cookies: same-site vs cross-site

The session is an HttpOnly cookie set by the API.

- **Recommended:** give both halves one registrable domain, e.g. `app.example.com` (Vercel) and
  `api.example.com` (server). Keep the default `COOKIE_SAMESITE=lax`.
- If the client stays on `*.vercel.app` and the API is on another domain, set
  `COOKIE_SAMESITE=None` on the server (forces `Secure`). Browsers that block third-party
  cookies (Safari, Chrome with that setting) will break login in this layout, so prefer the
  custom-domain setup for a real pilot.

For OIDC SSO, set `OIDC_POST_LOGIN_REDIRECT=https://your-app.vercel.app` and register
`https://api.example.com/api/auth/oidc/callback` with the identity provider.

## 2. Deploy the client (Vercel)

1. Import the repo in Vercel. Either option works:
   - **Repo root (default):** the root `vercel.json` installs and builds `client/` and publishes `client/dist`.
   - **Root Directory = `client`:** `client/vercel.json` is used instead (Vite preset, output `dist`).
2. Add environment variable `VITE_SERVER_URL=https://api.example.com` (build-time; redeploy after changing it).
3. Deploy. `vercel.json` handles SPA routing, cache headers for `sw.js`/assets, and security headers.

CLI alternative: run `vercel --prod` from the repo root.

## 3. Verify

- `https://api.example.com/api/ready` returns OK.
- Open the Vercel URL, sign in, and confirm in DevTools that the Socket.IO connection upgrades to
  `wss://api.example.com/socket.io/` and that the `maskchat_verification` cookie is sent.
- Open a second browser session to confirm a real match.

## Not on Vercel

The moderator pages under `server/admin/` are served by the API server (`https://api.example.com/admin`),
not by the Vercel client.
