# MaskChat Setup

## Requirements

- Node.js 22+
- pnpm

## Install

```bash
pnpm install
pnpm --dir server install
pnpm --dir client install
```

## Start

```bash
pnpm start
```

For client/server hot reload:

```bash
pnpm --dir server dev
pnpm --dir client dev
```

## Configuration

Copy the server environment example and configure authentication, identity secrets, CORS and optional durable infrastructure.

Important variables include:

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

Production must use trusted-token or OIDC authentication and strong secrets.