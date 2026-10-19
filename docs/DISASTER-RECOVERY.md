# MaskChat Phase 23 — Disaster Recovery & Backups

## Recovery model

PostgreSQL is the system of record. Redis is rebuildable coordination state. A Redis loss may interrupt active sessions/matchmaking, but it must not erase durable moderation, feedback or audit records.

### Default targets

- **RPO:** 24 hours with one scheduled logical PostgreSQL backup per day. Reduce this by running the backup job more frequently or adding managed PostgreSQL PITR/WAL archiving.
- **RTO:** 60 minutes for a documented single-region host/database recovery, subject to infrastructure/provider recovery time.

These are operational targets, not guarantees.

## Backup procedure

Install PostgreSQL client tools on the backup runner and set:

```bash
export POSTGRES_URL='postgres://...'
export BACKUP_DIR='/var/backups/maskchat'
export RETENTION_DAYS=30
./scripts/backup-postgres.sh
```

The script creates a PostgreSQL custom-format dump plus a SHA-256 checksum. Upload the resulting files to a separate storage system using your organization's approved backup tooling. Never put cloud credentials in this repository.

### Scheduling example

Run from cron on a protected backup host:

```cron
15 2 * * * cd /opt/maskchat && POSTGRES_URL='postgres://...' BACKUP_DIR='/var/backups/maskchat' ./scripts/backup-postgres.sh >> /var/log/maskchat-backup.log 2>&1
```

Prefer a secret manager/systemd credential rather than putting the database URL directly into cron on a real deployment.

## Verify backups

```bash
./scripts/verify-backup.sh /var/backups/maskchat/maskchat-YYYYMMDDTHHMMSSZ.dump
```

Verification checks the checksum and reads the PostgreSQL archive catalog.

## Restore drill

1. Provision an isolated PostgreSQL instance.
2. Verify the selected backup.
3. Set `POSTGRES_URL` to the isolated database.
4. Run:

```bash
CONFIRM_RESTORE=YES ./scripts/restore-postgres.sh /var/backups/maskchat/maskchat-YYYYMMDDTHHMMSSZ.dump
```

5. Start MaskChat against the restored database.
6. Run `scripts/dr-smoke-test.sh`.
7. Check admin reports, bans, feedback, schedules and audit entries.
8. Record restore duration and update the RTO if necessary.

Never test a restore directly against the live production database.

## Lost Redis

Recreate Redis and let the application reconnect. Existing durable records remain in PostgreSQL. Active rooms and queues may be interrupted; users can reconnect and establish new sessions. Redis persistence/AOF is useful for reducing interruption but is not the authoritative backup of student data.

## Lost application host

Deploy the last known-good image onto replacement infrastructure, attach the existing/replicated PostgreSQL and Redis services, configure secrets, wait for `/api/ready`, and run the smoke tests before opening traffic.

## Lost database

1. Stop writes/traffic if necessary.
2. Provision a replacement PostgreSQL instance.
3. Restore the newest verified backup.
4. Run schema/readiness checks.
5. Point application instances to the restored database.
6. Verify moderation/audit data.
7. Reopen traffic.

If the organization needs an RPO below the backup interval, use managed PostgreSQL point-in-time recovery/WAL archiving in addition to these logical backups.

## Backup policy

Backups contain sensitive operational data and must have access controls, encryption at rest/in transit, retention rules and deletion procedures consistent with the institution's privacy requirements. Test both backup readability and actual restores regularly.
