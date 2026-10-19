# MaskChat

MaskChat is an anonymous peer-mentorship platform for verified campus communities. Juniors (seekers) are matched with seniors (mentors) by topic tags and chat in real time under a daily-rotating alias. Real identities never reach the other participant, and messages are routed through an ephemeral pipe, not stored as chat history.

## How it works

1. **Institution verification:** a student signs in through institution SSO (OIDC) or a trusted token from an upstream gateway. In development mode, any supported campus email is accepted.
2. **Identity shield:** the student is shown a daily HMAC-derived alias (for example "Coral Otter 42"). A separate stable HMAC key is used internally for bans and rate limits and is never sent to other users.
3. **Tag matching:** a mentor goes available with topic tags, year, expertise and optional capacity (1:1 or a group of up to 5). A seeker requests a match, ranked by tag overlap and then mentor feedback. If no mentor is free, the seeker joins a live queue. Matching is isolated per institution.
4. **Real-time chat:** Socket.IO rooms carry the messages. A refresh can rejoin the session within a short grace period.
5. **Content filter:** every message is checked before delivery for contact details, links, attachments and abusive language, including common evasion tricks.
6. **Session end:** either side can end the session. Seekers can leave anonymous feedback, and either side can report the session, optionally attaching their visible messages as evidence.

## Project layout

```
client/    React 18 + Vite PWA (service worker, manifest, accessibility pass)
server/    Express + Socket.IO API, moderation, storage
client/public/admin/   moderator pages, served with the client build
docs/      Deployment, SSO, security, moderation, disaster recovery, pilot operations
deploy/    nginx config for the high-availability setup
scripts/   Postgres backup/restore/verify, DR smoke test, pilot preflight and snapshot
```

## Quick start (local)

Requires Node 22+ and [pnpm](https://pnpm.io).

```bash
pnpm install && pnpm --dir server install && pnpm --dir client install
pnpm start          # builds the client, then serves everything on http://localhost:3001
```

Sign in with an address ending in `@galgotiacollege.edu.in` (the default institution). Open a second browser session to test real mentor-to-seeker matching, or choose **Try guided demo** for a single-user walkthrough. Demo data appears only in the guided demo.

For client development with hot reload, run `pnpm --dir server dev` and `pnpm --dir client dev` in two terminals.

By default the server runs as one process with all state in memory, so no Redis or Postgres is needed for local use.

## Testing

```bash
pnpm test           # 71 server unit and security-regression tests
pnpm test:e2e       # live Socket.IO end-to-end tests (needs server dev dependencies)
pnpm --dir server loadtest   # Socket.IO load-test harness (see server/loadtest.config.example.env)
```

CI (`.github/workflows/ci.yml`) runs the tests on every push. Before a release, also check the full path in two browsers: sign in, mentor available, seeker matched, messages both ways, refresh and rejoin, end session with feedback, report, a blocked message, and the guided demo.

## Configuration

Copy `server/.env.example` for local settings or `.env.production.example` for deployment. The main settings:

| Variable | Purpose |
|---|---|
| `AUTH_MODE` | `development` (default locally) or `trusted-token` (default in production) |
| `ALIAS_SECRET`, `IDENTITY_VERIFICATION_SECRET`, `OFFENDER_REF_SECRET` | HMAC secrets. Required and strong in production |
| `ADMIN_TOKEN` | Enables `/admin` and `/api/admin/*`. 32+ characters in production, disabled if unset |
| `CLIENT_ORIGIN` | Allowed browser origin(s) for CORS, comma-separated |
| `INSTITUTIONS` | JSON list of colleges served. Default is a single institution |
| `OIDC_*` | Institution SSO. See [docs/SSO.md](docs/SSO.md) |
| `POSTGRES_URL` | Durable storage for reports, bans, feedback, schedules and audit events |
| `REDIS_URL` | Shared realtime state for running multiple instances |
| `TRUST_PROXY`, `REQUIRE_HTTPS`, `COOKIE_SAMESITE` | Reverse-proxy, HTTPS and cookie behavior |
| `PILOT_MODE`, `PILOT_*` | Controlled rollout: user cap, date window, allowed institutions |
| `SLACK_ALERT_WEBHOOK_URL` | Optional operational alerts |
| `VITE_SERVER_URL` | Client build-time URL of the API server, when it is not the same origin |

In production the server refuses to start without a trusted-token or OIDC auth mode, strong secrets and HTTPS.

## Trust and safety

- **Filtering:** emails, Indian mobile numbers, roll-number and social-handle mentions, links, attachments and a small English word list are blocked. This is a first-pass filter, not a guarantee. See [docs/MODERATION.md](docs/MODERATION.md) for the policy and known gaps.
- **Reports and bans:** reports go to a moderator queue at `/admin` with status, assignment and resolution. Offenders are tracked by an opaque reference, with temporary and permanent bans.
- **Abuse protection:** per-identity rate limits and cooldowns, repeat-violation escalation, HTTP body limits and request rate limiting.
- **Privacy:** no names, emails or raw identity keys reach other users. Mentor cards come from an explicit allow-list of fields. Audit events, retention and erase operations are described in [docs/SECURITY-PRIVACY.md](docs/SECURITY-PRIVACY.md).

## Moderator and ops tools

Static pages served at `/admin` (they call the token-gated `/api/admin/*` endpoints with `ADMIN_TOKEN`): reports and offenders, plus the dashboard, institutions, alerts and metrics. Health and readiness probes are `/api/health` and `/api/ready`. Pilot endpoints are `/api/admin/pilot` and `/api/admin/pilot/operations`. Structured JSON logs and an observability snapshot are built in.

## Deployment

| Target | Guide |
|---|---|
| Vercel, two services (client and API) in one project via `vercel.json` | [docs/VERCEL.md](docs/VERCEL.md) |
| Docker Compose with Redis and Postgres, or two instances behind nginx | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) (`docker-compose.yml`, `docker-compose.ha.yml`) |
| Backups, restore and disaster recovery | [docs/DISASTER-RECOVERY.md](docs/DISASTER-RECOVERY.md) |
| Running a controlled student pilot | [docs/PILOT-READINESS.md](docs/PILOT-READINESS.md), [docs/PILOT-OPERATIONS.md](docs/PILOT-OPERATIONS.md) |

Vercel's WebSocket and Services features are in beta, so run a preview deployment first. The Vercel guide also describes a fallback with the server on a persistent host.

## Status

This is a pilot-stage project. It does not claim institutional approval, legal compliance, or a finished campus identity-provider integration. Those are prerequisites for the institution to complete.
