import { createHash } from 'node:crypto';
import { types } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { analysisId, analysisString, validateAnalysisScope, type AnalysisScope } from '../../../../shared/analysisRoom';
import { CAPTURE_STORAGE_LIMITS, validateCaptureStorageLimits } from './CaptureStorage';
import { TYPED_STAGE_DDL, TYPED_STAGE_FINGERPRINT, type TypedStageBinding } from './CaptureTypedStageSchema';
import { capacityPolicyV2, type CapacityPolicyV2 } from './CaptureCapacityPolicyV2';
export class RequestKeyError extends Error {
    constructor(readonly code: string) { super(code); }
}
export function fail(code: string): never { throw new RequestKeyError(code); }
export const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
export function stable(v: unknown): string { if (v === null || typeof v !== 'object')
    return JSON.stringify(v); if (Array.isArray(v))
    return '[' + v.map(stable).join(',') + ']'; const o = v as Record<string, unknown>; return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + stable(o[k])).join(',') + '}'; }
export const bytes = (v: unknown) => Buffer.byteLength(stable(v));
export function own(v: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> { if (!v || typeof v !== 'object' || types.isProxy(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v)))
    fail('KEY_INPUT_INVALID'); const keys = Reflect.ownKeys(v); if (keys.length > required.length + optional.length || keys.some(k => typeof k !== 'string' || ![...required, ...optional].includes(k)))
    fail('KEY_INPUT_INVALID'); const out: Record<string, unknown> = {}; for (const k of keys) {
    const d = Object.getOwnPropertyDescriptor(v, k)!;
    if (!d.enumerable || !('value' in d))
        fail('KEY_INPUT_INVALID');
    out[k as string] = d.value;
} if (required.some(k => !Object.hasOwn(out, k)))
    fail('KEY_INPUT_INVALID'); return out; }
export function nat(v: unknown, min = 0): number { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min)
    fail('KEY_INPUT_INVALID'); return v; }
export function text(v: unknown, max: number): string { try {
    const s = analysisString(v, max);
    for (let n = 0; n < s.length; n++) {
        const c = s.charCodeAt(n);
        if (c >= 0xd800 && c <= 0xdbff) {
            const next = s.charCodeAt(++n);
            if (!(next >= 0xdc00 && next <= 0xdfff))
                fail('KEY_INPUT_INVALID');
        }
        else if (c >= 0xdc00 && c <= 0xdfff)
            fail('KEY_INPUT_INVALID');
    }
    return s;
}
catch {
    return fail('KEY_INPUT_INVALID');
} }
export function digest(v: unknown): string { if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v))
    fail('KEY_INPUT_INVALID'); return v; }
export function scope(v: unknown): AnalysisScope { const x = own(v, ['accountId', 'platform', 'source']); try {
    return validateAnalysisScope(x);
}
catch {
    return fail('KEY_INPUT_INVALID');
} }
export function add(...values: number[]): number { const n = values.reduce((a, b) => a + b, 0); if (!Number.isSafeInteger(n) || n < 0)
    fail('KEY_COUNTER_INVALID'); return n; }
export interface RequestKeyBinding {
    base: TypedStageBinding;
    policy: Readonly<CapacityPolicyV2>;
}
export function normalized(input: unknown): RequestKeyBinding {
    const v = own(input, ['base', 'policy']), b = own(v.base, ['identity', 'runId', 'manifestDigest', 'limits', 'policy']), i = own(b.identity, ['databaseId', 'generation', 'schemaVersion']), l = own(b.limits, Object.keys(CAPTURE_STORAGE_LIMITS)), p = own(b.policy, ['version', 'roleModuleDigest', 'metadataModuleDigest', 'stagedReaderContractDigest', 'ordinalPolicy', 'normalizationTimestamp', 'limitsDigest', 'metadataBytes', 'decodedNodes', 'decodedDepth', 'maxRowMutations', 'maxEncodedBytes', 'maxByteWork']);
    if (i.schemaVersion !== 1)
        fail('KEY_INPUT_INVALID');
    let id: string, runId: string, limits: ReturnType<typeof validateCaptureStorageLimits>, policy: Readonly<CapacityPolicyV2>;
    try {
        id = analysisId(i.databaseId);
        runId = analysisId(b.runId);
        limits = validateCaptureStorageLimits(l);
        policy = capacityPolicyV2(v.policy);
    }
    catch {
        return fail('KEY_INPUT_INVALID');
    }
    for (const [k, value] of Object.entries({ version: 1, ordinalPolicy: 'source-id-v1', metadataBytes: 131072, decodedNodes: 8192, decodedDepth: 16, maxRowMutations: 128, maxEncodedBytes: 1048576, maxByteWork: 1048576 }))
        if (p[k] !== value)
            fail('KEY_INPUT_INVALID');
    nat(p.normalizationTimestamp);
    for (const k of ['roleModuleDigest', 'metadataModuleDigest', 'stagedReaderContractDigest', 'limitsDigest'])
        digest(p[k]);
    if (p.limitsDigest !== hash(stable(limits)))
        fail('KEY_BINDING_CONFLICT');
    return { base: { identity: { databaseId: id, generation: nat(i.generation, 1), schemaVersion: 1 }, runId, manifestDigest: digest(b.manifestDigest), limits, policy: Object.freeze(p) as unknown as TypedStageBinding['policy'] }, policy };
}
export const BASE_NAMES = Object.freeze(['capture_rows_scope', 'original_rows_session', 'sessions_ordinal', 'sessions_scope', 'capture_rows', 'database_meta', 'field_entries', 'legacy_chunks', 'legacy_import_meta', 'legacy_lines', 'legacy_sources', 'operation_receipts', 'original_rows', 'sessions', 'capture_rows_immutable_delete', 'capture_rows_immutable_update', 'legacy_chunks_no_delete', 'legacy_chunks_no_update', 'legacy_lines_no_delete', 'legacy_lines_no_update', 'legacy_sources_no_delete', 'legacy_sources_no_identity_update', 'original_rows_immutable_delete', 'original_rows_immutable_update', 'receipts_immutable_delete', 'receipts_immutable_update']);
export const normalizeSql = (s: string) => s.replace(/\bIF NOT EXISTS\b/gi, '').replace(/\s+/g, ' ').trim().replace(/;$/, '');
export const definitions = (ddl: string) => [...(ddl.match(/CREATE (?:TABLE|(?:UNIQUE )?INDEX) [^;]+;/g) ?? []), ...(ddl.match(/CREATE TRIGGER [\s\S]*? END;/g) ?? [])].map(sql => { const m = normalizeSql(sql).match(/^CREATE (?:UNIQUE )?(TABLE|INDEX|TRIGGER) (\w+)/)!; return Object.freeze({ type: m[1].toLowerCase(), name: m[2], sql: normalizeSql(sql) }); });
export const REQUEST_KEY_DDL = `CREATE TABLE legacy_metadata_request_header(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),kind TEXT NOT NULL CHECK(kind='request-keys'),version INTEGER NOT NULL CHECK(version=1),
 database_id TEXT NOT NULL CHECK(length(database_id)=36),generation INTEGER NOT NULL CHECK(generation>=1),base_run_id TEXT NOT NULL UNIQUE CHECK(length(base_run_id)=36),manifest_digest TEXT NOT NULL CHECK(length(manifest_digest)=64),base_header_digest TEXT NOT NULL CHECK(length(base_header_digest)=64),
 policy_json TEXT NOT NULL CHECK(json_valid(policy_json) AND length(CAST(policy_json AS BLOB))<=16384),policy_digest TEXT NOT NULL CHECK(length(policy_digest)=64),schema_fingerprint TEXT NOT NULL CHECK(length(schema_fingerprint)=64),
 schema_complete INTEGER NOT NULL CHECK(schema_complete=0),activation_allowed INTEGER NOT NULL CHECK(activation_allowed=0)
) STRICT;
CREATE TABLE legacy_metadata_request_run(
 base_run_id TEXT PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision>=0 AND revision<=9007199254740991),
 watermark INTEGER NOT NULL CHECK(watermark=revision),receipt_count INTEGER NOT NULL CHECK(receipt_count=revision),
 key_count INTEGER NOT NULL CHECK(key_count>=0 AND key_count<=revision),key_ordinal INTEGER NOT NULL CHECK(key_ordinal=key_count),
 immutable_bytes INTEGER NOT NULL CHECK(immutable_bytes>=0 AND immutable_bytes<=9007199254740991),mutable_bytes INTEGER NOT NULL CHECK(mutable_bytes>=0 AND mutable_bytes<=9007199254740991),
 last_operation_id TEXT CHECK(last_operation_id IS NULL OR length(last_operation_id) BETWEEN 1 AND 256),FOREIGN KEY(base_run_id) REFERENCES legacy_metadata_request_header(base_run_id),
 CHECK((revision=0 AND last_operation_id IS NULL) OR (revision>0 AND last_operation_id IS NOT NULL))
) STRICT;
CREATE TABLE legacy_metadata_request_keys(
 account_id TEXT NOT NULL CHECK(length(account_id) BETWEEN 1 AND 200),request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 128),
 base_run_id TEXT NOT NULL,ordinal INTEGER NOT NULL UNIQUE CHECK(ordinal>=1 AND ordinal<=9007199254740991),
 action TEXT NOT NULL CHECK(action IN('start','stop','reanalyze')),request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
 created_at INTEGER NOT NULL CHECK(created_at>=0 AND created_at<=9007199254740991),scope_known INTEGER NOT NULL CHECK(scope_known IN(0,1)),platform TEXT CHECK(platform IS NULL OR platform IN('douyin','buyin','eos','xiaohongshu','pgy','wxchannel','kuaishou','taobao','tiktok','dev')),source TEXT CHECK(source IS NULL OR source IN('control','compass')),
 source_id INTEGER,start_offset INTEGER,next_offset INTEGER,item_ordinal INTEGER,source_sha256 TEXT,
 PRIMARY KEY(account_id,request_id),UNIQUE(account_id,request_id,ordinal),
 FOREIGN KEY(base_run_id) REFERENCES legacy_metadata_request_header(base_run_id),FOREIGN KEY(source_id) REFERENCES legacy_sources(id),
 CHECK((scope_known=0 AND platform IS NULL AND source IS NULL AND source_id IS NOT NULL) OR (scope_known=1 AND platform IS NOT NULL AND source IS NOT NULL)),
 CHECK((source_id IS NULL AND start_offset IS NULL AND next_offset IS NULL AND item_ordinal IS NULL AND source_sha256 IS NULL) OR
 (source_id IS NOT NULL AND start_offset IS NOT NULL AND next_offset IS NOT NULL AND item_ordinal IS NOT NULL AND source_id>=1 AND start_offset=0 AND next_offset>0 AND next_offset<=131072 AND item_ordinal>=0 AND source_sha256 IS NOT NULL AND length(source_sha256)=64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'))
) STRICT;
CREATE TABLE legacy_metadata_request_receipts(
 operation_id TEXT PRIMARY KEY CHECK(length(operation_id) BETWEEN 1 AND 256),base_run_id TEXT NOT NULL,intent_digest TEXT NOT NULL CHECK(length(intent_digest)=64 AND intent_digest NOT GLOB '*[^0-9a-f]*'),
 expected_revision INTEGER NOT NULL CHECK(expected_revision>=0 AND expected_revision<9007199254740991),result_revision INTEGER NOT NULL UNIQUE CHECK(result_revision=expected_revision+1),
 predecessor_revision INTEGER,account_id TEXT NOT NULL CHECK(length(account_id) BETWEEN 1 AND 200),request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 1 AND 128),key_ordinal INTEGER NOT NULL,
 receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB))<=8192),
 receipt_digest TEXT NOT NULL CHECK(length(receipt_digest)=64 AND receipt_digest NOT GLOB '*[^0-9a-f]*'),
 FOREIGN KEY(base_run_id) REFERENCES legacy_metadata_request_header(base_run_id),FOREIGN KEY(account_id,request_id,key_ordinal) REFERENCES legacy_metadata_request_keys(account_id,request_id,ordinal),
 FOREIGN KEY(predecessor_revision) REFERENCES legacy_metadata_request_receipts(result_revision),
 CHECK((expected_revision=0 AND predecessor_revision IS NULL) OR (expected_revision>0 AND predecessor_revision=expected_revision))
) STRICT;
CREATE INDEX legacy_metadata_request_account ON legacy_metadata_request_keys(account_id,ordinal);
CREATE INDEX legacy_metadata_request_scope ON legacy_metadata_request_keys(account_id,scope_known,ordinal);
CREATE TRIGGER legacy_metadata_request_header_update BEFORE UPDATE ON legacy_metadata_request_header BEGIN SELECT RAISE(ABORT,'REQUEST_HEADER_IMMUTABLE'); END;
CREATE TRIGGER legacy_metadata_request_header_delete BEFORE DELETE ON legacy_metadata_request_header BEGIN SELECT RAISE(ABORT,'REQUEST_HEADER_IMMUTABLE'); END;
CREATE TRIGGER legacy_metadata_request_key_update BEFORE UPDATE ON legacy_metadata_request_keys BEGIN SELECT RAISE(ABORT,'REQUEST_KEY_IMMUTABLE'); END;
CREATE TRIGGER legacy_metadata_request_key_delete BEFORE DELETE ON legacy_metadata_request_keys BEGIN SELECT RAISE(ABORT,'REQUEST_KEY_IMMUTABLE'); END;
CREATE TRIGGER legacy_metadata_request_receipt_update BEFORE UPDATE ON legacy_metadata_request_receipts BEGIN SELECT RAISE(ABORT,'REQUEST_RECEIPT_IMMUTABLE'); END;
CREATE TRIGGER legacy_metadata_request_receipt_delete BEFORE DELETE ON legacy_metadata_request_receipts BEGIN SELECT RAISE(ABORT,'REQUEST_RECEIPT_IMMUTABLE'); END;
CREATE TRIGGER legacy_metadata_request_run_delete BEFORE DELETE ON legacy_metadata_request_run BEGIN SELECT RAISE(ABORT,'REQUEST_RUN_IMMUTABLE'); END;
CREATE TRIGGER legacy_metadata_request_run_guard BEFORE UPDATE ON legacy_metadata_request_run WHEN NEW.base_run_id<>OLD.base_run_id OR NEW.revision<>OLD.revision+1 OR NEW.key_count<OLD.key_count OR NEW.key_count>OLD.key_count+1 OR NEW.immutable_bytes<OLD.immutable_bytes BEGIN SELECT RAISE(ABORT,'REQUEST_RUN_INVALID'); END;`;
export const OWN_DEFINITIONS = Object.freeze(definitions(REQUEST_KEY_DDL)), TYPED_DEFINITIONS = Object.freeze(definitions(TYPED_STAGE_DDL)), SCHEMA_FINGERPRINT = hash(normalizeSql(REQUEST_KEY_DDL));
export function catalog(db: DatabaseSync, extended: boolean): number { const defs = extended ? [...TYPED_DEFINITIONS, ...OWN_DEFINITIONS] : TYPED_DEFINITIONS, wanted = [...BASE_NAMES, ...defs.map(x => x.name)], scalar = db.prepare("SELECT type,substr(name,1,129) name,length(CAST(name AS BLOB)) n,length(CAST(sql AS BLOB)) b FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name LIMIT ?").all(wanted.length + 1); if (scalar.length !== wanted.length || scalar.some(r => typeof r.name !== 'string' || !wanted.includes(r.name) || typeof r.b !== 'number' || r.b < 1 || r.b > 32768 || Number(r.n) > 128))
    fail('KEY_SCHEMA_INVALID'); let work = bytes(scalar); const base: string[] = []; for (const r of scalar) {
    work = add(work, Number(r.b));
    if (work > 1048576)
        fail('KEY_SCHEMA_INVALID');
    const row = db.prepare('SELECT substr(sql,1,32769) sql FROM sqlite_master WHERE type=? AND name=?').get(r.type, r.name);
    if (typeof row?.sql !== 'string')
        fail('KEY_SCHEMA_INVALID');
    const sql = normalizeSql(row.sql);
    if (BASE_NAMES.includes(String(r.name)))
        base.push(`${r.type}|${r.name}|${sql}\n`);
    else if (!defs.some(d => d.name === r.name && d.type === r.type && d.sql === sql))
        fail('KEY_SCHEMA_INVALID');
} if (hash(base.join('')) !== '76817cee32be166ef95b0fb3d30f68177e9095bacdc297525d0afe94caba867d')
    fail('KEY_SCHEMA_INVALID'); return work; }
export function baseHeader(db: DatabaseSync, b: RequestKeyBinding): {
    header: Record<string, string>;
    work: number;
} { const rows = db.prepare('SELECT key,length(CAST(value AS BLOB)) n FROM legacy_typed_meta ORDER BY key LIMIT 19').all(), header: Record<string, string> = {}; if (rows.length !== 18 || rows.some(r => typeof r.key !== 'string' || typeof r.n !== 'number' || r.n > 16384))
    fail('KEY_BINDING_CONFLICT'); for (const r of rows) {
    const v = db.prepare('SELECT substr(value,1,16385) value FROM legacy_typed_meta WHERE key=?').get(r.key)?.value;
    if (typeof v !== 'string')
        fail('KEY_BINDING_CONFLICT');
    header[String(r.key)] = v;
} const wanted = { kind: 'legacy-typed', version: '1', capability: 'session-metadata-v1', schema_complete: '0', activation_allowed: '0', physical_stage_version: '1', database_id: b.base.identity.databaseId, generation: String(b.base.identity.generation), run_id: b.base.runId, manifest_digest: b.base.manifestDigest, policy_digest: hash(stable(b.base.policy)), policy_json: stable(b.base.policy), limits_json: stable(b.base.limits), schema_fingerprint: TYPED_STAGE_FINGERPRINT }; for (const [k, v] of Object.entries(wanted))
    if (header[k] !== v)
        fail('KEY_BINDING_CONFLICT'); for (const k of ['source_count', 'source_bytes', 'source_high_water_id', 'bootstrap_encoded_bytes'])
    if (!/^(0|[1-9]\d*)$/.test(header[k]) || !Number.isSafeInteger(Number(header[k])))
        fail('KEY_BINDING_CONFLICT'); if (bytes(header) > 16384)
    fail('KEY_BINDING_CONFLICT'); return { header, work: bytes(header) }; }
