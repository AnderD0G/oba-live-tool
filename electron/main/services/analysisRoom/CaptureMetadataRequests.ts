import { decodeRequestKeyReceipt, type RequestKeyReceipt } from './CaptureMetadataRequestReceipt';
export { decodeRequestKeyReceipt } from './CaptureMetadataRequestReceipt';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { types } from 'node:util';
import { analysisId, type AnalysisScope } from '../../../../shared/analysisRoom';
import { validateCaptureSession } from './CaptureRecordValidation';
import { checked, readRun, type Run } from './CaptureMetadataRequestSchema';
import { own, nat, text, digest, scope, stable, hash, bytes, fail, add, type RequestKeyBinding, RequestKeyError } from './CaptureMetadataRequestDefinition';
export { initializeRequestKeySchema } from './CaptureMetadataRequestSchema';
export { RequestKeyError } from './CaptureMetadataRequestDefinition';
type Action = 'start' | 'stop' | 'reanalyze';
interface Legacy {
    sourceId: number;
    startOffset: number;
    nextOffset: number;
    itemOrdinal: number;
}
export interface ClaimInput {
    operationId: string;
    expectedRevision: number;
    accountId: string;
    requestId: string;
    action: Action;
    requestDigest: string;
    createdAt: number;
    scope?: AnalysisScope;
    legacy?: Legacy;
}
export interface RequestKey {
    accountId: string;
    requestId: string;
    action: Action;
    requestDigest: string;
    createdAt: number;
    ordinal: number;
    scope?: AnalysisScope;
    legacy?: Legacy;
}
function action(v: unknown): Action { if (typeof v !== 'string' || !['start', 'stop', 'reanalyze'].includes(v))
    fail('KEY_INPUT_INVALID'); return v as Action; }
function id(v: unknown): string { try {
    return analysisId(v);
}
catch {
    return fail('KEY_INPUT_INVALID');
} }
function input(v: unknown): ClaimInput { const x = own(v, ['operationId', 'expectedRevision', 'accountId', 'requestId', 'action', 'requestDigest', 'createdAt'], ['scope', 'legacy']), i: ClaimInput = { operationId: text(x.operationId, 256), expectedRevision: nat(x.expectedRevision), accountId: text(x.accountId, 200), requestId: text(x.requestId, 128), action: action(x.action), requestDigest: digest(x.requestDigest), createdAt: nat(x.createdAt) }; if (Object.hasOwn(x, 'scope')) {
    i.scope = scope(x.scope);
    if (i.scope.accountId !== i.accountId)
        fail('KEY_INPUT_INVALID');
} if (Object.hasOwn(x, 'legacy')) {
    const s = own(x.legacy, ['sourceId', 'startOffset', 'nextOffset', 'itemOrdinal']);
    i.legacy = { sourceId: nat(s.sourceId, 1), startOffset: nat(s.startOffset), nextOffset: nat(s.nextOffset, 1), itemOrdinal: nat(s.itemOrdinal) };
    if (i.legacy.startOffset !== 0 || i.legacy.nextOffset <= i.legacy.startOffset)
        fail('KEY_SOURCE_INVALID');
} if (!i.scope && !i.legacy)
    fail('KEY_INPUT_INVALID'); return i; }
function abort(signal?: AbortSignal) { if (signal !== undefined) {
    if (types.isProxy(signal))
        fail('KEY_INPUT_INVALID');
    let aborted: boolean;
    try {
        aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!.call(signal);
    }
    catch {
        return fail('KEY_INPUT_INVALID');
    }
    if (aborted)
        fail('KEY_ABORTED');
} }
function parsed(textValue: string): unknown { try {
    return JSON.parse(textValue);
}
catch {
    return fail('KEY_SOURCE_INVALID');
} }
function graph(value: unknown, maxDepth: number) { let nodes = 0; const walk = (v: unknown, d: number) => { if (++nodes > 8192 || d > maxDepth)
    fail('KEY_SOURCE_DEFERRED'); if (v && typeof v === 'object')
    for (const x of Array.isArray(v) ? v : Object.values(v))
        walk(x, d + 1); }; walk(value, 0); }
function sourceFor(db: DatabaseSync, b: RequestKeyBinding, i: ClaimInput, initialWork: number): {
    sourceSha: string | null;
    resolvedScope?: AnalysisScope;
    work: number;
} { if (!i.legacy)
    return { sourceSha: null, resolvedScope: i.scope, work: initialWork }; const l = i.legacy, high = db.prepare('SELECT substr(value,1,17) value FROM legacy_typed_meta WHERE key=?').get('source_high_water_id')?.value; if (typeof high !== 'string' || !Number.isSafeInteger(Number(high)) || l.sourceId > Number(high))
    fail('KEY_SOURCE_INVALID'); const row = db.prepare('SELECT id,size,sha256,verified,length(CAST(relative_path AS BLOB)) path_bytes,substr(relative_path,1,4097) relative_path FROM legacy_sources WHERE id=?').get(l.sourceId); if (!row || row.verified !== 1 || typeof row.size !== 'number' || !Number.isSafeInteger(row.size) || row.size < 1 || Number(row.path_bytes) > 4096 || row.relative_path !== `requests/${hash(i.accountId)}.json` || typeof row.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.sha256) || l.nextOffset !== row.size)
    fail('KEY_SOURCE_INVALID'); const cap = Math.min(131072, b.base.limits.maxRecordBytes, b.base.limits.maxMetadataBytes); if (row.size > cap)
    fail('KEY_SOURCE_DEFERRED'); const chunks = db.prepare('SELECT offset,next_offset,length(bytes) size FROM legacy_chunks WHERE source_id=? ORDER BY offset LIMIT 4').all(l.sourceId); let cursor = 0; for (const c of chunks) {
    if (typeof c.offset !== 'number' || typeof c.next_offset !== 'number' || c.offset !== cursor || c.next_offset <= cursor || c.next_offset > row.size || c.next_offset - c.offset !== c.size || Number(c.size) > 65536)
        fail('KEY_SOURCE_INVALID');
    cursor = c.next_offset;
} if (cursor !== row.size)
    fail('KEY_SOURCE_INVALID'); const work = add(initialWork, 4 * row.size, bytes(chunks), bytes(row)); if (work > b.policy.maxStepByteWork)
    fail('KEY_STEP_LIMIT'); const body = Buffer.alloc(row.size); for (const c of chunks) {
    const part = db.prepare('SELECT bytes FROM legacy_chunks WHERE source_id=? AND offset=? AND next_offset=?').get(l.sourceId, c.offset, c.next_offset)?.bytes;
    if (!(part instanceof Uint8Array) || part.byteLength !== c.size)
        fail('KEY_SOURCE_INVALID');
    body.set(part, Number(c.offset));
} if (hash(body) !== row.sha256)
    fail('KEY_SOURCE_INVALID'); let raw: string; try {
    raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
}
catch {
    return fail('KEY_SOURCE_INVALID');
} const value = parsed(raw); graph(value, Math.min(16, b.base.limits.maxDepth)); let root: Record<string, unknown>; try {
    root = own(value, ['accountId', 'items']);
}
catch {
    return fail('KEY_SOURCE_DEFERRED');
} if (root.accountId !== i.accountId || !Array.isArray(root.items) || l.itemOrdinal >= root.items.length)
    fail('KEY_SOURCE_INVALID'); const matches = root.items.filter(v => v && typeof v === 'object' && !Array.isArray(v) && (v as Record<string, unknown>).requestId === i.requestId); if (matches.length > 1)
    fail('KEY_SOURCE_AMBIGUOUS'); if (matches.length !== 1)
    fail('KEY_SOURCE_INVALID'); let item: Record<string, unknown>; try {
    item = own(root.items[l.itemOrdinal], ['requestId', 'digest', 'action', 'createdAt', 'status'], ['sessionId', 'result', 'jobId', 'jobResult', 'error']);
}
catch {
    return fail('KEY_SOURCE_DEFERRED');
} if (item.requestId !== i.requestId || item.digest !== i.requestDigest || item.action !== i.action || item.createdAt !== i.createdAt || typeof item.status !== 'string' || !['inflight', 'terminal'].includes(item.status))
    fail('KEY_SOURCE_INVALID'); let sessionId: string | undefined, declaredScope: AnalysisScope | undefined; try {
    if (Object.hasOwn(item, 'sessionId'))
        sessionId = id(item.sessionId);
    if (Object.hasOwn(item, 'jobId'))
        id(item.jobId);
    if (Object.hasOwn(item, 'error')) {
        const e = own(item.error, ['code', 'message', 'retryable']);
        text(e.code, 128);
        text(e.message, 256);
        if (typeof e.retryable !== 'boolean')
            fail('KEY_SOURCE_INVALID');
    }
    if (Object.hasOwn(item, 'result')) {
        const session = validateCaptureSession(item.result);
        if (session.scope.accountId !== i.accountId || sessionId && sessionId !== session.id)
            fail('KEY_SOURCE_INVALID');
        sessionId = session.id;
        declaredScope = session.scope;
    }
}
catch {
    return fail('KEY_SOURCE_INVALID');
} let resolvedScope: AnalysisScope | undefined; if (sessionId) {
    const session = db.prepare('SELECT account_id,platform,source FROM sessions WHERE id=?').get(sessionId);
    if (session) {
        const s = scope({ accountId: session.account_id, platform: session.platform, source: session.source });
        if (s.accountId !== i.accountId || declaredScope && stable(s) !== stable(declaredScope))
            fail('KEY_SOURCE_INVALID');
        resolvedScope = s;
    }
} if (i.scope && (!resolvedScope || stable(i.scope) !== stable(resolvedScope)))
    fail('KEY_SOURCE_INVALID'); return { sourceSha: row.sha256, resolvedScope, work }; }
function fromRow(row: Record<string, unknown>): RequestKey { let r: RequestKey; try {
    r = { accountId: text(row.account_id, 200), requestId: text(row.request_id, 128), action: action(row.action), requestDigest: digest(row.request_digest), createdAt: nat(row.created_at), ordinal: nat(row.ordinal, 1) };
    if (row.scope_known === 1)
        r.scope = scope({ accountId: r.accountId, platform: row.platform, source: row.source });
    else if (row.scope_known !== 0 || row.platform !== null || row.source !== null)
        fail('KEY_RECEIPT_INVALID');
    if (row.source_id !== null) {
        r.legacy = { sourceId: nat(row.source_id, 1), startOffset: nat(row.start_offset), nextOffset: nat(row.next_offset, 1), itemOrdinal: nat(row.item_ordinal) };
        if (r.legacy.startOffset !== 0 || r.legacy.nextOffset > 131072)
            fail('KEY_RECEIPT_INVALID');
        digest(row.source_sha256);
    }
    else if ([row.start_offset, row.next_offset, row.item_ordinal, row.source_sha256].some(v => v !== null) || !r.scope)
        fail('KEY_RECEIPT_INVALID');
}
catch {
    return fail('KEY_RECEIPT_INVALID');
} return r; }
const selectKey = 'SELECT * FROM legacy_metadata_request_keys WHERE account_id=? AND request_id=?';
function readReceipt(db: DatabaseSync, b: RequestKeyBinding, run: Run, operationId: string): RequestKeyReceipt | undefined { const scalar = db.prepare('SELECT length(CAST(receipt_json AS BLOB)) n FROM legacy_metadata_request_receipts WHERE operation_id=?').get(operationId); if (!scalar)
    return undefined; if (typeof scalar.n !== 'number' || scalar.n > 8192)
    fail('KEY_RECEIPT_INVALID'); const stored = db.prepare('SELECT * FROM legacy_metadata_request_receipts WHERE operation_id=?').get(operationId)!; let receipt: RequestKeyReceipt; try {
    if (typeof stored.receipt_json !== 'string' || stored.receipt_digest !== hash(stored.receipt_json))
        fail('KEY_RECEIPT_INVALID');
    receipt = decodeRequestKeyReceipt(parsed(stored.receipt_json));
}
catch {
    return fail('KEY_RECEIPT_INVALID');
} if (receipt.databaseId !== b.base.identity.databaseId || receipt.generation !== b.base.identity.generation || receipt.baseRunId !== b.base.runId || receipt.operationId !== operationId || receipt.intentDigest !== stored.intent_digest || receipt.expectedRevision !== stored.expected_revision || receipt.resultRevision !== stored.result_revision || receipt.accountId !== stored.account_id || receipt.requestId !== stored.request_id || receipt.keyOrdinal !== stored.key_ordinal || stored.base_run_id !== b.base.runId || receipt.reused !== false || receipt.resultRevision > run.revision)
    fail('KEY_RECEIPT_INVALID'); const row = db.prepare(selectKey).get(receipt.accountId, receipt.requestId); if (!row)
    fail('KEY_RECEIPT_INVALID'); const key = fromRow(row); if (row.base_run_id !== b.base.runId || key.ordinal !== receipt.keyOrdinal || key.action !== receipt.action || Boolean(key.scope) !== receipt.scopeKnown)
    fail('KEY_RECEIPT_INVALID'); if (receipt.expectedRevision === 0 ? stored.predecessor_revision !== null : stored.predecessor_revision !== receipt.expectedRevision || !db.prepare('SELECT 1 FROM legacy_metadata_request_receipts WHERE result_revision=? AND base_run_id=?').get(receipt.expectedRevision, b.base.runId))
    fail('KEY_RECEIPT_INVALID'); if (receipt.resultRevision === run.revision && run.last_operation_id !== operationId)
    fail('KEY_RECEIPT_INVALID'); return receipt; }
export function requestKeyReceipt(db: DatabaseSync, binding: unknown, operationId: unknown): RequestKeyReceipt | undefined { const c = checked(db, binding); return readReceipt(db, c.binding, c.run, text(operationId, 256)); }
export function requestKey(db: DatabaseSync, binding: unknown, accountId: unknown, requestId: unknown): RequestKey | undefined { const c = checked(db, binding), row = db.prepare(selectKey).get(text(accountId, 200), text(requestId, 128)); if (!row)
    return undefined; if (row.base_run_id !== c.binding.base.runId || Number(row.ordinal) > c.run.key_ordinal)
    fail('KEY_RECEIPT_INVALID'); return fromRow(row); }
export function requestKeyPage(db: DatabaseSync, binding: unknown, accountId: unknown, options: unknown): {
    items: RequestKey[];
    upperOrdinal: number;
    nextAfter?: number;
} { const c = checked(db, binding), o = own(options, ['limit'], ['upperOrdinal', 'afterOrdinal', 'scopeKnown']), limit = nat(o.limit, 1); if (limit > 100 || o.scopeKnown !== undefined && typeof o.scopeKnown !== 'boolean')
    fail('KEY_INPUT_INVALID'); const account = text(accountId, 200), upper = o.upperOrdinal === undefined ? c.run.key_ordinal : nat(o.upperOrdinal), after = o.afterOrdinal === undefined ? 0 : nat(o.afterOrdinal); if (upper > c.run.key_ordinal || after > upper)
    fail('KEY_INPUT_INVALID'); const q = o.scopeKnown === undefined ? 'SELECT * FROM legacy_metadata_request_keys WHERE account_id=? AND ordinal>? AND ordinal<=? ORDER BY ordinal LIMIT ?' : 'SELECT * FROM legacy_metadata_request_keys WHERE account_id=? AND scope_known=? AND ordinal>? AND ordinal<=? ORDER BY ordinal LIMIT ?', params: SQLInputValue[] = o.scopeKnown === undefined ? [account, after, upper, limit + 1] : [account, o.scopeKnown ? 1 : 0, after, upper, limit + 1], rows = db.prepare(q).all(...params); const items = rows.slice(0, limit).map(row => { if (row.base_run_id !== c.binding.base.runId)
    fail('KEY_RECEIPT_INVALID'); return fromRow(row); }); return { items, upperOrdinal: upper, ...rows.length > limit ? { nextAfter: items.at(-1)!.ordinal } : {} }; }
function total(db: DatabaseSync) { return nat(db.prepare('SELECT total_changes() n').get()?.n); }
/** Caller must roll back its entire outer transaction on ANY exception. No COMMIT or extra queue. */
export function claimRequestKeyInTransaction(db: DatabaseSync, binding: unknown, value: unknown, signal?: AbortSignal): RequestKeyReceipt {
    abort(signal);
    const i = input(value);
    if (!db.isTransaction)
        fail('KEY_TRANSACTION_INVALID');
    const c = checked(db, binding), b = c.binding, intent = hash(stable(i)), old = readReceipt(db, b, c.run, i.operationId);
    if (old) {
        if (old.intentDigest !== intent)
            fail('KEY_OPERATION_CONFLICT');
        return { ...old, reused: true };
    }
    if (c.run.revision !== i.expectedRevision)
        fail('KEY_STALE_REVISION');
    if (c.run.revision === Number.MAX_SAFE_INTEGER)
        fail('KEY_COUNTER_INVALID');
    const source = sourceFor(db, b, i, add(c.work, bytes(i))), facts = { accountId: i.accountId, requestId: i.requestId, action: i.action, requestDigest: i.requestDigest, createdAt: i.createdAt, ...source.resolvedScope ? { scope: source.resolvedScope } : {}, ...i.legacy ? { legacy: i.legacy } : {} }, existing = db.prepare(selectKey).get(i.accountId, i.requestId);
    if (existing) {
        const key = fromRow(existing), { ordinal: _ordinal, ...prior } = key;
        if (stable(prior) !== stable(facts) || existing.base_run_id !== b.base.runId || existing.source_sha256 !== source.sourceSha)
            fail('KEY_CONFLICT');
    }
    const inserted = !existing, ordinal = inserted ? add(c.run.key_ordinal, 1) : Number(existing.ordinal), row = { account_id: i.accountId, request_id: i.requestId, base_run_id: b.base.runId, ordinal, action: i.action, request_digest: i.requestDigest, created_at: i.createdAt, scope_known: source.resolvedScope ? 1 : 0, platform: source.resolvedScope?.platform ?? null, source: source.resolvedScope?.source ?? null, source_id: i.legacy?.sourceId ?? null, start_offset: i.legacy?.startOffset ?? null, next_offset: i.legacy?.nextOffset ?? null, item_ordinal: i.legacy?.itemOrdinal ?? null, source_sha256: source.sourceSha }, revision = add(c.run.revision, 1), mutations = inserted ? 3 : 2;
    const receipt: RequestKeyReceipt = { version: 1, kind: 'request-key', ...b.base.identity, baseRunId: b.base.runId, operationId: i.operationId, intentDigest: intent, accountId: i.accountId, requestId: i.requestId, action: i.action, expectedRevision: c.run.revision, resultRevision: revision, watermark: revision, keyOrdinal: ordinal, keyInserted: inserted, scopeKnown: Boolean(source.resolvedScope), encodedBytes: 0, rowMutations: mutations, byteWork: source.work, retainedImmutableBytes: 0, retainedMutableBytes: 0, activationAllowed: false, sharedCapacityVerified: false, physicalProofVerified: false, domainAdmissionVerified: false, reused: false };
    const next: Run = { ...c.run, revision, watermark: revision, receipt_count: revision, key_count: add(c.run.key_count, inserted ? 1 : 0), key_ordinal: inserted ? ordinal : c.run.key_ordinal, immutable_bytes: c.run.immutable_bytes, mutable_bytes: 0, last_operation_id: i.operationId };
    let receiptRow: Record<string, SQLInputValue> = {};
    let converged = false;
    for (let n = 0; n < 16; n++) {
        const receiptJson = stable(receipt);
        receiptRow = { operation_id: i.operationId, base_run_id: b.base.runId, intent_digest: intent, expected_revision: c.run.revision, result_revision: revision, predecessor_revision: c.run.revision === 0 ? null : c.run.revision, account_id: i.accountId, request_id: i.requestId, key_ordinal: ordinal, receipt_json: receiptJson, receipt_digest: hash(receiptJson) };
        const immutable = add(c.run.immutable_bytes, inserted ? bytes(row) : 0, bytes(receiptRow)), mutable = bytes(next), encoded = add(inserted ? bytes(row) : 0, bytes(receiptRow), bytes(next));
        if (next.immutable_bytes === immutable && next.mutable_bytes === mutable && receipt.encodedBytes === encoded && receipt.retainedImmutableBytes === immutable && receipt.retainedMutableBytes === mutable) {
            converged = true;
            break;
        }
        next.immutable_bytes = immutable;
        next.mutable_bytes = mutable;
        receipt.encodedBytes = encoded;
        receipt.retainedImmutableBytes = immutable;
        receipt.retainedMutableBytes = mutable;
    }
    if (!converged)
        fail('KEY_COUNTER_INVALID');
    decodeRequestKeyReceipt(receipt);
    if (mutations > b.policy.maxStepMutations || receipt.encodedBytes > b.policy.maxStepEncodedBytes || receipt.byteWork > b.policy.maxStepByteWork)
        fail('KEY_STEP_LIMIT');
    if (add(next.immutable_bytes, next.mutable_bytes) > b.policy.maxRetainedDerivedBytes)
        fail('KEY_DERIVED_LIMIT');
    abort(signal);
    const before = total(db);
    if (inserted) {
        const cols = Object.keys(row);
        db.prepare(`INSERT INTO legacy_metadata_request_keys(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(...Object.values(row));
    }
    const cols = Object.keys(receiptRow);
    db.prepare(`INSERT INTO legacy_metadata_request_receipts(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(...Object.values(receiptRow));
    db.prepare('UPDATE legacy_metadata_request_run SET revision=?,watermark=?,receipt_count=?,key_count=?,key_ordinal=?,immutable_bytes=?,mutable_bytes=?,last_operation_id=? WHERE base_run_id=? AND revision=?').run(next.revision, next.watermark, next.receipt_count, next.key_count, next.key_ordinal, next.immutable_bytes, next.mutable_bytes, next.last_operation_id, b.base.runId, c.run.revision);
    if (total(db) - before !== mutations)
        fail('KEY_UNEXPECTED_EFFECT');
    abort(signal);
    return receipt;
}
export function claimRequestKey(db: DatabaseSync, binding: unknown, value: unknown, signal?: AbortSignal): RequestKeyReceipt { abort(signal); input(value); if (db.isTransaction)
    fail('KEY_TRANSACTION_INVALID'); let attemptedCommit = false; try {
    db.exec('BEGIN IMMEDIATE');
    const r = claimRequestKeyInTransaction(db, binding, value, signal);
    abort(signal);
    attemptedCommit = true;
    db.exec('COMMIT');
    return r;
}
catch (e) {
    const uncertain = attemptedCommit && !db.isTransaction;
    if (db.isTransaction)
        db.exec('ROLLBACK');
    if (uncertain)
        fail('KEY_COMMIT_UNCERTAIN');
    if (e instanceof RequestKeyError)
        throw e;
    fail('KEY_STORAGE_FAILED');
} }
