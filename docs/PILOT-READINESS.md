# MaskChat Institution Pilot Readiness

This turns the production infrastructure into a controlled, measurable student pilot. It does not claim institutional approval, legal compliance, or a completed campus IdP integration; those remain prerequisites owned by the institution.

## Controlled rollout

Enable with:

```env
PILOT_MODE=1
PILOT_MAX_ACTIVE_USERS=100
PILOT_ALLOWED_INSTITUTIONS=galgotias
PILOT_START_AT=2026-10-01T09:00:00+05:30
PILOT_END_AT=2026-10-31T18:00:00+05:30
PILOT_SUPPORT_CONTACT=student-support@example.edu
```

Access is denied outside the configured window or for institutions not listed in `PILOT_ALLOWED_INSTITUTIONS`. Active verified sockets are counted per institution using the shared store; reaching the configured cap blocks new verification attempts without exposing identity information.

## Before opening the pilot

- [ ] Institution has approved the moderation/escalation policy.
- [ ] Production IdP/gateway issues short-lived trusted verification tokens.
- [ ] `AUTH_MODE=trusted-token` and strong secrets are configured through the deployment secret manager.
- [ ] PostgreSQL and Redis are reachable from every app instance.
- [ ] Postgres backups run on schedule and a restore drill has been completed.
- [ ] TLS is terminated at the institution/cloud edge and `TRUST_PROXY=1` is correct.
- [ ] Moderator accounts/tokens are distributed through an approved process.
- [ ] Support contact is monitored during pilot hours.
- [ ] At least one moderator is assigned for every enabled institution.
- [ ] Pilot capacity is sized for the agreed cohort.
- [ ] `/api/ready`, `/api/admin/observability`, and `/api/admin/pilot` have been checked.
- [ ] Security regression and load tests have passed in staging.

## During the pilot

Track aggregate metrics only: active users, matching success/queueing, message-block rate, reports, report resolution time, errors and latency. Do not export message transcripts or raw identity keys for analytics.

Safety escalation should take precedence over engagement metrics. A spike in reports, repeated moderation violations, authentication failures, or infrastructure instability is a reason to pause onboarding while the incident is reviewed.

## Stop / pause gates

Pause the pilot when any of the following is true:

1. Institutional authentication cannot reliably establish membership.
2. Cross-institution isolation is suspected to be broken.
3. Moderation reports cannot be reviewed or routed.
4. Backups or restore verification are failing.
5. Privacy-sensitive data appears in logs or analytics.
6. Sustained error/latency alerts exceed the staging-approved thresholds.
7. The institution's support/escalation owner is unavailable.

## End of pilot

Export only approved aggregate metrics, run the configured retention job, archive the operational report, and disable `PILOT_MODE`. Do not retain student identity exports merely because the pilot ended.
