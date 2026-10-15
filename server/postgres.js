import crypto from 'node:crypto';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS maskchat_reports (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','in_review','resolved')),
  assigned_to TEXT,
  institution_id TEXT,
  room_id TEXT,
  reported_identity_key TEXT,
  payload JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS maskchat_reports_created_idx ON maskchat_reports(created_at DESC);
CREATE INDEX IF NOT EXISTS maskchat_reports_institution_idx ON maskchat_reports(institution_id, created_at DESC);
CREATE INDEX IF NOT EXISTS maskchat_reports_status_idx ON maskchat_reports(status, created_at DESC);

CREATE TABLE IF NOT EXISTS maskchat_offenders (
  identity_key TEXT PRIMARY KEY,
  report_count INTEGER NOT NULL DEFAULT 0,
  first_reported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_reported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS maskchat_bans (
  identity_key TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('temporary','permanent')),
  until_at TIMESTAMPTZ,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  assigned_to TEXT
);
CREATE INDEX IF NOT EXISTS maskchat_bans_until_idx ON maskchat_bans(until_at);

CREATE TABLE IF NOT EXISTS maskchat_feedback (
  identity_key TEXT PRIMARY KEY,
  up_count INTEGER NOT NULL DEFAULT 0,
  down_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS maskchat_schedules (
  identity_key TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS maskchat_scheduled_sessions (
  id TEXT PRIMARY KEY,
  mentor_identity_key TEXT,
  seeker_identity_key TEXT,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS maskchat_scheduled_sessions_mentor_idx ON maskchat_scheduled_sessions(mentor_identity_key);
CREATE INDEX IF NOT EXISTS maskchat_scheduled_sessions_seeker_idx ON maskchat_scheduled_sessions(seeker_identity_key);

CREATE TABLE IF NOT EXISTS maskchat_audit_events (
  id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL DEFAULT 'system',
  actor_ref TEXT,
  target_ref TEXT,
  institution_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS maskchat_audit_created_idx ON maskchat_audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS maskchat_audit_type_idx ON maskchat_audit_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS maskchat_audit_institution_idx ON maskchat_audit_events(institution_id, created_at DESC);
`;

function json(value) { return JSON.stringify(value ?? null); }
function fromJson(value, fallback = null) { return value == null ? fallback : (typeof value === 'string' ? JSON.parse(value) : value); }
function dateMs(value) { return value ? new Date(value).getTime() : null; }

export async function createPostgresStore({ url, ssl = false, max = 10 } = {}) {
  if (!url) throw new Error('POSTGRES_URL is required.');
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: url, max, ssl: ssl ? { rejectUnauthorized: false } : undefined });
  await pool.query(SCHEMA_SQL);

  return {
    kind: 'postgres',
    async close() { await pool.end(); },
    async ping() { const result = await pool.query('SELECT 1 AS ok'); return result.rows[0]?.ok === 1; },

    async setReport(id, data) {
      await pool.query(`INSERT INTO maskchat_reports (id, created_at, status, assigned_to, institution_id, room_id, reported_identity_key, payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
        ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, assigned_to=EXCLUDED.assigned_to,
          institution_id=EXCLUDED.institution_id, room_id=EXCLUDED.room_id,
          reported_identity_key=EXCLUDED.reported_identity_key, payload=EXCLUDED.payload`,
        [id, new Date(data.createdAt || Date.now()), data.status || 'open', data.assignedTo || null, data.institutionId || null, data.roomId || null, data.reportedIdentityKey || null, json(data)]);
    },
    async getReport(id) {
      const r = await pool.query('SELECT payload FROM maskchat_reports WHERE id=$1', [id]);
      return r.rows[0] ? fromJson(r.rows[0].payload) : null;
    },
    async listReports() {
      const r = await pool.query('SELECT payload FROM maskchat_reports ORDER BY created_at DESC');
      return r.rows.map((row) => fromJson(row.payload));
    },
    async deleteReport(id) { const r = await pool.query('DELETE FROM maskchat_reports WHERE id=$1', [id]); return r.rowCount > 0; },

    async recordOffenderReport(identityKey, now = Date.now()) {
      if (!identityKey) return 0;
      const r = await pool.query(`INSERT INTO maskchat_offenders(identity_key, report_count, first_reported_at, last_reported_at)
        VALUES($1,1,$2,$2) ON CONFLICT(identity_key) DO UPDATE SET report_count=maskchat_offenders.report_count+1,last_reported_at=EXCLUDED.last_reported_at RETURNING report_count`, [identityKey, new Date(now)]);
      return Number(r.rows[0].report_count);
    },
    async getOffenderReportCount(identityKey) { const r = await pool.query('SELECT report_count FROM maskchat_offenders WHERE identity_key=$1', [identityKey]); return Number(r.rows[0]?.report_count || 0); },
    async listOffenders() { const r = await pool.query('SELECT identity_key AS "identityKey", report_count AS "reportCount" FROM maskchat_offenders ORDER BY report_count DESC'); return r.rows.map((x) => ({ identityKey: x.identityKey, reportCount: Number(x.reportCount) })); },

    async setBan(identityKey, data) {
      await pool.query(`INSERT INTO maskchat_bans(identity_key,type,until_at,reason,created_at,assigned_to) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(identity_key) DO UPDATE SET type=EXCLUDED.type,until_at=EXCLUDED.until_at,reason=EXCLUDED.reason,created_at=EXCLUDED.created_at,assigned_to=EXCLUDED.assigned_to`,
        [identityKey, data.type, data.until ? new Date(data.until) : null, data.reason || null, new Date(data.createdAt || Date.now()), data.assignedTo || null]);
      return true;
    },
    async getBan(identityKey) {
      const r = await pool.query('SELECT type,until_at,reason,created_at,assigned_to FROM maskchat_bans WHERE identity_key=$1', [identityKey]);
      if (!r.rows[0]) return null;
      const row = r.rows[0];
      const until = dateMs(row.until_at);
      if (until && until <= Date.now()) { await pool.query('DELETE FROM maskchat_bans WHERE identity_key=$1', [identityKey]); return null; }
      return { type: row.type, until, reason: row.reason, createdAt: dateMs(row.created_at), assignedTo: row.assigned_to };
    },
    async deleteBan(identityKey) { const r = await pool.query('DELETE FROM maskchat_bans WHERE identity_key=$1', [identityKey]); return r.rowCount > 0; },
    async listBans() {
      const r = await pool.query('SELECT identity_key AS "identityKey",type,until_at,reason,created_at,assigned_to FROM maskchat_bans WHERE until_at IS NULL OR until_at > now()');
      return r.rows.map((x) => ({ identityKey:x.identityKey, type:x.type, until:dateMs(x.until_at), reason:x.reason, createdAt:dateMs(x.created_at), assignedTo:x.assigned_to }));
    },

    async recordFeedback(identityKey, positive) {
      const r = await pool.query(`INSERT INTO maskchat_feedback(identity_key,up_count,down_count,updated_at) VALUES($1,$2,$3,now())
        ON CONFLICT(identity_key) DO UPDATE SET up_count=maskchat_feedback.up_count+$2,down_count=maskchat_feedback.down_count+$3,updated_at=now()
        RETURNING up_count AS up, down_count AS down`, [identityKey, positive ? 1 : 0, positive ? 0 : 1]);
      return { up:Number(r.rows[0].up), down:Number(r.rows[0].down) };
    },
    async getFeedbackStats(identityKey) { const r = await pool.query('SELECT up_count AS up,down_count AS down FROM maskchat_feedback WHERE identity_key=$1',[identityKey]); return { up:Number(r.rows[0]?.up||0),down:Number(r.rows[0]?.down||0) }; },

    async setSchedule(identityKey, data) { await pool.query(`INSERT INTO maskchat_schedules(identity_key,payload,updated_at) VALUES($1,$2::jsonb,now()) ON CONFLICT(identity_key) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()`, [identityKey,json(data)]); },
    async getSchedule(identityKey) { const r=await pool.query('SELECT payload FROM maskchat_schedules WHERE identity_key=$1',[identityKey]); return r.rows[0] ? fromJson(r.rows[0].payload,[]) : []; },
    async setScheduledSession(id,data) { await pool.query(`INSERT INTO maskchat_scheduled_sessions(id,mentor_identity_key,seeker_identity_key,payload,updated_at) VALUES($1,$2,$3,$4::jsonb,now()) ON CONFLICT(id) DO UPDATE SET mentor_identity_key=EXCLUDED.mentor_identity_key,seeker_identity_key=EXCLUDED.seeker_identity_key,payload=EXCLUDED.payload,updated_at=now()`, [id,data.mentorIdentityKey||null,data.seekerIdentityKey||null,json(data)]); },
    async getScheduledSession(id) { const r=await pool.query('SELECT payload FROM maskchat_scheduled_sessions WHERE id=$1',[id]); return r.rows[0] ? fromJson(r.rows[0].payload) : null; },
    async listScheduledSessions(identityKey) { const r=await pool.query('SELECT payload FROM maskchat_scheduled_sessions WHERE mentor_identity_key=$1 OR seeker_identity_key=$1',[identityKey]); return r.rows.map((x)=>fromJson(x.payload)); },
    async deleteScheduledSession(id) { const r=await pool.query('DELETE FROM maskchat_scheduled_sessions WHERE id=$1',[id]); return r.rowCount>0; },

    async audit({ eventType, actorType='system', actorRef=null, targetRef=null, institutionId=null, metadata={} } = {}) {
      const id = crypto.randomUUID();
      await pool.query('INSERT INTO maskchat_audit_events(id,event_type,actor_type,actor_ref,target_ref,institution_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)', [id,eventType,actorType,actorRef,targetRef,institutionId,json(metadata)]);
      return id;
    },
    async listAudit({ limit=100, before=null, eventType=null, institutionId=null } = {}) {
      const values=[]; const where=[];
      if(before){ values.push(new Date(before)); where.push(`created_at < $${values.length}`); }
      if(eventType){ values.push(String(eventType).slice(0,80)); where.push(`event_type = $${values.length}`); }
      if(institutionId){ values.push(String(institutionId).slice(0,80)); where.push(`institution_id = $${values.length}`); }
      values.push(Math.min(500,Math.max(1,Number(limit)||100)));
      const r=await pool.query(`SELECT id,created_at,event_type,actor_type,actor_ref,target_ref,institution_id,metadata FROM maskchat_audit_events ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY created_at DESC LIMIT $${values.length}`,values);
      return r.rows.map((x)=>({id:x.id,createdAt:dateMs(x.created_at),eventType:x.event_type,actorType:x.actor_type,actorRef:x.actor_ref,targetRef:x.target_ref,institutionId:x.institution_id,metadata:x.metadata||{}}));
    },
    async deleteIdentityData(identityKey) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const reports = await client.query('DELETE FROM maskchat_reports WHERE reported_identity_key=$1', [identityKey]);
        const [feedback, schedule, sessions, offender, ban] = await Promise.all([
          client.query('DELETE FROM maskchat_feedback WHERE identity_key=$1', [identityKey]),
          client.query('DELETE FROM maskchat_schedules WHERE identity_key=$1', [identityKey]),
          client.query('DELETE FROM maskchat_scheduled_sessions WHERE mentor_identity_key=$1 OR seeker_identity_key=$1', [identityKey]),
          client.query('DELETE FROM maskchat_offenders WHERE identity_key=$1', [identityKey]),
          client.query('DELETE FROM maskchat_bans WHERE identity_key=$1', [identityKey])
        ]);
        await client.query('COMMIT');
        return { reports: reports.rowCount, feedback: feedback.rowCount, schedule: schedule.rowCount, sessions: sessions.rowCount, offender: offender.rowCount, ban: ban.rowCount };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async retention({ reportDays=90, auditDays=365, feedbackDays=180 } = {}) {
      const reportCutoff = new Date(Date.now()-reportDays*86400000);
      const auditCutoff = new Date(Date.now()-auditDays*86400000);
      const feedbackCutoff = new Date(Date.now()-feedbackDays*86400000);
      const [reports,audit,feedback]=await Promise.all([
        pool.query('DELETE FROM maskchat_reports WHERE created_at < $1',[reportCutoff]),
        pool.query('DELETE FROM maskchat_audit_events WHERE created_at < $1',[auditCutoff]),
        pool.query('DELETE FROM maskchat_feedback WHERE updated_at < $1',[feedbackCutoff])
      ]);
      return { reports:reports.rowCount,audit:audit.rowCount,feedback:feedback.rowCount };
    }
  };
}

export const POSTGRES_SCHEMA = SCHEMA_SQL;
