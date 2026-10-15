# MaskChat Phase 25 — Pilot Operations & Validation

Phase 25 turns the controlled rollout from Phase 24 into an operating workflow for a real, limited student cohort.

## Operating endpoints

All `/api/admin/*` routes require the existing admin token.

- `GET /api/admin/pilot/operations` — checklist, pilot KPIs, active operational alerts, incidents, and exit assessment.
- `POST /api/admin/pilot/incidents` — record a pilot incident.
- `POST /api/admin/pilot/incidents/:id/transition` — move an incident from `open` → `contained` → `resolved`.

Incident examples:

```json
{
  "severity": "high",
  "category": "moderation",
  "summary": "Multiple students report the same mentor session behavior",
  "institutionId": "galgotias"
}
```

## Before opening the cohort

Complete every required item returned by `/api/admin/pilot/operations`:

1. Institution authentication verified.
2. Moderator coverage and escalation contact confirmed.
3. Latest PostgreSQL backup verified.
4. Recent restore drill completed.
5. Operational alerts tested.
6. Capacity and load-test thresholds reviewed.
7. Student support route published.
8. Privacy/retention policy reviewed with the institution.

## During the pilot

- Review the operations snapshot at least once per moderator shift.
- Investigate every high/critical incident before the next shift handoff.
- Use `contained` when an issue is controlled but the underlying cause still needs work.
- Use `resolved` only after the operator has recorded the remediation in the incident transition.
- Keep institution-specific incidents scoped to the affected institution.
- Do not put student names, email addresses, phone numbers, or message transcripts into incident summaries.

## Stop/hold gates

Pause new pilot access or escalate to the institution if:

- a critical incident remains unresolved;
- a high-severity incident cannot be contained;
- operational alert thresholds remain active;
- authentication or institution isolation is uncertain;
- the backing database or backup process is unhealthy;
- moderators cannot maintain the required response coverage.

The exit assessment intentionally returns `hold` when a critical/high incident is unresolved or when operational alert conditions remain. It also reports `hold` when no pilot traffic has been recorded yet; this prevents declaring a successful pilot without actual usage evidence.

## Pilot KPIs

The operations endpoint reports aggregate values only:

- connections
- matches attempted/succeeded and success rate
- messages sent/blocked and block rate
- reports filed
- verified pilot users
- pilot access denials

No raw student identity keys are included.

## End-of-pilot review

When the cohort ends, export the final operations snapshot and audit events, review unresolved incidents, run the documented retention/backup procedures, and record the institution's decision:

- expand the cohort,
- repeat a controlled pilot,
- remediate and re-test, or
- retire the pilot.

Phase 25 deliberately does not auto-promote a pilot to general availability. Expansion remains an explicit institution/operator decision.
