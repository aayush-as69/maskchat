# MaskChat Security & Privacy Checklist

## Security hardening
- Production fails closed without strong secrets and trusted institutional verification.
- Development `/api/auth/preview` is disabled outside development mode.
- Trusted verification tokens are short-lived HMAC-signed tokens.
- Admin tokens use constant-time comparison.
- HTTP JSON bodies are capped and requests are rate-limited per source IP.
- Socket.IO frames are capped at 64 KiB.
- Identity verification attempts are throttled.
- HTTPS is required in production.
- Security headers are applied to HTTP responses.
- Socket room handlers continue to verify room membership before actions.
- Institution filtering remains enforced during matchmaking.

## Privacy/anonymity audit
- Peer-visible identity remains the daily alias.
- Stable identity keys are never sent to peers.
- Admin report/offender APIs expose `offenderRef`, not the stable key.
- Logs use `shortHash()` rather than raw identity/email values.
- Mentor cards remain allow-listed and contain no email, identity key, or real name.
- Private takeaways remain client-local.
- Arbitrary links and attachments remain blocked.
- Report transcripts are opt-in and sanitized/capped.
- Institution identifiers are used for isolation and operations, not peer display.

## Phase 16 — durable storage boundary

- [x] PostgreSQL stores reports, offender counts, bans, feedback and scheduling records.
- [x] Redis remains ephemeral/realtime rather than the sole source of truth for moderation data.
- [x] Production fails closed without `POSTGRES_URL`.
- [x] Database schema contains no raw campus-email column.
- [x] PostgreSQL uses parameterized queries through `pg`.

## Phase 17 — audit and retention

- [x] Moderator actions have durable audit events.
- [x] Audit records use opaque references rather than raw stable identity keys.
- [x] Configurable report/audit/feedback retention is applied daily.
- [x] Admin can trigger retention manually.
- [x] Admin can erase durable identity-linked records through an opaque offender reference.

## Phase 18 — abuse controls

- [x] HTTP request limits use the shared store in Redis deployments.
- [x] Matching/availability, report filing and feedback each have separate abuse windows.
- [x] Message violations escalate to longer cooldowns with a 24-hour ceiling.
- [x] Existing ban checks remain enforced at identity verification and mentor availability.
- [x] Socket.IO and HTTP payload limits remain enabled.
