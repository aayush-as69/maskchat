# MaskChat

**Anonymous peer mentorship for verified campus communities.**

MaskChat connects seekers with mentors by topic while keeping participants' real identities hidden from each other. The system combines institution-facing authentication, derived public aliases, topic matching, realtime Socket.IO sessions and moderation controls.

## How it works

```text
Institution authentication
        ↓
Identity shield
        ↓
Topic matching
        ↓
Realtime session
        ↓
Moderation + feedback
        ↓
Session end
```

### Core capabilities

| Area | Capability |
|---|---|
| Identity | Institution-facing auth with server-side identity separation |
| Privacy | Daily public aliases; stable internal identity references stay private |
| Matching | Topic overlap, mentor availability, feedback and queueing |
| Chat | Socket.IO realtime rooms with short rejoin grace period |
| Moderation | Contact/link/attachment/abuse filtering before delivery |
| Reports | Moderator queue, offender references, temporary/permanent bans |
| Feedback | Anonymous session feedback |
| Operations | Health/readiness, admin controls and structured operational data |

## Project structure

| Path | Purpose |
|---|---|
| client/ | React 18 + Vite PWA |
| server/ | Express + Socket.IO API, matching and moderation |
| docs/ | Technical, security and deployment documentation |
| deploy/ | Reverse-proxy/deployment configuration |
| scripts/ | Backup, restore, verification and pilot tooling |

## Quick start

Requirements: Node.js 22+ and pnpm.

```bash
pnpm install
pnpm --dir server install
pnpm --dir client install
pnpm start
```

Open the configured local server URL.

For client/server hot reload:

```bash
pnpm --dir server dev
pnpm --dir client dev
```

## Configuration

Important settings include:

- AUTH_MODE
- ALIAS_SECRET
- IDENTITY_VERIFICATION_SECRET
- OFFENDER_REF_SECRET
- ADMIN_TOKEN
- CLIENT_ORIGIN
- INSTITUTIONS
- OIDC_*
- POSTGRES_URL
- REDIS_URL
- REQUIRE_HTTPS

Production must use trusted-token or OIDC authentication, strong secrets and HTTPS.

## Trust and safety

- Real identities are not exposed to the other participant.
- Public aliases and internal identity references use separate secrets.
- Messages are filtered before delivery.
- Reports and bans use opaque internal offender references.
- Rate limits and cooldowns reduce abuse.
- Admin endpoints are token-gated.

The content filter is heuristic and is not a guarantee against every evasion technique.

## Testing

```bash
pnpm test
pnpm test:e2e
```

Release smoke testing should cover authentication, mentor availability, matching, anonymous aliases, realtime messaging, refresh/rejoin, session end, feedback, reports, blocked content and moderator review.

## Deployment

The repository contains deployment guidance for Vercel-style client/API hosting, Docker Compose with Redis/Postgres and multiple instances behind nginx.

For multi-instance realtime operation, shared Socket.IO state requires Redis. Durable reports, feedback, schedules and audit events use PostgreSQL when configured.

Before institutional rollout, complete the institution's OIDC/trusted-token integration, durable storage, monitoring, backups, pilot readiness checks and an independent security/privacy review.

## Documentation

| Guide | Purpose |
|---|---|
| [Documentation index](docs/README.md) | Complete documentation map |
| [Architecture](docs/ARCHITECTURE.md) | Identity, matching and realtime design |
| [Setup](docs/SETUP.md) | Local configuration |
| [Security](docs/SECURITY.md) | Privacy and abuse boundaries |
| [Moderation](docs/MODERATION.md) | Filtering, reports and bans |
| [Testing](docs/TESTING.md) | Automated and manual verification |
| [Deployment](docs/DEPLOYMENT.md) | Production topology |

## Status

**Pilot-stage project.**

This repository is the original MaskChat implementation. The newer MaskChat-MERN repository is the current rebuilt portfolio version where the two differ.