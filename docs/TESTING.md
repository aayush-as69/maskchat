# MaskChat Testing

## Automated tests

```bash
pnpm test
```

The server test suite covers health behavior, protected routes, CSRF/security controls and matching-related behavior.

## End-to-end

```bash
pnpm test:e2e
```

Use a running test environment and the required server dependencies.

## Manual release path

1. Institution authentication.
2. Mentor availability.
3. Seeker matching.
4. Anonymous aliases.
5. Bidirectional realtime messaging.
6. Refresh and session rejoin.
7. Session end.
8. Feedback.
9. Report flow.
10. Blocked contact/link/abuse content.
11. Moderator review.
12. Admin health/readiness.

## Test boundary

Local tests do not prove institutional SSO integration, production Redis/Postgres behavior or deployment-provider reliability.