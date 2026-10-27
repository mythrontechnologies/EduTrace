-- EduTrace durable schema (PostgreSQL 14+). Schema version 1.
--
-- Used by the PostgreSQL store (src/pg-store.js, EDUTRACE_STORE=postgres in development) and applied explicitly with
-- `npm run db -- migrate`. It is never created or seeded automatically. Production mode stays blocked (src/mode.js).
--
-- Conventions
--   * Typed columns are indexed projections of each record. `doc` (jsonb) carries the complete JSON record so the
--     migration is lossless; the application keeps reading the same shape.
--   * Append-only tables (source record versions, audit events, lineage events, decision receipts) reject UPDATE and
--     DELETE with a trigger. Mutable state that belongs to a record (supersession, processing status) lives in its own
--     table so a source record version itself never changes.
--   * `ord` keeps the order of the JSON collections; reconciliation depends on record order.
--   * Raw identifiers stay in `doc` for parity with the JSON store. Before real data: move apaar_id to an encrypted
--     column (pgcrypto with a key from a KMS) and drop it from `doc`.

BEGIN;

CREATE TABLE schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), description text NOT NULL);
CREATE TABLE edutrace_meta (key text PRIMARY KEY, value jsonb NOT NULL);

CREATE TABLE institutions (code text PRIMARY KEY CHECK (code ~ '^[A-Z0-9]{2,12}$'), name text NOT NULL, ord integer NOT NULL, doc jsonb NOT NULL);

-- Who may do what, from trusted identity (see src/auth.js). Empty after migration: the JSON store has no users.
CREATE TABLE memberships (
  issuer text NOT NULL, subject text NOT NULL, display_name text,
  role text NOT NULL CHECK (role IN ('reviewer', 'auditor', 'institution_admin', 'platform_admin')),
  institution_code text REFERENCES institutions(code),           -- NULL = cross-institution (regulator) scope
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, subject, role)
);

CREATE TABLE import_batches (
  id text PRIMARY KEY, institution_code text NOT NULL, source_file text, created_at timestamptz NOT NULL,
  multi_institution boolean NOT NULL DEFAULT false, ord integer NOT NULL, doc jsonb NOT NULL
);
CREATE TABLE import_row_outcomes (
  batch_id text NOT NULL REFERENCES import_batches(id), position integer NOT NULL, source_row integer, outcome text NOT NULL,
  doc jsonb NOT NULL, PRIMARY KEY (batch_id, position)
);

CREATE TABLE source_records (
  id text PRIMARY KEY, institution_code text NOT NULL REFERENCES institutions(code), import_id text REFERENCES import_batches(id),
  source_file text, source_row integer, source_reference text, apaar_fingerprint text, imported_at timestamptz, ord integer NOT NULL, doc jsonb NOT NULL
);
CREATE INDEX source_records_fingerprint ON source_records (apaar_fingerprint) WHERE apaar_fingerprint IS NOT NULL;
CREATE INDEX source_records_institution ON source_records (institution_code);
-- Lineage is assigned on import and the later record's entry changes when a correction is confirmed, so it is kept
-- beside the immutable version row.
CREATE TABLE record_lineage (record_id text PRIMARY KEY REFERENCES source_records(id), lineage_id text NOT NULL, version integer NOT NULL, relation text NOT NULL, doc jsonb NOT NULL);
CREATE INDEX record_lineage_id ON record_lineage (lineage_id, version);
CREATE TABLE record_supersessions (earlier text PRIMARY KEY REFERENCES source_records(id), later text NOT NULL REFERENCES source_records(id), superseded_at timestamptz, doc jsonb NOT NULL);
CREATE TABLE record_processing (record_id text PRIMARY KEY REFERENCES source_records(id), status text NOT NULL, evaluated_at timestamptz, doc jsonb NOT NULL);

CREATE TABLE capacity_rules (ord integer PRIMARY KEY, institution_code text NOT NULL, programme text NOT NULL, academic_session text NOT NULL, permitted_capacity integer NOT NULL, doc jsonb NOT NULL);

CREATE TABLE findings (
  id text PRIMARY KEY, rule_code text NOT NULL, rule_version text, category text, severity text, title text NOT NULL,
  explanation text NOT NULL,                                       -- as raised; never rewritten (src/assessment.js)
  review_status text NOT NULL, lifecycle_status text NOT NULL DEFAULT 'current', condition_key text, superseded_by text,
  created_at timestamptz, ord integer NOT NULL, doc jsonb NOT NULL
);
CREATE INDEX findings_current ON findings (condition_key) WHERE lifecycle_status = 'current';
CREATE TABLE finding_evidence (finding_id text NOT NULL REFERENCES findings(id), position integer NOT NULL, record_id text NOT NULL REFERENCES source_records(id), PRIMARY KEY (finding_id, position));

CREATE TABLE audit_events (
  id text PRIMARY KEY, finding_id text REFERENCES findings(id), action text NOT NULL, actor text NOT NULL, at timestamptz NOT NULL,
  system boolean NOT NULL DEFAULT false, receipt_id text, ord integer NOT NULL, doc jsonb NOT NULL
);

CREATE TABLE identity_links (
  id text PRIMARY KEY, link_key text NOT NULL, evidence_key text, method text NOT NULL, outcome text NOT NULL, policy_version text NOT NULL,
  group_key text, finding_id text, ord integer NOT NULL, doc jsonb NOT NULL
);
CREATE TABLE identity_link_records (link_id text NOT NULL REFERENCES identity_links(id), position integer NOT NULL, record_id text NOT NULL REFERENCES source_records(id), PRIMARY KEY (link_id, position));
CREATE TABLE identity_link_events (ord integer PRIMARY KEY, at timestamptz NOT NULL, action text NOT NULL, doc jsonb NOT NULL);

CREATE TABLE match_decisions (slot text PRIMARY KEY, link_id text, decision text NOT NULL, reviewer text NOT NULL, at timestamptz NOT NULL, receipt_id text, ord integer NOT NULL, doc jsonb NOT NULL);
CREATE TABLE correction_candidates (
  id text PRIMARY KEY, institution_code text NOT NULL, earlier text NOT NULL REFERENCES source_records(id), later text NOT NULL REFERENCES source_records(id),
  status text NOT NULL, created_at timestamptz, decided_at timestamptz, receipt_id text, ord integer NOT NULL, doc jsonb NOT NULL
);
CREATE TABLE lineage_events (id text PRIMARY KEY, action text NOT NULL, earlier text, later text, at timestamptz NOT NULL, ord integer NOT NULL, doc jsonb NOT NULL);

CREATE TABLE notifications (id text PRIMARY KEY, created_at timestamptz NOT NULL, origin text, batch_id text, institution_code text, acknowledged jsonb, ord integer NOT NULL, doc jsonb NOT NULL);
CREATE TABLE notification_items (notification_id text NOT NULL REFERENCES notifications(id), position integer NOT NULL, finding_id text, doc jsonb NOT NULL, PRIMARY KEY (notification_id, position));
CREATE TABLE notification_registry (key text PRIMARY KEY, doc jsonb NOT NULL);
CREATE TABLE automation_runs (ord integer PRIMARY KEY, at timestamptz NOT NULL, origin text, doc jsonb NOT NULL);

CREATE TABLE decision_receipts (
  receipt_id text PRIMARY KEY, kind text NOT NULL, decided_at timestamptz NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'), ord integer NOT NULL, doc jsonb NOT NULL
);
-- Consent recorded per student lineage and purpose (append-only history; the latest entry is the current status).
CREATE TABLE consent_records (
  id text PRIMARY KEY, lineage_id text NOT NULL, institution_code text NOT NULL, purpose text NOT NULL, status text NOT NULL CHECK (status IN ('granted', 'withdrawn')),
  recorded_by text NOT NULL, recorded_at timestamptz NOT NULL, ord integer NOT NULL, doc jsonb NOT NULL
);
CREATE INDEX consent_records_lineage ON consent_records (lineage_id, purpose, recorded_at);

-- Local accounts for institution sign-in (src/accounts.js). Passwords are stored only as scrypt hashes.
CREATE TABLE app_users (
  username text PRIMARY KEY CHECK (username ~ '^[a-z0-9._-]{3,64}$'), display_name text NOT NULL, password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('reviewer', 'auditor', 'institution_admin', 'platform_admin')), institution_code text REFERENCES institutions(code),
  disabled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);

-- Simulations are never saved today. If retention is wanted later, runs live here, apart from the audit history.
CREATE TABLE simulation_runs (
  id uuid PRIMARY KEY, run_by text NOT NULL, record_id text REFERENCES source_records(id), field text NOT NULL,
  evaluated_as_of timestamptz NOT NULL, report jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);

CREATE FUNCTION edutrace_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER source_records_append_only BEFORE UPDATE OR DELETE ON source_records FOR EACH ROW EXECUTE FUNCTION edutrace_append_only();
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION edutrace_append_only();
CREATE TRIGGER lineage_events_append_only BEFORE UPDATE OR DELETE ON lineage_events FOR EACH ROW EXECUTE FUNCTION edutrace_append_only();
CREATE TRIGGER decision_receipts_append_only BEFORE UPDATE OR DELETE ON decision_receipts FOR EACH ROW EXECUTE FUNCTION edutrace_append_only();
CREATE TRIGGER consent_records_append_only BEFORE UPDATE OR DELETE ON consent_records FOR EACH ROW EXECUTE FUNCTION edutrace_append_only();

INSERT INTO schema_migrations (version, description) VALUES (1, 'Initial EduTrace schema');
COMMIT;
