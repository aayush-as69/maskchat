# MaskChat Phase 22 — Deployment & High Availability

## Target topology

```text
Internet / institution IdP
          |
      TLS LB/CDN
          |
        nginx
       /     \
 maskchat-1  maskchat-2
       \     /
        Redis + PostgreSQL
```

The application instances are stateless with respect to durable records. Redis carries realtime/ephemeral coordination and PostgreSQL is the durable source of truth for reports, bans, feedback, schedules and audit data.

## Production requirements

1. Put TLS termination in front of the deployment. Set `REQUIRE_HTTPS=1` and `TRUST_PROXY=1` when TLS terminates at a trusted proxy.
2. Use real secrets for `POSTGRES_PASSWORD`, `ADMIN_TOKEN`, `ALIAS_SECRET`, `IDENTITY_VERIFICATION_SECRET`, and `OFFENDER_REF_SECRET`.
3. Set an exact `CLIENT_ORIGIN` rather than `*`.
4. Use the institution's authenticated identity provider to issue the short-lived verification token expected by `AUTH_MODE=trusted-token`.
5. Do not expose Postgres or Redis to the public Internet.
6. Store backups outside the host running PostgreSQL.
7. Monitor `/api/ready`, not just `/api/health`, for traffic eligibility.

## Start the two-instance topology

```bash
cp .env.production.example .env
# edit .env with real values

docker compose -f docker-compose.ha.yml up -d --build
```

Check:

```bash
curl -fsS http://localhost/api/health
curl -fsS http://localhost/api/ready
```

For real deployment, replace the example HTTP nginx edge with the institution/cloud TLS edge or mount certificates and configure HTTPS in nginx.

## Rolling deployment

Build the new image, start one replacement instance, wait for `/api/ready`, shift traffic, then retire the old instance. Never remove all healthy instances at once. The Node server now stops accepting new connections on SIGTERM and waits for the HTTP server to close before releasing Redis/Postgres resources.

## Scaling

All application instances must point at the same Redis and PostgreSQL services. Socket.IO uses the Redis adapter when `REDIS_URL` is configured. Do not use memory-only storage for a multi-instance deployment.

## Readiness vs liveness

- `/api/health`: process liveness; should not restart a healthy process merely because a dependency is temporarily unavailable.
- `/api/ready`: dependency readiness; load balancers should remove an unready instance from rotation.

## Rollback

Keep the previous application image available. If the new release fails smoke tests, stop routing to it and restore the previous image. Database changes should remain backward-compatible or have an explicit migration/rollback plan before rollout.
