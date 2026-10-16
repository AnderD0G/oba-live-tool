import type { DatabaseSync } from 'node:sqlite';
import { readTypedStageAdmission } from './CaptureTypedStageSchema';
import { REQUEST_KEY_DDL, SCHEMA_FINGERPRINT, baseHeader, catalog, normalized, stable, hash, bytes, fail, nat, add, type RequestKeyBinding } from './CaptureMetadataRequestDefinition';
import { decodeRequestKeyReceipt } from './CaptureMetadataRequestReceipt';
export interface Run {
    base_run_id: string;
    revision: number;
    watermark: number;
    receipt_count: number;
    key_count: number;
    key_ordinal: number;
    immutable_bytes: number;
    mutable_bytes: number;
    last_operation_id: string | null;
}
function durability(db: DatabaseSync) { if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1 || db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal' || db.prepare('PRAGMA synchronous').get()?.synchronous !== 2)
    fail('KEY_DURABILITY_INVALID'); }
function parent(db: DatabaseSync, b: RequestKeyBinding) { for (const [k, v] of [['database_id', b.base.identity.databaseId], ['generation', String(b.base.identity.generation)], ['schema_version', '1']])
    if (db.prepare('SELECT substr(value,1,65) value FROM database_meta WHERE key=?').get(k)?.value !== v)
        fail('KEY_BINDING_CONFLICT'); for (const [k, v] of [['version', '1'], ['status', 'verified'], ['inventory_complete', '1']])
    if (db.prepare('SELECT substr(value,1,33) value FROM legacy_import_meta WHERE key=?').get(k)?.value !== v)
        fail('KEY_SOURCE_INVALID'); }
function expected(b: RequestKeyBinding, h: Record<string, string>) { return { singleton: 1, kind: 'request-keys', version: 1, database_id: b.base.identity.databaseId, generation: b.base.identity.generation, base_run_id: b.base.runId, manifest_digest: b.base.manifestDigest, base_header_digest: hash(stable(h)), policy_json: stable(b.policy), policy_digest: hash(stable(b.policy)), schema_fingerprint: SCHEMA_FINGERPRINT, schema_complete: 0, activation_allowed: 0 }; }
export function readRun(db: DatabaseSync, b: RequestKeyBinding): Run { const r = db.prepare('SELECT * FROM legacy_metadata_request_run WHERE base_run_id=?').get(b.base.runId); if (!r)
    fail('KEY_COUNTER_INVALID'); for (const k of ['revision', 'watermark', 'receipt_count', 'key_count', 'key_ordinal', 'immutable_bytes', 'mutable_bytes']) {
    try {
        nat(r[k]);
    }
    catch {
        fail('KEY_COUNTER_INVALID');
    }
} if (r.revision !== r.watermark || r.revision !== r.receipt_count || r.key_count !== r.key_ordinal || Number(r.key_count) > Number(r.revision) || (r.revision === 0 ? r.last_operation_id !== null : typeof r.last_operation_id !== 'string'))
    fail('KEY_COUNTER_INVALID'); add(Number(r.immutable_bytes), Number(r.mutable_bytes)); if (r.mutable_bytes !== bytes(r))
    fail('KEY_COUNTER_INVALID'); const tail = db.prepare('SELECT ordinal FROM legacy_metadata_request_keys WHERE ordinal>=1 ORDER BY ordinal DESC LIMIT 1').get(); if ((tail?.ordinal ?? 0) !== r.key_ordinal)
    fail('KEY_COUNTER_INVALID'); if (r.revision === 0) {
    if (r.immutable_bytes !== bytes(db.prepare('SELECT * FROM legacy_metadata_request_header WHERE singleton=1').get()))
        fail('KEY_COUNTER_INVALID');
}
else {
    const s = db.prepare('SELECT length(CAST(receipt_json AS BLOB)) n FROM legacy_metadata_request_receipts WHERE operation_id=? AND result_revision=?').get(r.last_operation_id!, r.revision!);
    if (!s || typeof s.n !== 'number' || s.n > 8192)
        fail('KEY_COUNTER_INVALID');
    const saved = db.prepare('SELECT * FROM legacy_metadata_request_receipts WHERE operation_id=?').get(r.last_operation_id!)!;
    try {
        if (typeof saved.receipt_json !== 'string' || saved.receipt_digest !== hash(saved.receipt_json))
            fail('KEY_COUNTER_INVALID');
        const p = decodeRequestKeyReceipt(JSON.parse(String(saved.receipt_json)));
        if (p.operationId !== r.last_operation_id || p.resultRevision !== r.revision || p.retainedImmutableBytes !== r.immutable_bytes || p.retainedMutableBytes !== r.mutable_bytes || p.baseRunId !== b.base.runId || p.databaseId !== b.base.identity.databaseId || p.generation !== b.base.identity.generation || saved.base_run_id !== b.base.runId || saved.expected_revision !== p.expectedRevision || saved.intent_digest !== p.intentDigest || saved.account_id !== p.accountId || saved.request_id !== p.requestId || saved.key_ordinal !== p.keyOrdinal)
            fail('KEY_COUNTER_INVALID');
    }
    catch {
        return fail('KEY_COUNTER_INVALID');
    }
} return r as unknown as Run; }
export function checked(db: DatabaseSync, input: unknown): {
    binding: RequestKeyBinding;
    run: Run;
    work: number;
} { const binding = normalized(input); durability(db); let work = catalog(db, true); parent(db, binding); const h = baseHeader(db, binding); work = add(work, h.work, bytes(binding)); const scalar = db.prepare('SELECT singleton,length(CAST(policy_json AS BLOB)) n FROM legacy_metadata_request_header LIMIT 2').all(); if (scalar.length !== 1 || scalar[0].singleton !== 1 || Number(scalar[0].n) > 16384)
    fail('KEY_BINDING_CONFLICT'); const row = db.prepare('SELECT * FROM legacy_metadata_request_header WHERE singleton=1').get(); if (stable(row) !== stable(expected(binding, h.header)))
    fail('KEY_BINDING_CONFLICT'); const run = readRun(db, binding); work = add(work, bytes(row), bytes(run), 16384); /* Two bounded stored-receipt copies, including a possible retry probe. */ if (work > binding.policy.maxStepByteWork)
    fail('KEY_STEP_LIMIT'); return { binding, run, work }; }
/** Trusted synthetic/create bootstrap only. No opener, repair or authority publication. */
export function initializeRequestKeySchema(db: DatabaseSync, input: unknown, mode: 'create' | 'resume'): void {
    if (mode !== 'create' && mode !== 'resume')
        fail('KEY_INPUT_INVALID');
    const b = normalized(input);
    durability(db);
    if (db.isTransaction)
        fail('KEY_TRANSACTION_INVALID');
    if (mode === 'resume') {
        checked(db, b);
        return;
    }
    let h: Record<string, string>;
    try {
        const admission = readTypedStageAdmission(db, b.base, b.policy.maxStepByteWork);
        catalog(db, false);
        h = baseHeader(db, b).header;
        if (admission.sourceBytes > b.policy.maxSourceBytes)
            fail('KEY_SOURCE_LIMIT');
    }
    catch (e) {
        if (e instanceof Error && 'code' in e && String(e.code).startsWith('KEY_'))
            throw e;
        fail('KEY_SCHEMA_INVALID');
    }
    const header = expected(b, h!), run: Run = { base_run_id: b.base.runId, revision: 0, watermark: 0, receipt_count: 0, key_count: 0, key_ordinal: 0, immutable_bytes: bytes(header), mutable_bytes: 0, last_operation_id: null };
    for (let n = 0; n < 8; n++) {
        const size = bytes(run);
        if (run.mutable_bytes === size)
            break;
        run.mutable_bytes = size;
    }
    if (add(run.immutable_bytes, run.mutable_bytes) > b.policy.maxRetainedDerivedBytes || bytes(header) + bytes(run) > b.policy.maxStepEncodedBytes || b.policy.maxStepMutations < 2)
        fail('KEY_STEP_LIMIT');
    let committed = false;
    try {
        db.exec('BEGIN IMMEDIATE');
        catalog(db, false);
        parent(db, b);
        if (hash(stable(baseHeader(db, b).header)) !== header.base_header_digest)
            fail('KEY_BINDING_CONFLICT');
        db.exec(REQUEST_KEY_DDL);
        const ks = Object.keys(header);
        db.prepare(`INSERT INTO legacy_metadata_request_header(${ks.join(',')}) VALUES(${ks.map(() => '?').join(',')})`).run(...Object.values(header));
        const cols = Object.keys(run);
        db.prepare(`INSERT INTO legacy_metadata_request_run(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(...Object.values(run));
        checked(db, b);
        db.exec('COMMIT');
        committed = true;
    }
    catch (e) {
        if (db.isTransaction)
            db.exec('ROLLBACK');
        if (committed || !db.isTransaction && db.prepare("SELECT 1 FROM sqlite_master WHERE name='legacy_metadata_request_header'").get())
            fail('KEY_COMMIT_UNCERTAIN');
        if (e instanceof Error && 'code' in e && String(e.code).startsWith('KEY_'))
            throw e;
        fail('KEY_SCHEMA_INVALID');
    }
}
