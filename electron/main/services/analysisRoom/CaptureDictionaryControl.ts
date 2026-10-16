import type { DatabaseSync } from 'node:sqlite';
import { DictionaryContext, type SqlRow } from "./CaptureDictionarySchema";
import { own, array, uuid, nat, hash, pointer, mappingOwner, typedRow, stable, size, sha, advanceDigest, ZERO_DIGEST, graphStats, scalarColumns, fail, abort, DictionaryError, type MappingOwner, type TypedRow } from "./CaptureDictionaryDefinition";
import { readTypedUnit } from "./CaptureDictionaryView";
import { assertDictionaryPermit, recheckPublishedDictionaryPermit } from "./CaptureDictionaryProof";
export { dictionaryPublicationPermit } from "./CaptureDictionaryProof";
export { initializeDictionarySchema, initializeLinkedDictionarySchema } from "./CaptureDictionarySchema";
export * from "./CaptureDictionaryView";
export type DictionaryReceipt = {
    version: 1;
    domain: 'dictionary';
    catalog: 'dictionary' | 'dictionary-interaction';
    databaseId: string;
    generation: number;
    baseRunId: string;
    operationId: string;
    intentDigest:string;
    owner: MappingOwner;
    method: string;
    generationId: string;
    resultStageRevision: number;
    resultDictionaryRevision: number;
    expectedDictionaryRevision?:number;
    expectedStageRevision?:number;
    publishedVersion?:number;
    phase: string;
    ordinal: number;
    prefixDigest: string;
    revision: number;
    watermark: number;
    rowMutations: number;
    byteWork: number;
    encodedBytes: number;
    retainedImmutableBytes: number;
    retainedMutableBytes: number;
    activationAllowed: false;
    sharedCapacityVerified:false;
    physicalProofVerified:false;
    reused?: true;
};
const RECEIPT_KEYS = Object.freeze(['version', 'domain', 'catalog', 'databaseId', 'generation', 'baseRunId', 'operationId', 'intentDigest','owner', 'method', 'generationId', 'resultStageRevision', 'resultDictionaryRevision', 'phase', 'ordinal', 'prefixDigest', 'revision', 'watermark', 'rowMutations', 'byteWork', 'encodedBytes', 'retainedImmutableBytes', 'retainedMutableBytes', 'activationAllowed','sharedCapacityVerified','physicalProofVerified']);
export function decodeDictionaryReceipt(v: unknown): DictionaryReceipt { const r = own(v, RECEIPT_KEYS,['publishedVersion','expectedDictionaryRevision','expectedStageRevision']); if(r.method==='publish')r.publishedVersion=nat(r.publishedVersion,1);else if(Object.hasOwn(r,'publishedVersion'))fail('DICTIONARY_STORAGE_INVALID'); if (r.version !== 1 || r.domain !== 'dictionary' || (r.catalog !== 'dictionary' && r.catalog !== 'dictionary-interaction') || r.activationAllowed !== false || r.sharedCapacityVerified!==false || r.physicalProofVerified!==false || typeof r.method !== 'string' || !['prepare', 'append', 'verify', 'save-draft', 'publish'].includes(r.method) || typeof r.phase !== 'string' || !['upload', 'verify', 'sealed'].includes(r.phase))
    fail('DICTIONARY_STORAGE_INVALID'); r.intentDigest=hash(r.intentDigest);r.databaseId = uuid(r.databaseId); r.baseRunId = uuid(r.baseRunId); r.generation = nat(r.generation, 1); r.operationId = uuid(r.operationId); r.generationId = uuid(r.generationId); r.owner = mappingOwner(r.owner); r.prefixDigest = hash(r.prefixDigest); for (const k of ['resultStageRevision', 'resultDictionaryRevision', 'ordinal', 'revision', 'watermark', 'rowMutations', 'byteWork', 'encodedBytes', 'retainedImmutableBytes', 'retainedMutableBytes'])
    r[k] = nat(r[k]); if (r.revision !== r.watermark || r.revision === 0 || r.resultStageRevision === 0 || Number(r.rowMutations) > 128 || Number(r.byteWork) > 1048576 || Number(r.encodedBytes) > 1048576 || size(r) > 8192)
    fail('DICTIONARY_STORAGE_INVALID'); if(r.method==='append'||r.method==='verify'){r.expectedStageRevision=nat(r.expectedStageRevision,1);if(Object.hasOwn(r,'expectedDictionaryRevision')||r.resultStageRevision!==Number(r.expectedStageRevision)+1)fail('DICTIONARY_STORAGE_INVALID')}else{r.expectedDictionaryRevision=nat(r.expectedDictionaryRevision);if(Object.hasOwn(r,'expectedStageRevision')||r.resultDictionaryRevision!==(r.method==='prepare'?r.expectedDictionaryRevision:Number(r.expectedDictionaryRevision)+1))fail('DICTIONARY_STORAGE_INVALID')};return r as DictionaryReceipt; }
function stored(c: DictionaryContext, op: string, intent?: string, o?: MappingOwner, method?: string): DictionaryReceipt | undefined { const row = c.point('legacy_dictionary_receipts', { operation_id: op }); if (!row)
    return undefined; if (row.base_run_id !== c.b.base.runId || typeof row.receipt_json !== 'string' || sha(row.receipt_json) !== row.receipt_digest)
    fail('DICTIONARY_STORAGE_INVALID'); let value: unknown; try {
    value = JSON.parse(row.receipt_json);
}
catch {
    return fail('DICTIONARY_STORAGE_INVALID');
} ; const r = decodeDictionaryReceipt(value); if (r.catalog !== c.b.catalog || r.databaseId !== c.b.base.identity.databaseId || r.generation !== c.b.base.identity.generation || r.baseRunId !== c.b.base.runId || r.intentDigest!==row.intent_digest||r.operationId !== op || r.method !== row.method || r.owner.platform !== row.platform || r.owner.source !== row.source)
    fail('DICTIONARY_STORAGE_INVALID'); if (intent !== undefined && (intent !== row.intent_digest || method !== row.method || o?.platform !== row.platform || o?.source !== row.source))
    fail('DICTIONARY_IDEMPOTENCY_CONFLICT'); const a = c.accounting(), g = c.generation(r.generationId, r.owner); if (r.revision > Number(a.revision) || r.resultStageRevision > Number(g.stage_revision) || r.resultDictionaryRevision > Number(c.ownerHead(r.owner)?.revision) || r.retainedImmutableBytes > Number(a.immutable_bytes))
    fail('DICTIONARY_STORAGE_INVALID'); if (r.ordinal === 0) {
    if (r.prefixDigest !== ZERO_DIGEST)
        fail('DICTIONARY_STORAGE_INVALID');
}
else {
    const unit = c.point('legacy_dictionary_units', { generation_id: r.generationId, ordinal: r.ordinal });
    if (!unit || unit.prefix_digest !== r.prefixDigest || sha(stable(readTypedUnit(c, unit))) !== unit.typed_digest)
        fail('DICTIONARY_STORAGE_INVALID');
    if (r.method === 'append') {
        // Every original append has two immutable rows per typed unit, one
        // generation update and the two ACK/accounting writes. Its authenticated
        // mutation count therefore fixes this ACK's bounded accepted interval,
        // without changing historical ACK bytes or scanning earlier batches.
        const count = (r.rowMutations - 3) / 2, first = r.ordinal - count + 1;
        if (!Number.isSafeInteger(count) || count < 1 || count > 62 || first < 1)
            fail('DICTIONARY_STORAGE_INVALID');
        let prefix = first === 1 ? ZERO_DIGEST : c.point('legacy_dictionary_units', { generation_id: r.generationId, ordinal: first - 1 })?.prefix_digest;
        if (typeof prefix !== 'string') fail('DICTIONARY_STORAGE_INVALID');
        for (let ordinal = first; ordinal <= r.ordinal; ordinal++) {
            const accepted = c.point('legacy_dictionary_units', { generation_id: r.generationId, ordinal });
            if (!accepted) fail('DICTIONARY_STORAGE_INVALID');
            const value = readTypedUnit(c, accepted!);
            c.add(3 * size(value));
            if (sha(stable(value)) !== accepted!.typed_digest) fail('DICTIONARY_STORAGE_INVALID');
            prefix = advanceDigest(prefix!, value);
            if (prefix !== accepted!.prefix_digest) fail('DICTIONARY_STORAGE_INVALID');
        }
        if (prefix !== r.prefixDigest) fail('DICTIONARY_STORAGE_INVALID');
    }
} ; if(r.publishedVersion!==undefined){const v=c.point('legacy_dictionary_versions',{platform:r.owner.platform,source:r.owner.source,version:r.publishedVersion});if(!v||v.generation_id!==r.generationId||v.content_digest!==g.content_digest)fail('DICTIONARY_STORAGE_INVALID')}; return r; }
export function dictionaryReceipt(db: DatabaseSync, b: unknown, operationId: string) { return stored(new DictionaryContext(db, b), uuid(operationId)); }
type Result = {
    generationId: string;
    resultStageRevision: number;
    resultDictionaryRevision: number;
    phase: string;
    ordinal: number;
    prefixDigest: string;
    publishedVersion?:number;
};
function increment(value: unknown) { const n = nat(value); if (n === Number.MAX_SAFE_INTEGER)
    fail('DICTIONARY_COUNTER_OVERFLOW'); return n + 1; }
function finish(c: DictionaryContext, op: string, o: MappingOwner, method: string, intent: string, result: Result,command:Record<string,unknown>): DictionaryReceipt {
    const old = c.accounting(), revision = increment(old.revision), mutations = c.changes + 2;
    if (mutations > Math.min(128, c.b.policy.maxStepMutations))
        fail('DICTIONARY_STEP_LIMIT');
    let run: SqlRow = { base_run_id: c.b.base.runId, revision, watermark: revision, receipt_count: revision, immutable_bytes: 0, mutable_bytes: 0, last_operation_id: op }, r: DictionaryReceipt = { version: 1, domain: 'dictionary', catalog: c.b.catalog, databaseId: c.b.base.identity.databaseId, generation: c.b.base.identity.generation, baseRunId: c.b.base.runId, operationId: op,intentDigest:intent,...command.expectedDictionaryRevision===undefined?{}:{expectedDictionaryRevision:Number(command.expectedDictionaryRevision)},...command.expectedStageRevision===undefined?{}:{expectedStageRevision:Number(command.expectedStageRevision)},owner: o, method, ...result, revision, watermark: revision, rowMutations: mutations, byteWork: 0, encodedBytes: 0, retainedImmutableBytes: 0, retainedMutableBytes: 0, activationAllowed: false,sharedCapacityVerified:false,physicalProofVerified:false }, row: SqlRow = {};
    let settled = false;
    for (let n = 0; n < 40; n++) {
        const json = stable(r);
        row = { operation_id: op, base_run_id: c.b.base.runId, platform: o.platform, source: o.source, method, intent_digest: intent, receipt_digest: sha(json), receipt_json: json };
        const imm = Number(old.immutable_bytes) + c.immutable + size(row), mut = Number(old.mutable_bytes) + c.mutableDelta + size(run) - size(old);
        run = { ...run, immutable_bytes: imm, mutable_bytes: mut };
        const enc = c.encoded + size(row) + size(run) + size({ base_run_id: c.b.base.runId }), next = { ...r, byteWork: c.work + 3 * (enc - c.encoded), encodedBytes: enc, retainedImmutableBytes: imm, retainedMutableBytes: mut };
        if (stable(next) === stable(r)) {
            settled = true;
            break;
        }
        r = next;
    }
    if (!settled || r.retainedMutableBytes < 0 || !Number.isSafeInteger(r.retainedImmutableBytes + r.retainedMutableBytes))
        fail('DICTIONARY_COUNTER_OVERFLOW');
    if (r.retainedImmutableBytes + r.retainedMutableBytes > c.b.policy.maxRetainedDerivedBytes || r.byteWork > Math.min(1048576, c.b.policy.maxStepByteWork) || r.encodedBytes > Math.min(1048576, c.b.policy.maxStepEncodedBytes, c.b.base.limits.maxMetadataBytes) || size(r) > 8192)
        fail('DICTIONARY_STEP_LIMIT');
    const cols = Object.keys(row);
    c.db.prepare(`INSERT INTO legacy_dictionary_receipts(${cols}) VALUES(${cols.map(() => '?')})`).run(...Object.values(row));
    const keys = Object.keys(run).filter(k => k !== 'base_run_id');
    c.db.prepare(`UPDATE legacy_dictionary_accounting SET ${keys.map(k => `${k}=?`)} WHERE base_run_id=? AND revision=?`).run(...keys.map(k => run[k]), c.b.base.runId, old.revision);
    return r;
}
function transaction(db: DatabaseSync, b: unknown, cmd: Record<string, unknown>, method: string, action: (c: DictionaryContext, o: MappingOwner) => Result, publicationPermit?:unknown,signal?:AbortSignal): DictionaryReceipt { abort(signal);const op = uuid(cmd.operationId), o = mappingOwner(cmd.owner); if (db.isTransaction)
    fail('DICTIONARY_TRANSACTION_ACTIVE'); if (db.prepare('PRAGMA synchronous').get()?.synchronous !== 2 || db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal' || db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1)
    fail('DICTIONARY_DURABILITY_INVALID'); let commitAttempted = false; try {
    db.exec('BEGIN IMMEDIATE');
    // One transaction-owned checked context accounts admission, old ACK reads,
    // action and proof guards together. No outer/reset meter can hide work.
    const c = new DictionaryContext(db, b), intent = sha(stable({ catalog: c.b.catalog, command: cmd }));
    c.add(3 * size(cmd));
    const retry = stored(c, op, intent, o, method);
    if (retry) {
        db.exec('ROLLBACK');
        return { ...retry, reused: true };
    }
    const before = Number(db.prepare('SELECT total_changes() n').get()!.n), output=action(c,o); if(method==='publish')c.add(65536); const result=finish(c,op,o,method,intent,output,cmd),actual = Number(db.prepare('SELECT total_changes() n').get()!.n) - before;
    if (actual !== result.rowMutations)
        fail('DICTIONARY_STORAGE_INVALID');
    if(method==='publish'){const reserved=c.work;c.work-=65536;const beforeFence=c.work;recheckPublishedDictionaryPermit(c,o,Number(cmd.expectedDictionaryRevision),result.publishedVersion!,publicationPermit);if(c.work-beforeFence>65536)fail('DICTIONARY_WORK_LIMIT');c.work=Math.max(c.work,reserved)} abort(signal);commitAttempted = true;
    db.exec('COMMIT');
    return result;
}
catch (e) {
    try {
        if (db.isTransaction)
            db.exec('ROLLBACK');
    }
    catch { }
    if (commitAttempted)
        fail('DICTIONARY_COMMIT_UNCERTAIN');
    if (e instanceof DictionaryError)
        throw e;
    fail('DICTIONARY_STORAGE_INVALID');
} }
function boundedCommand(r: Record<string, unknown>) { if (size(r) > 1048576)
    fail('DICTIONARY_STEP_LIMIT'); return r; }
function headRevision(c: DictionaryContext, o: MappingOwner, expected: number) { const h = c.ownerHead(o); if (Number(h?.revision ?? 0) !== expected)
    fail('DICTIONARY_STALE_REVISION'); return h; }
function resultOf(c: DictionaryContext, g: SqlRow, o: MappingOwner, verified = false): Result { return { generationId: String(g.generation_id), resultStageRevision: Number(g.stage_revision), resultDictionaryRevision: Number(c.ownerHead(o)?.revision ?? 0), phase: String(g.phase), ordinal: verified ? Number(g.verify_ordinal) : Number(g.next_ordinal) - 1, prefixDigest: String(verified ? g.verified_digest : g.uploaded_digest) }; }
export function prepareDictionaryGeneration(db: DatabaseSync, b: unknown, input: unknown,signal?:AbortSignal): DictionaryReceipt { const r = own(input, ['operationId', 'owner', 'generationId', 'expectedDictionaryRevision', 'identity', 'expectedCounts', 'contentDigest']), id = own(r.identity, ['userIdPath'], ['nicknamePath']), counts = own(r.expectedCounts, ['formats', 'definitions', 'candidates', 'enums', 'entries']); r.operationId = uuid(r.operationId); r.owner = mappingOwner(r.owner); r.generationId = uuid(r.generationId); r.expectedDictionaryRevision = nat(r.expectedDictionaryRevision); r.contentDigest = hash(r.contentDigest); id.userIdPath = pointer(id.userIdPath); if (id.nicknamePath !== undefined)
    id.nicknamePath = pointer(id.nicknamePath);
else
    delete id.nicknamePath; counts.formats = nat(counts.formats, 1, 16); counts.definitions = nat(counts.definitions, 0, 256); counts.candidates = nat(counts.candidates, Number(counts.definitions), 4 * Number(counts.definitions)); counts.enums = nat(counts.enums, 0, 256 * Number(counts.definitions)); counts.entries = nat(counts.entries, 0, 256 * Number(counts.definitions)); r.identity = id; r.expectedCounts = counts; boundedCommand(r); return transaction(db, b, r, 'prepare', (c, o) => { const requiredDepth = Number(counts.entries) > 0 ? 6 : Number(counts.definitions) > 0 ? 5 : 2; if (c.b.base.limits.maxDepth < requiredDepth)
    fail('DICTIONARY_CONTENT_LIMIT'); const h = headRevision(c, o, Number(r.expectedDictionaryRevision)); if (!h)
    c.write('legacy_dictionary_heads', {}, { platform: o.platform, source: o.source, revision: 0, draft_generation_id: null, draft_generation_phase: null, active_version: null, last_version: 0 }); const graph = graphStats({ identity: id, definitions: [], acceptedFormatVersions: [] }), g: SqlRow = { generation_id: r.generationId as string, platform: o.platform, source: o.source, expected_dictionary_revision: r.expectedDictionaryRevision as number, stage_revision: 1, phase: 'upload', user_id_path: JSON.stringify(id.userIdPath), nickname_path: id.nicknamePath === undefined ? null : JSON.stringify(id.nicknamePath), expected_formats: counts.formats as number, expected_definitions: counts.definitions as number, expected_candidates: counts.candidates as number, expected_enums: counts.enums as number, expected_entries: counts.entries as number, next_ordinal: 1, verify_ordinal: 0, semantic_bytes: graph.bytes, node_count: graph.nodes, uploaded_digest: ZERO_DIGEST, verified_digest: ZERO_DIGEST, content_digest: r.contentDigest as string }; c.write('legacy_dictionary_generations', {}, g); return resultOf(c, g, o); },undefined,signal); }
const total = (g: SqlRow) => ['formats', 'definitions', 'candidates', 'enums', 'entries'].reduce((n, k) => n + Number(g['expected_' + k]), 0);
function expectedKind(g: SqlRow, index: number) { let end = 0; for (const [k, p] of [['format', 'formats'], ['definition', 'definitions'], ['candidate', 'candidates'], ['enum', 'enums'], ['entry', 'entries']]) {
    end += Number(g['expected_' + p]);
    if (index <= end)
        return k;
} return fail('DICTIONARY_ORDER_INVALID'); }
function storeRow(c: DictionaryContext, gen: string, row: TypedRow) { const base = { generation_id: gen }; if (row.kind === 'format')
    c.write('legacy_dictionary_formats', {}, { ...base, ordinal: row.ordinal, format_version: row.value }, true); if (row.kind === 'definition')
    c.write('legacy_dictionary_definitions', {}, { ...base, ordinal: row.ordinal, attribute_id: row.id, name: JSON.stringify(row.name), type: row.type, semantic: row.semantic, ttl_ms: row.ttlMs ?? null, conversion_kind: row.conversionKind ?? null }, true); if (row.kind === 'candidate')
    c.write('legacy_dictionary_candidates', {}, { ...base, definition_ordinal: row.definitionOrdinal, ordinal: row.ordinal, path: JSON.stringify(row.path), priority: Object.is(row.priority, -0) ? '-0' : String(row.priority), business_present: row.businessType === undefined ? 0 : 1, business_type: row.businessType === undefined ? '' : JSON.stringify(row.businessType) }, true); if (row.kind === 'enum') {
    const v = scalarColumns(row.value);
    c.write('legacy_dictionary_enums', {}, { ...base, definition_ordinal: row.definitionOrdinal, ordinal: row.ordinal, value_kind: v.kind, string_value: v.string, number_text: v.number, boolean_value: v.boolean } as SqlRow, true);
} if (row.kind === 'entry')
    c.write('legacy_dictionary_entries', {}, { ...base, definition_ordinal: row.definitionOrdinal, ordinal: row.ordinal, from_identity: JSON.stringify(row.from), ...scalarColumns(row.from, 'from_'), ...scalarColumns(row.to, 'to_') } as SqlRow, true); }
export function appendDictionaryRows(db: DatabaseSync, b: unknown, input: unknown,signal?:AbortSignal): DictionaryReceipt { const r = own(input, ['operationId', 'owner', 'generationId', 'expectedStageRevision', 'rows']); r.operationId = uuid(r.operationId); r.owner = mappingOwner(r.owner); r.generationId = uuid(r.generationId); r.expectedStageRevision = nat(r.expectedStageRevision, 1); r.rows = array(r.rows, 62).map(typedRow); if (!(r.rows as unknown[]).length)
    fail('DICTIONARY_INPUT_INVALID'); boundedCommand(r); return transaction(db, b, r, 'append', (c, o) => { const g = c.generation(String(r.generationId), o); if (g.phase !== 'upload' || g.stage_revision !== r.expectedStageRevision)
    fail('DICTIONARY_STALE_REVISION'); let index = Number(g.next_ordinal), digest = String(g.uploaded_digest), previous = index === 1 ? undefined : readTypedUnit(c, c.point('legacy_dictionary_units', { generation_id: String(r.generationId), ordinal: index - 1 })!); for (const row of r.rows as TypedRow[]) {
    if (row.kind !== expectedKind(g, index))
        fail('DICTIONARY_ORDER_INVALID');
    if (row.kind === 'format' || row.kind === 'definition') {
        const ordinal = previous?.kind === row.kind ? previous.ordinal + 1 : 1;
        if (row.ordinal !== ordinal)
            fail('DICTIONARY_ORDER_INVALID');
    }
    else {
        if (row.definitionOrdinal > Number(g.expected_definitions))
            fail('DICTIONARY_ORDER_INVALID');
        const p = previous && 'definitionOrdinal' in previous && previous.kind === row.kind ? previous : undefined;
        if (p && row.definitionOrdinal < p.definitionOrdinal || row.ordinal !== (p?.definitionOrdinal === row.definitionOrdinal ? p.ordinal + 1 : 1))
            fail('DICTIONARY_ORDER_INVALID');
    }
    storeRow(c, String(r.generationId), row);
    digest = advanceDigest(digest, row);
    c.write('legacy_dictionary_units', {}, { generation_id: String(r.generationId), ordinal: index, kind: row.kind, definition_ordinal: 'definitionOrdinal' in row ? row.definitionOrdinal : row.kind === 'definition' ? row.ordinal : null, item_ordinal: row.ordinal, typed_digest: sha(stable(row)), prefix_digest: digest }, true);
    previous = row;
    index++;
} if (index - 1 > total(g))
    fail('DICTIONARY_ORDER_INVALID'); if (index - 1 === total(g) && digest !== g.content_digest)
    fail('DICTIONARY_CONTENT_MISMATCH'); const next = { ...g, stage_revision: increment(g.stage_revision), next_ordinal: index, uploaded_digest: digest }; c.write('legacy_dictionary_generations', { generation_id: String(r.generationId) }, { stage_revision: next.stage_revision, next_ordinal: index, uploaded_digest: digest }); return resultOf(c, next, o); },undefined,signal); }
function checkParent(c: DictionaryContext, gen: string, row: Extract<TypedRow, {
    kind: 'definition';
}>) { for (const [table, min, max] of [['legacy_dictionary_candidates', 1, 4], ['legacy_dictionary_enums', row.type === 'enum' ? 1 : 0, row.type === 'enum' ? 256 : 0], ['legacy_dictionary_entries', row.conversionKind === 'table' ? 1 : 0, row.conversionKind === 'table' ? 256 : 0]] as const) {
    const n = c.db.prepare(`SELECT COUNT(*) n FROM (SELECT ordinal FROM ${table} WHERE generation_id=? AND definition_ordinal=? LIMIT ?)`).get(gen, row.ordinal, max + 1)!.n;
    c.add(64);
    if (typeof n !== 'number' || n < min || n > max)
        fail('DICTIONARY_CONTENT_INVALID');
} }
function semanticFragment(row: TypedRow): unknown { if (row.kind === 'format' || row.kind === 'enum')
    return row.value; if (row.kind === 'candidate')
    return { path: row.path, priority: row.priority, ...row.businessType === undefined ? {} : { businessType: row.businessType } }; if (row.kind === 'entry')
    return { from: row.from, to: row.to }; return { id: row.id, name: row.name, type: row.type, semantic: row.semantic, ...row.ttlMs === undefined ? {} : { ttlMs: row.ttlMs }, candidates: [], ...row.type === 'enum' ? { enumValues: [] } : {}, ...row.conversionKind ? { conversion: row.conversionKind === 'table' ? { kind: 'table', entries: [] } : { kind: 'decimal' } } : {} }; }
function entryTargetValid(c: DictionaryContext, gen: string, row: Extract<TypedRow, {
    kind: 'entry';
}>) { const d = c.point('legacy_dictionary_definitions', { generation_id: gen, ordinal: row.definitionOrdinal })!; if (!d || d.conversion_kind !== 'table')
    fail('DICTIONARY_CONTENT_INVALID'); const v = row.to, t = d.type; if (t === 'enum') {
    const s = scalarColumns(v);
    const value = c.db.prepare('SELECT 1 FROM legacy_dictionary_enums WHERE generation_id=? AND definition_ordinal=? AND value_kind=? AND string_value IS ? AND number_text IS ? AND boolean_value IS ? LIMIT 1').get(gen, row.definitionOrdinal, s.kind, s.string, s.number, s.boolean);
    c.add(size(row));
    if (!value)
        fail('DICTIONARY_CONTENT_INVALID');
}
else if (t === 'integer' && (typeof v !== 'number' || !Number.isSafeInteger(v)) || t === 'number' && typeof v !== 'number' || t === 'string' && (typeof v !== 'string' || !v.trim()) || t === 'boolean' && typeof v !== 'boolean')
    fail('DICTIONARY_CONTENT_INVALID'); }
export function verifyDictionaryGenerationStep(db: DatabaseSync, b: unknown, input: unknown,signal?:AbortSignal): DictionaryReceipt { const r = own(input, ['operationId', 'owner', 'generationId', 'expectedStageRevision']); r.operationId = uuid(r.operationId); r.owner = mappingOwner(r.owner); r.generationId = uuid(r.generationId); r.expectedStageRevision = nat(r.expectedStageRevision, 1); return transaction(db, b, r, 'verify', (c, o) => { const g = c.generation(String(r.generationId), o); if (g.phase === 'sealed' || g.stage_revision !== r.expectedStageRevision || Number(g.next_ordinal) !== total(g) + 1)
    fail('DICTIONARY_GENERATION_INCOMPLETE'); let ordinal = Number(g.verify_ordinal), digest = String(g.verified_digest), bytes = Number(g.semantic_bytes), nodes = Number(g.node_count); const end = Math.min(total(g), ordinal + 24); for (; ordinal < end;) {
    const unit = c.point('legacy_dictionary_units', { generation_id: String(r.generationId), ordinal: ++ordinal });
    if (!unit)
        fail('DICTIONARY_STORAGE_INVALID');
    const row = readTypedUnit(c, unit);
    if (sha(stable(row)) !== unit.typed_digest)
        fail('DICTIONARY_STORAGE_INVALID');
    digest = advanceDigest(digest, row);
    if (digest !== unit.prefix_digest)
        fail('DICTIONARY_STORAGE_INVALID');
    if (row.kind === 'definition')
        checkParent(c, String(r.generationId), row);
    if (row.kind === 'entry')
        entryTargetValid(c, String(r.generationId), row);
    const metric = graphStats(semanticFragment(row));
    bytes += metric.bytes + String(row.ordinal - 1).length * 3 + 4;
    nodes += metric.nodes;
    if (bytes > Math.min(4194304, c.b.base.limits.maxMetadataBytes) || nodes > 100000)
        fail('DICTIONARY_CONTENT_LIMIT');
} ; const sealed = ordinal === total(g); if (sealed && (digest !== g.content_digest || digest !== g.uploaded_digest))
    fail('DICTIONARY_CONTENT_MISMATCH'); const update = { stage_revision: increment(g.stage_revision), phase: sealed ? 'sealed' : 'verify', verify_ordinal: ordinal, semantic_bytes: bytes, node_count: nodes, verified_digest: digest }; c.write('legacy_dictionary_generations', { generation_id: String(r.generationId) }, update); return resultOf(c, { ...g, ...update }, o, true); },undefined,signal); }
export function saveDictionaryDraft(db: DatabaseSync, b: unknown, input: unknown,signal?:AbortSignal): DictionaryReceipt { const r = own(input, ['operationId', 'owner', 'generationId', 'expectedDictionaryRevision']); r.operationId = uuid(r.operationId); r.owner = mappingOwner(r.owner); r.generationId = uuid(r.generationId); r.expectedDictionaryRevision = nat(r.expectedDictionaryRevision); return transaction(db, b, r, 'save-draft', (c, o) => { headRevision(c, o, Number(r.expectedDictionaryRevision)); const g = c.generation(String(r.generationId), o); if (g.phase !== 'sealed' || g.expected_dictionary_revision !== r.expectedDictionaryRevision)
    fail('DICTIONARY_STALE_REVISION'); const revision = increment(r.expectedDictionaryRevision); c.write('legacy_dictionary_heads', { platform: o.platform, source: o.source }, { revision, draft_generation_id: String(r.generationId), draft_generation_phase: 'sealed' }); return { ...resultOf(c, g, o), resultDictionaryRevision: revision }; },undefined,signal); }
/** Publication owns only dictionary facts; dependency reads are in this same transaction. */
export function publishDictionary(db: DatabaseSync, b: unknown, input: unknown, permit?: unknown,signal?:AbortSignal): DictionaryReceipt { const r = own(input, ['operationId', 'owner', 'expectedDictionaryRevision', 'publishedAt'], ['rollbackFromVersion']); r.operationId = uuid(r.operationId); r.owner = mappingOwner(r.owner); r.expectedDictionaryRevision = nat(r.expectedDictionaryRevision); r.publishedAt = nat(r.publishedAt); if (r.rollbackFromVersion !== undefined)
    r.rollbackFromVersion = nat(r.rollbackFromVersion, 1);
else
    delete r.rollbackFromVersion; return transaction(db, b, r, 'publish', (c, o) => { c.requireInteraction(); const head = headRevision(c, o, Number(r.expectedDictionaryRevision))!, proof = assertDictionaryPermit(c, o, Number(r.expectedDictionaryRevision), permit, r.rollbackFromVersion as number | undefined), g = proof.generation, version = increment(head.last_version), revision = increment(head.revision); c.write('legacy_dictionary_versions', {}, { platform: o.platform, source: o.source, version, generation_id: String(g.generation_id), generation_phase: 'sealed', published_at: Number(r.publishedAt), content_digest: proof.contentDigest }, true); c.write('legacy_dictionary_heads', { platform: o.platform, source: o.source }, { revision, active_version: version, last_version: version }); return { ...resultOf(c, g, o), resultDictionaryRevision: revision,publishedVersion:version }; },permit,signal); }






