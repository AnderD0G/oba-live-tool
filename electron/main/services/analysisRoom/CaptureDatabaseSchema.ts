import type { DatabaseSync } from 'node:sqlite'
import type { CaptureDatabaseIdentity } from './CaptureStorage'
import { analysisId } from '../../../../shared/analysisRoom'

export const CAPTURE_SCHEMA_VERSION = 1

export class CaptureSchemaError extends Error {
  constructor(
    readonly code: 'SCHEMA_VERSION_UNSUPPORTED' | 'SCHEMA_IDENTITY_MISMATCH' | 'SCHEMA_INVALID',
  ) {
    super(code)
  }
}

const PRAGMAS = [
  'PRAGMA foreign_keys = ON',
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = FULL',
  'PRAGMA cache_size = -8192',
  'PRAGMA mmap_size = 0',
  'PRAGMA temp_store = FILE',
]

const SCHEMA = `
CREATE TABLE IF NOT EXISTS database_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  source TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  status TEXT NOT NULL,
  complete INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  stopped_at INTEGER,
  room_id TEXT,
  format_version INTEGER NOT NULL,
  mapping_version INTEGER,
  reason TEXT,
  received INTEGER NOT NULL,
  saved INTEGER NOT NULL,
  dropped INTEGER NOT NULL,
  pending INTEGER NOT NULL,
  parse_failed INTEGER NOT NULL,
  redacted INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  original_received INTEGER NOT NULL,
  original_saved INTEGER NOT NULL,
  original_dropped INTEGER NOT NULL,
  original_pending INTEGER NOT NULL,
  original_bytes INTEGER NOT NULL,
  original_redacted INTEGER NOT NULL,
  original_error TEXT,
  has_originals INTEGER NOT NULL CHECK(has_originals IN(0,1)),
  live_sequence INTEGER NOT NULL,
  field_complete INTEGER NOT NULL,
  last_shard TEXT,
  last_line INTEGER NOT NULL DEFAULT 0,
  last_offset INTEGER NOT NULL DEFAULT 0,
  UNIQUE(id,account_id,platform,source)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS sessions_ordinal ON sessions(ordinal);
CREATE INDEX IF NOT EXISTS sessions_scope ON sessions(account_id, platform, source, ordinal);

CREATE TABLE IF NOT EXISTS capture_rows (
  physical_position INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  source TEXT NOT NULL,
  record_sequence INTEGER NOT NULL,
  validation_status TEXT NOT NULL,
  record_line BLOB NOT NULL,
  received_at INTEGER NOT NULL,
  format_version INTEGER NOT NULL,
  provenance TEXT,
  complete INTEGER NOT NULL,
  shard TEXT NOT NULL,
  line_number INTEGER NOT NULL,
  next_offset INTEGER NOT NULL,
  source_id TEXT,
  source_offset INTEGER,
  FOREIGN KEY (session_id,account_id,platform,source) REFERENCES sessions(id,account_id,platform,source),
  UNIQUE(physical_position,session_id),
  UNIQUE(source_id,source_offset)
) STRICT;

CREATE INDEX IF NOT EXISTS capture_rows_scope ON capture_rows(session_id, account_id, platform, source, physical_position);

CREATE TABLE IF NOT EXISTS original_rows (
  physical_position INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  original_sequence INTEGER NOT NULL,
  original_line BLOB NOT NULL,
  original_json BLOB NOT NULL,
  original_json_sha256 TEXT NOT NULL,
  protobuf_base64 TEXT,
  FOREIGN KEY (physical_position,session_id) REFERENCES capture_rows(physical_position,session_id)
) STRICT;

CREATE INDEX IF NOT EXISTS original_rows_session ON original_rows(session_id, physical_position);

CREATE TABLE IF NOT EXISTS operation_receipts (
  operation_id TEXT PRIMARY KEY,
  input_digest TEXT NOT NULL,
  physical_position INTEGER NOT NULL,
  commit_watermark INTEGER NOT NULL,
  session_snapshot TEXT NOT NULL,
  FOREIGN KEY (physical_position) REFERENCES capture_rows(physical_position)
) STRICT;

CREATE TRIGGER IF NOT EXISTS capture_rows_immutable_update BEFORE UPDATE ON capture_rows BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CAPTURE'); END;
CREATE TRIGGER IF NOT EXISTS capture_rows_immutable_delete BEFORE DELETE ON capture_rows BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CAPTURE'); END;
CREATE TRIGGER IF NOT EXISTS original_rows_immutable_update BEFORE UPDATE ON original_rows BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ORIGINAL'); END;
CREATE TRIGGER IF NOT EXISTS original_rows_immutable_delete BEFORE DELETE ON original_rows BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ORIGINAL'); END;
CREATE TRIGGER IF NOT EXISTS receipts_immutable_update BEFORE UPDATE ON operation_receipts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECEIPT'); END;
CREATE TRIGGER IF NOT EXISTS receipts_immutable_delete BEFORE DELETE ON operation_receipts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECEIPT'); END;

CREATE TABLE IF NOT EXISTS field_entries (
  session_id TEXT NOT NULL,
  path TEXT NOT NULL,
  count INTEGER NOT NULL,
  types TEXT NOT NULL,
  examples TEXT NOT NULL,
  PRIMARY KEY (session_id, path),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
) STRICT;
`

function readMeta(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM database_meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value
}

function writeMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    'INSERT INTO database_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value)
}

function validateStoredSchema(db: DatabaseSync): void {
  const definitions = [
    ...(SCHEMA.match(/CREATE (?:TABLE|(?:UNIQUE )?INDEX) IF NOT EXISTS [^;]+;/g) ?? []),
    ...(SCHEMA.match(/CREATE TRIGGER IF NOT EXISTS [\s\S]*? END;/g) ?? []),
  ]
  const normalize = (sql: string) =>
    sql
      .replace(/\bIF NOT EXISTS\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/;$/, '')
  const get = db.prepare('SELECT sql FROM sqlite_master WHERE name=? AND type=?')
  for (const sql of definitions) {
    const name = sql.match(/IF NOT EXISTS (\w+)/)![1]
    const type = sql.startsWith('CREATE TABLE')
      ? 'table'
      : sql.startsWith('CREATE TRIGGER')
        ? 'trigger'
        : 'index'
    const stored = get.get(name, type) as { sql: string } | undefined
    if (!stored || normalize(stored.sql) !== normalize(sql))
      throw new CaptureSchemaError('SCHEMA_INVALID')
  }
}

export function initializeCaptureSchema(db: DatabaseSync, identity: CaptureDatabaseIdentity): void {
  if (
    !identity ||
    typeof identity.databaseId !== 'string' ||
    !identity.databaseId ||
    !Number.isSafeInteger(identity.generation) ||
    identity.generation < 1 ||
    identity.schemaVersion !== CAPTURE_SCHEMA_VERSION
  )
    throw new CaptureSchemaError('SCHEMA_VERSION_UNSUPPORTED')
  analysisId(identity.databaseId)
  const existing = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='database_meta'")
    .get()
  if (existing) {
    const storedVersion = readMeta(db, 'schema_version')
    if (storedVersion !== undefined && storedVersion !== String(CAPTURE_SCHEMA_VERSION))
      throw new CaptureSchemaError('SCHEMA_VERSION_UNSUPPORTED')
    const storedId = readMeta(db, 'database_id')
    if (storedId !== undefined && storedId !== identity.databaseId)
      throw new CaptureSchemaError('SCHEMA_IDENTITY_MISMATCH')
    const storedGeneration = readMeta(db, 'generation')
    if (storedGeneration !== undefined && storedGeneration !== String(identity.generation))
      throw new CaptureSchemaError('SCHEMA_IDENTITY_MISMATCH')
    for (const key of [
      'schema_version',
      'database_id',
      'generation',
      'commit_watermark',
      'session_ordinal',
      'total_logical_bytes',
    ]) {
      const value = readMeta(db, key)
      if (
        value === undefined ||
        (key !== 'database_id' &&
          (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))))
      )
        throw new CaptureSchemaError('SCHEMA_INVALID')
    }
    validateStoredSchema(db)
    for (const pragma of PRAGMAS) db.exec(pragma)
    return
  }
  if (db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get())
    throw new CaptureSchemaError('SCHEMA_INVALID')
  for (const pragma of PRAGMAS) db.exec(pragma)
  // Identity and every DDL statement publish together; a failed first open can
  // retry without a partially initialized authority header.
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(SCHEMA)
    writeMeta(db, 'schema_version', String(CAPTURE_SCHEMA_VERSION))
    writeMeta(db, 'database_id', identity.databaseId)
    writeMeta(db, 'generation', String(identity.generation))
    writeMeta(db, 'commit_watermark', '0')
    writeMeta(db, 'session_ordinal', '0')
    writeMeta(db, 'total_logical_bytes', '0')
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {}
    throw error
  }
}
