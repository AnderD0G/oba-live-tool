import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { readTypedStageAdmission, TYPED_STAGE_DDL } from "./CaptureTypedStageSchema";
import { BASE_NAMES, normalized, baseHeader, type RequestKeyBinding } from "./CaptureMetadataRequestDefinition";
import { DICTIONARY_DDL, DICTIONARY_OBJECTS, DICTIONARY_FINGERPRINT, objectDefinitions, normalizeSql, stable, size, sha, fail, nat, own, DictionaryError, type MappingOwner } from "./CaptureDictionaryDefinition";
import { INTERACTION_DDL } from "./CaptureInteractionDefinition";
import { insertInteractionBootstrapWithin } from "./CaptureInteractionSchema";
export type DictionaryBinding = RequestKeyBinding & {
    catalog: 'dictionary' | 'dictionary-interaction';
};
export function normalizeDictionaryBinding(input: unknown): DictionaryBinding { const r = own(input, ['base', 'policy'], ['catalog']); if (r.catalog !== undefined && r.catalog !== 'dictionary' && r.catalog !== 'dictionary-interaction')
    fail('DICTIONARY_INPUT_INVALID'); return { ...normalized({ base: r.base, policy: r.policy }), catalog: r.catalog === 'dictionary-interaction' ? 'dictionary-interaction' : 'dictionary' }; }
export type SqlRow = Record<string, SQLInputValue>;
const BASE_FINGERPRINT = '76817cee32be166ef95b0fb3d30f68177e9095bacdc297525d0afe94caba867d';
export class DictionaryContext {
    work = 0;
    changes = 0;
    immutable = 0;
    mutableDelta = 0;
    encoded = 0;
    readonly b: DictionaryBinding;
    constructor(readonly db: DatabaseSync, input: unknown) { this.b = normalizeDictionaryBinding(input);if(db.prepare('SELECT 1 FROM sqlite_temp_master LIMIT 1').get())fail('DICTIONARY_SCHEMA_INVALID'); for (const [k, v] of [['database_id', this.b.base.identity.databaseId], ['generation', String(this.b.base.identity.generation)], ['schema_version', '1']])
        if (db.prepare('SELECT substr(value,1,65) value FROM database_meta WHERE key=?').get(k)?.value !== v)
            fail('DICTIONARY_SCHEMA_INVALID'); for (const [k, v] of [['version', '1'], ['status', 'verified'], ['inventory_complete', '1']])
        if (db.prepare('SELECT substr(value,1,33) value FROM legacy_import_meta WHERE key=?').get(k)?.value !== v)
            fail('DICTIONARY_SCHEMA_INVALID'); this.admit(); if (this.b.catalog === 'dictionary-interaction')
        this.requireInteraction(); }
    add(n: number) { if (!Number.isSafeInteger(n) || n < 0 || this.work + n > Math.min(1048576, this.b.policy.maxStepByteWork))
        fail('DICTIONARY_WORK_LIMIT'); this.work += n; }
    table(name: string) { if (!DICTIONARY_OBJECTS.some(o => o.type === 'table' && o.name === name))
        fail('DICTIONARY_STORAGE_INVALID'); return name; }
    point(table: string, keys: SqlRow) { this.table(table); const cols = this.db.prepare(`PRAGMA table_info(${table})`).all().map(r => String(r.name)); if (cols.length > 64 || !Object.keys(keys).length || Object.keys(keys).some(k => !cols.includes(k)))
        fail('DICTIONARY_STORAGE_INVALID'); const condition = Object.keys(keys).map(k => `${k} IS ?`).join(' AND '), lengths = this.db.prepare(`SELECT ${cols.map(k => `length(CAST(${k} AS BLOB)) ${k}`).join(',')} FROM ${table} WHERE ${condition}`).get(...Object.values(keys)); if (!lengths)
        return undefined; let total = 0; for (const value of Object.values(lengths)) {
        if (value !== null && (typeof value !== 'number' || value > 16384))
            fail('DICTIONARY_STORAGE_INVALID');
        total += Number(value ?? 0);
    } this.add(3 * total); return this.db.prepare(`SELECT * FROM ${table} WHERE ${condition}`).get(...Object.values(keys)) as SqlRow; }
    ownerHead(o: MappingOwner) { return this.point('legacy_dictionary_heads', { platform: o.platform, source: o.source }); }
    generation(id: string, o: MappingOwner) { const g = this.point('legacy_dictionary_generations', { generation_id: id }); if (!g || g.platform !== o.platform || g.source !== o.source)
        fail('DICTIONARY_OWNER_INVALID'); return g!; }
    accounting() { const row = this.point('legacy_dictionary_accounting', { base_run_id: this.b.base.runId }); if (!row || row.revision !== row.watermark || row.revision !== row.receipt_count)
        fail('DICTIONARY_STORAGE_INVALID'); for (const k of ['revision', 'immutable_bytes', 'mutable_bytes'])
        nat(row![k]); if (Number(row.immutable_bytes) + Number(row.mutable_bytes) > this.b.policy.maxRetainedDerivedBytes || !Number.isSafeInteger(Number(row.immutable_bytes) + Number(row.mutable_bytes)))
        fail('DICTIONARY_STORAGE_INVALID'); if (row.revision === 0) {
        if (row.last_operation_id !== null || row.immutable_bytes !== size(this.point('legacy_dictionary_meta', { singleton: 1 })) || row.mutable_bytes !== size(row))
            fail('DICTIONARY_STORAGE_INVALID');
    }
    else {
        if (typeof row.last_operation_id !== 'string')
            fail('DICTIONARY_STORAGE_INVALID');
        const receipt = this.point('legacy_dictionary_receipts', { operation_id: row.last_operation_id });
        if (!receipt || typeof receipt.receipt_json !== 'string' || sha(receipt.receipt_json) !== receipt.receipt_digest)
            fail('DICTIONARY_STORAGE_INVALID');
        let saved: Record<string, unknown>;
        try {
            saved = JSON.parse(receipt.receipt_json);
        }
        catch {
            return fail('DICTIONARY_STORAGE_INVALID');
        }
        ;
        if (saved.revision !== row.revision || saved.watermark !== row.watermark || saved.operationId !== row.last_operation_id || saved.retainedImmutableBytes !== row.immutable_bytes || saved.retainedMutableBytes !== row.mutable_bytes || saved.databaseId !== this.b.base.identity.databaseId || saved.baseRunId !== this.b.base.runId || saved.generation !== this.b.base.identity.generation)
            fail('DICTIONARY_STORAGE_INVALID');
    } return row!; }
    write(table: string, keys: SqlRow, value: SqlRow, immutable = false) { this.table(table); const columns = Object.keys(value), where = Object.keys(keys), allowed = this.db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name); if (!columns.length || columns.some(k => !allowed.includes(k)) || where.some(k => !allowed.includes(k)))
        fail('DICTIONARY_STORAGE_INVALID'); const before = where.length ? this.point(table, keys) : undefined; if (where.length && !before)
        fail('DICTIONARY_STALE_REVISION'); const next = { ...before, ...value }, encoded = size(value) + size(keys); this.add(3 * encoded); this.encoded += encoded; if (immutable)
        this.immutable += size(next);
    else
        this.mutableDelta += size(next) - (before ? size(before) : 0); const result = where.length ? this.db.prepare(`UPDATE ${table} SET ${columns.map(k => `${k}=?`).join(',')} WHERE ${where.map(k => `${k} IS ?`).join(' AND ')}`).run(...Object.values(value), ...Object.values(keys)) : this.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...Object.values(value)); if (result.changes !== 1)
        fail('DICTIONARY_STALE_REVISION'); if (++this.changes > this.b.policy.maxStepMutations || this.encoded > this.b.policy.maxStepEncodedBytes)
        fail('DICTIONARY_STEP_LIMIT'); }
    private admit() { const defs = [...objectDefinitions(TYPED_STAGE_DDL), ...DICTIONARY_OBJECTS, ...this.b.catalog === 'dictionary-interaction' ? objectDefinitions(INTERACTION_DDL) : []], wanted = [...BASE_NAMES, ...defs.map(d => d.name)], rows = this.db.prepare("SELECT type,substr(name,1,129) name,length(CAST(sql AS BLOB)) n FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name LIMIT ?").all(wanted.length + 1); if (rows.length !== wanted.length || rows.some(r => typeof r.name !== 'string' || !wanted.includes(r.name) || typeof r.n !== 'number' || r.n < 1 || r.n > 32768))
        fail('DICTIONARY_SCHEMA_INVALID'); const base: string[] = []; for (const r of rows) {
        this.add(3 * Number(r.n));
        const row = this.db.prepare('SELECT substr(sql,1,32769) sql FROM sqlite_master WHERE name=? AND type=?').get(r.name, r.type);
        if (typeof row?.sql !== 'string')
            fail('DICTIONARY_SCHEMA_INVALID');
        const sql = normalizeSql(row.sql);
        if (BASE_NAMES.includes(String(r.name)))
            base.push(`${r.type}|${r.name}|${sql}\n`);
        else if (!defs.some(d => d.name === r.name && d.type === r.type && d.sql === sql))
            fail('DICTIONARY_SCHEMA_INVALID');
    } if (sha(base.join('')) !== BASE_FINGERPRINT)
        fail('DICTIONARY_SCHEMA_INVALID'); const h = baseHeader(this.db, this.b), meta = this.point('legacy_dictionary_meta', { singleton: 1 }); this.add(h.work); if (!meta || meta.version !== 1 || meta.database_id !== this.b.base.identity.databaseId || meta.generation !== this.b.base.identity.generation || meta.base_run_id !== this.b.base.runId || meta.base_header_digest !== sha(stable(h.header)) || meta.schema_fingerprint !== DICTIONARY_FINGERPRINT || meta.policy_digest !== sha(stable(this.b.policy)) || meta.catalog_mode !== this.b.catalog || meta.schema_complete !== 0 || meta.activation_allowed !== 0)
        fail('DICTIONARY_SCHEMA_INVALID'); }
    requireInteraction() { if (this.b.catalog !== 'dictionary-interaction')
        fail('DICTIONARY_DEPENDENCY_UNAVAILABLE'); const rows = this.db.prepare('SELECT singleton,length(CAST(base_header_digest AS BLOB)) n FROM legacy_interaction_meta LIMIT 2').all(); if (rows.length !== 1 || rows[0].singleton !== 1 || rows[0].n !== 64)
        fail('DICTIONARY_DEPENDENCY_UNAVAILABLE'); const h = baseHeader(this.db, this.b), r = this.db.prepare('SELECT * FROM legacy_interaction_meta WHERE singleton=1').get(); this.add(h.work); if (!r || size(r) > 16384 || r.version !== 1 || r.database_id !== this.b.base.identity.databaseId || r.generation !== this.b.base.identity.generation || r.base_run_id !== this.b.base.runId || r.base_header_digest !== sha(stable(h.header)) || r.schema_fingerprint !== sha(normalizeSql(INTERACTION_DDL)) || r.policy_digest !== sha(stable({ policy: this.b.policy, catalog: this.b.catalog })) || r.schema_complete !== 0 || r.activation_allowed !== 0)
        fail('DICTIONARY_DEPENDENCY_UNAVAILABLE'); this.add(size(r)); }
    dependency(o: MappingOwner) { this.requireInteraction(); const r = this.db.prepare('SELECT stamp,referenced_accounts,enabled_accounts FROM legacy_interaction_mapping_dependencies WHERE platform=? AND source=?').get(o.platform, o.source); if (!r)
        return { stamp: 0, referencedAccounts: 0, enabledAccounts: 0 }; const stamp = nat(r.stamp), referencedAccounts = nat(r.referenced_accounts), enabledAccounts = nat(r.enabled_accounts); if (enabledAccounts > referencedAccounts)
        fail('DICTIONARY_STORAGE_INVALID'); this.add(size(r)); return { stamp, referencedAccounts, enabledAccounts }; }
}
function insertOwnBootstrap(db: DatabaseSync, b: DictionaryBinding) { const h = baseHeader(db, b).header, meta = { singleton: 1, version: 1, database_id: b.base.identity.databaseId, generation: b.base.identity.generation, base_run_id: b.base.runId, base_header_digest: sha(stable(h)), schema_fingerprint: DICTIONARY_FINGERPRINT, policy_digest: sha(stable(b.policy)), catalog_mode: b.catalog, schema_complete: 0, activation_allowed: 0 }; const run = { base_run_id: b.base.runId, revision: 0, watermark: 0, receipt_count: 0, immutable_bytes: size(meta), mutable_bytes: 0, last_operation_id: null }; for (let n = 0; n < 16; n++) {
    const actual = size(run);
    if (run.mutable_bytes === actual)
        break;
    run.mutable_bytes = actual;
} if (size(meta) + size(run) > Math.min(b.policy.maxRetainedDerivedBytes, b.policy.maxStepEncodedBytes, b.base.limits.maxMetadataBytes) || b.policy.maxStepMutations < (b.catalog === 'dictionary-interaction' ? 4 : 2))
    fail('DICTIONARY_STEP_LIMIT'); for (const [table, r] of [['legacy_dictionary_meta', meta], ['legacy_dictionary_accounting', run]] as const) {
    const cols = Object.keys(r);
    db.prepare(`INSERT INTO ${table}(${cols}) VALUES(${cols.map(() => '?')})`).run(...Object.values(r));
} }
function bootstrap(db: DatabaseSync, b: DictionaryBinding) { if (db.isTransaction)
    fail('DICTIONARY_INPUT_INVALID'); if (db.prepare('PRAGMA synchronous').get()?.synchronous !== 2 || db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1 || db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal')
    fail('DICTIONARY_DURABILITY_INVALID'); try {
    const admission = readTypedStageAdmission(db, b.base, 1048576);
    if (admission.sourceBytes > b.policy.maxSourceBytes)
        fail('DICTIONARY_SOURCE_LIMIT');
}
catch {
    return fail('DICTIONARY_SCHEMA_INVALID');
} ; let attempted = false; try {
    db.exec('BEGIN IMMEDIATE');
    readTypedStageAdmission(db, b.base, 1048576);
    db.exec(DICTIONARY_DDL);
    if (b.catalog === 'dictionary-interaction')
        db.exec(INTERACTION_DDL);
    insertOwnBootstrap(db, b);
    if (b.catalog === 'dictionary-interaction')
        insertInteractionBootstrapWithin(db, b);
    const c = new DictionaryContext(db, b);
    if (b.catalog === 'dictionary-interaction')
        c.requireInteraction();
    attempted = true;
    db.exec('COMMIT');
}
catch (e) {
    try {
        if (db.isTransaction)
            db.exec('ROLLBACK');
    }
    catch { }
    if (attempted)
        fail('DICTIONARY_COMMIT_UNCERTAIN');
    if (e instanceof DictionaryError)
        throw e;
    fail('DICTIONARY_SCHEMA_INVALID');
} }
export function initializeDictionarySchema(db: DatabaseSync, input: unknown, mode: 'create' | 'resume') { const b = normalizeDictionaryBinding(input); if (mode === 'resume') {
    new DictionaryContext(db, b);
    return;
} if (mode !== 'create' || b.catalog !== 'dictionary')
    fail('DICTIONARY_INPUT_INVALID'); bootstrap(db, b); }
export function initializeLinkedDictionarySchema(db: DatabaseSync, input: unknown) { const b = normalizeDictionaryBinding(input); if (b.catalog !== 'dictionary-interaction')
    fail('DICTIONARY_INPUT_INVALID'); bootstrap(db, b); }

