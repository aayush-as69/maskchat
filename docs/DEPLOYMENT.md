# MaskChat Deployment

## Supported deployment shapes

The repository includes configuration for Vercel-style client/API deployment, Docker Compose with Redis and Postgres, and multiple instances behind nginx.

## Production architecture

For multiple realtime instances, shared Socket.IO state requires Redis. Durable reports, feedback, schedules and audit events use PostgreSQL when configured.

## HTTPS

Production authentication requires HTTPS. Configure the reverse proxy and trusted proxy settings correctly before enabling secure cookies.

## Before institutional rollout

- Complete the institution's OIDC/trusted-token integration.
- Provision strong HMAC secrets.
- Configure durable Postgres storage.
- Configure Redis for multi-instance realtime operation.
- Set strict allowed origins.
- Enable monitoring and backups.
- Run pilot readiness and disaster-recovery checks.
- Complete an independent security/privacy review.

## Status

This repository is pilot-stage software. Deployment configuration is not evidence of institutional approval or production operation.