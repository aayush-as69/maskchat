# MaskChat moderation policy (v2 — prototype)

MaskChat connects verified students for anonymous, one-time academic
conversations. Anonymity is the point of the product, but it raises the bar
for how abuse is prevented and handled. This document describes the current
trust & safety model. It is a starting policy for a pilot, not a
finished institutional policy — an actual deployment should have this
reviewed and owned by the institution's student affairs / counseling office.

## What's automatically blocked

Every message is checked before delivery (`server/core.js`):

- Empty messages and messages over 800 characters.
- Contact details and identifiers: email addresses, Indian mobile numbers,
  and mentions of roll numbers / social handles paired with a value.
- A small set of overtly disrespectful words/phrases.

This is a first-pass filter, not a complete one. It will miss creative
evasion (spacing, leetspeak, unicode lookalikes) and it can't judge tone or
context. Treat it as a floor, not a guarantee.

## Rate limits and cooldowns

- Matchmaking actions (`mentor:available`, `match:request`, `demo:start`)
  are capped at 6 per minute per connection.
- Messages are capped at 30 per 10 seconds per connection.
- If a single connection triggers the content filter 3 times within a
  10-minute window, that connection is placed in a 15-minute cooldown: its
  active session(s) are closed, and it can't start a new match, become an
  available mentor, or send messages until the cooldown expires.

These thresholds live in `server/index.js` and are conservative starting
points — tune them once real usage data exists.

## Reporting a session

Either participant can report an active session from the chat screen. This:

1. Immediately ends the session for both participants.
2. Records a report containing: timestamp, reason (from a fixed list),
   optional free-text details from the reporter, the daily aliases of both
   participants, the session's subject tags, and — **only if the reporter
   explicitly opts in** — a copy of the messages visible to them in that
   session.

Message content is **not** captured unless the reporter chooses to include
it. This preserves the "messages vanish when the session ends" promise for
every session that isn't reported, while still giving a moderator enough
context to act on the ones that are.

## Reviewing reports

Reports are visible at `/admin` (a static page served by the backend) once
`ADMIN_TOKEN` is set in the server environment. The page lets a moderator:

- View open and resolved reports, newest first.
- Mark a report resolved once it's been reviewed and actioned.
- Delete a report once it's no longer needed.

There is no automatic notification yet — someone needs to check the page.
For a real deployment, add an alert (e.g. email/Slack webhook) on new
high-severity reports (`safety_concern`) rather than relying on polling.

**Reports are stored wherever the rest of the app's state lives** — in
server memory by default, or in Redis if `REDIS_URL` is set (see
`README.md`, "Running multiple instances"). Neither is a durable database:
the in-memory mode loses everything on restart, and the Redis mode is fast
shared state, not long-term storage. There is no retention policy beyond
"as long as the store stays up." Before handling real reports at scale,
move this to durable, access-controlled storage with an explicit retention
window, and restrict `/admin` and the API to specific staff (the current
single shared token is adequate for a small pilot only).

## Escalation path (to be filled in by the institution)

This prototype does not implement crisis escalation. Before launch, define:

- What a moderator does when a report is tagged `safety_concern` and
  suggests risk of harm to the reporter or someone else.
- Who is on call to review reports, and how quickly.
- Whether/how a report can be connected back to a real identity in a
  genuine emergency (this is in tension with the anonymity model and needs
  an explicit, narrow, documented exception process — not an ad hoc one).

## What counts as a violation

Reportable behavior includes, but isn't limited to:

- Harassment, insults, or hostile language.
- Sexual content or solicitation.
- Attempts to identify or contact the other participant outside the app.
- Sharing content designed to harm, mislead, or exploit another student.
- Anything suggesting a student may be at risk of harm to themselves or
  others — this should be treated as the highest priority to review.

## Known gaps at the end of Phase 2

- No automated detection beyond the keyword/regex filter.
- No moderator notification system — the admin page must be checked manually.
- Cooldowns and rate limits are now keyed off a stable per-email hash rather
  than the socket connection (fixed in Phase 2), so they survive a reconnect
  — but a determined student could still reset by requesting a fresh
  verification with a different email pattern, if the institution's email
  system allows plus-addressing or similar aliasing.
- Single shared admin token, no per-moderator accounts or audit log of who
  resolved what.
- The Redis-backed mode (multiple instances) has no automatic report
  archival — reports accumulate until a moderator deletes them.
- Multi-institution deployments (Phase 5) share a single `ADMIN_TOKEN` and a
  single `/admin` review surface across every configured institution — there
  is no way today to give one institution's moderator visibility into only
  their own reports. If institutions with separate moderation teams are
  onboarded, this should be revisited before it's a real problem rather than
  after.

## Group sessions (Phase 5)

- A report in a group session ends it for every participant. That is deliberate (safety over continuity) but means one bad-faith report can end a group; moderators should look at `otherAliases` and the reporter's optional target before acting.
- The abuse cooldown is per identity, so a participant who trips it is removed from their group room; the rest continue.
- Crisis escalation: in a group, a disclosure is visible to several students, not one mentor. Mentors hosting groups should be briefed to move sensitive disclosures toward the crisis path in this document rather than handling them in front of the group.

## Phase 9 moderation and abuse controls

### English content filtering

The message filter is English-only and normalizes Unicode, punctuation, repeated-letter evasion and common leetspeak. It remains a lightweight rule-based safety floor; it is **not** a semantic toxicity model.

### Escalation workflow

Reports now have three states: `open`, `in_review`, and `resolved`, plus an optional moderator assignment. When a report identifies a current peer, the server records the peer's stable identity key internally and increments a repeat-report counter. Stable identity keys are admin-only and are never exposed to students or used as daily aliases.

Moderators can inspect repeat-offender counts and apply either a temporary ban (bounded to 30 days by the API) or a permanent ban. Bans are checked when identity verification occurs and before messages are sent. Existing sessions should still be ended by the moderator workflow/client when a ban is applied; the server prevents continued messaging and the next verification attempt is rejected.

### Image and link policy

**Attachments are blocked. External links are blocked.** MaskChat is intentionally anonymous, so images, files and links are treated as identity-leak paths rather than normal chat features. The server rejects attachment payloads and URLs/domain-like links before delivery. This policy should remain explicit in the UI: users should be told to keep conversations and resources inside MaskChat rather than exchanging social handles, cloud files or external contact links.
