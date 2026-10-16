import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { validateAttributeDraft } from "./AttributeMapper";
import type { AttributeDictionaryDraft, AttributeDefinition, PublishedAttributeDictionary } from "../../../../shared/audienceAttributes";
import { DictionaryContext, type SqlRow } from "./CaptureDictionarySchema";
import { mappingOwner, uuid, nat, own, scalar, scalarColumns, scalarValue, typedRow, fail, size, sha, stable, advanceDigest, ZERO_DIGEST, DictionaryError, type TypedRow, type MappingOwner } from "./CaptureDictionaryDefinition";
export const virtualDictionaryDefault = (): AttributeDictionaryDraft => ({ identity: { userIdPath: '/__not_configured__' }, definitions: [], acceptedFormatVersions: [1] });
export function dictionaryHead(db: DatabaseSync, b: unknown, input: unknown) { const c = new DictionaryContext(db, b), o = mappingOwner(input), r = c.ownerHead(o); if (!r)
    return undefined; return { owner: o, revision: nat(r.revision), ...r.draft_generation_id === null ? {} : { draftGenerationId: uuid(r.draft_generation_id) }, ...r.active_version === null ? {} : { activeVersion: nat(r.active_version, 1) }, lastVersion: nat(r.last_version) }; }
export function dictionaryVersionWithin(c: DictionaryContext, input: unknown, version?: number) { const o = mappingOwner(input), v = version === undefined ? c.ownerHead(o)?.active_version : nat(version, 1); if (v === undefined || v === null)
    return undefined; const r = c.point('legacy_dictionary_versions', { platform: o.platform, source: o.source, version: v }); if (!r)
    return undefined; const g = c.generation(String(r.generation_id), o); if (g.phase !== 'sealed' || r.generation_phase !== 'sealed' || r.content_digest !== g.content_digest)
    fail('DICTIONARY_STORAGE_INVALID'); return { owner: o, version: nat(r.version, 1), generationId: uuid(r.generation_id), publishedAt: nat(r.published_at), contentDigest: String(r.content_digest) }; }
export function dictionaryVersion(db: DatabaseSync, b: unknown, input: unknown, version?: number) { return dictionaryVersionWithin(new DictionaryContext(db, b), input, version); }
export function dictionaryAttributeTypeWithin(c: DictionaryContext, input: unknown, version: number, id: string) { if (typeof id !== 'string' || id.length > 64)
    fail('DICTIONARY_INPUT_INVALID'); const v = dictionaryVersionWithin(c, input, version); if (!v)
    return undefined; const r = c.point('legacy_dictionary_definitions', { generation_id: v.generationId, attribute_id: id }); if (!r)
    return undefined; const value = authenticatedUnit(c, v.generationId, 'definition', Number(r.ordinal), Number(r.ordinal)); if (value.kind !== 'definition')
    fail('DICTIONARY_STORAGE_INVALID'); return { id: value.id, type: value.type, semantic: value.semantic }; }
export function dictionaryAttributeType(db: DatabaseSync, b: unknown, input: unknown, version: number, id: string) { return dictionaryAttributeTypeWithin(new DictionaryContext(db, b), input, version, id); }
export function authenticatedUnit(c: DictionaryContext, gen: string, kind: string, d: number | null, item: number): TypedRow { const units = c.db.prepare('SELECT ordinal FROM legacy_dictionary_units WHERE generation_id=? AND kind=? AND definition_ordinal IS ? AND item_ordinal=? LIMIT 2').all(gen, kind, d, item); c.add(128); if (units.length !== 1)
    fail('DICTIONARY_STORAGE_INVALID'); const ordinal = nat(units[0].ordinal, 1), u = c.point('legacy_dictionary_units', { generation_id: gen, ordinal })!, value = readTypedUnit(c, u); if (sha(stable(value)) !== u.typed_digest)
    fail('DICTIONARY_STORAGE_INVALID'); const previous = ordinal === 1 ? ZERO_DIGEST : c.point('legacy_dictionary_units', { generation_id: gen, ordinal: ordinal - 1 })?.prefix_digest; if (typeof previous !== 'string' || advanceDigest(previous, value) !== u.prefix_digest)
    fail('DICTIONARY_STORAGE_INVALID'); return value; }
export function dictionaryEnumContainsWithin(c: DictionaryContext, input: unknown, version: number, id: string, value: unknown) { const v = dictionaryVersionWithin(c, input, version), validated = scalar(value); if (!v)
    return false; const d = c.point('legacy_dictionary_definitions', { generation_id: v.generationId, attribute_id: id }); if (!d || d.type !== 'enum')
    return false; dictionaryAttributeTypeWithin(c, input, version, id); const s = scalarColumns(validated), r = c.db.prepare('SELECT ordinal FROM legacy_dictionary_enums WHERE generation_id=? AND definition_ordinal=? AND value_kind=? AND string_value IS ? AND number_text IS ? AND boolean_value IS ? ORDER BY ordinal LIMIT 1').get(v.generationId, d.ordinal!, s.kind, s.string, s.number, s.boolean); if (!r)
    return false; const row = authenticatedUnit(c, v.generationId, 'enum', Number(d.ordinal), Number(r.ordinal)); if (row.kind !== 'enum' || !Object.is(row.value, validated))
    fail('DICTIONARY_STORAGE_INVALID'); return true; }
export function dictionaryEnumContains(db: DatabaseSync, b: unknown, input: unknown, version: number, id: string, value: unknown) { return dictionaryEnumContainsWithin(new DictionaryContext(db, b), input, version, id, value); }
/** Trusted checked-context overload; no user-supplied auth DTO or alternate opener. */
export function dictionaryHeadWithin(c: DictionaryContext, input: unknown) { const o = mappingOwner(input), r = c.ownerHead(o); if (!r)
    return undefined; return { owner: o, revision: nat(r.revision), ...r.draft_generation_id === null ? {} : { draftGenerationId: uuid(r.draft_generation_id) }, ...r.active_version === null ? {} : { activeVersion: nat(r.active_version, 1) }, lastVersion: nat(r.last_version) }; }
export function dictionaryChildrenPage(db: DatabaseSync, b: unknown, input: unknown, generationId: string, kind: 'format' | 'candidate' | 'enum' | 'entry', options: {
    definitionOrdinal?: number;
    afterOrdinal?: number;
    limit: number;
}) { const opts = own(options, ['limit'], ['definitionOrdinal', 'afterOrdinal']), c = new DictionaryContext(db, b), o = mappingOwner(input), g = c.generation(uuid(generationId), o); if (g.phase !== 'sealed')
    fail('DICTIONARY_GENERATION_INCOMPLETE'); if (kind !== 'format' && kind !== 'candidate' && kind !== 'enum' && kind !== 'entry')
    fail('DICTIONARY_INPUT_INVALID'); const definition = kind === 'format' ? undefined : nat(opts.definitionOrdinal, 1, 256); if (kind === 'format' && opts.definitionOrdinal !== undefined)
    fail('DICTIONARY_INPUT_INVALID'); const table = { format: 'legacy_dictionary_formats', candidate: 'legacy_dictionary_candidates', enum: 'legacy_dictionary_enums', entry: 'legacy_dictionary_entries' }[kind], p = childPage(c, table, generationId, definition, nat(opts.afterOrdinal ?? 0), nat(opts.limit, 1, 24)); return { items: p.rows.map(r => authenticatedUnit(c, generationId, kind, definition ?? null, Number(r.ordinal))), ...p.nextAfter === undefined ? {} : { nextAfter: p.nextAfter } }; }
export function readTypedUnit(c: DictionaryContext, unit: SqlRow): TypedRow {
    try{
    const gen = String(unit.generation_id), kind = unit.kind, o = Number(unit.item_ordinal), d = Number(unit.definition_ordinal);
    let row: SqlRow | undefined, value: unknown;
    if (kind === 'format') {
        row = c.point('legacy_dictionary_formats', { generation_id: gen, ordinal: o });
        value = row && { kind, ordinal: o, value: row.format_version };
    }
    else if (kind === 'definition') {
        row = c.point('legacy_dictionary_definitions', { generation_id: gen, ordinal: d });
        value = row && { kind, ordinal: d, id: row.attribute_id, name: JSON.parse(String(row.name)), type: row.type, semantic: row.semantic, ...row.ttl_ms === null ? {} : { ttlMs: row.ttl_ms }, ...row.conversion_kind === null ? {} : { conversionKind: row.conversion_kind } };
    }
    else if (kind === 'candidate') {
        row = c.point('legacy_dictionary_candidates', { generation_id: gen, definition_ordinal: d, ordinal: o });
        value = row && { kind, definitionOrdinal: d, ordinal: o, path: JSON.parse(String(row.path)), priority: scalarValue({ kind: 'number', number: row.priority }), ...row.business_present === 0 ? {} : { businessType: JSON.parse(String(row.business_type)) } };
    }
    else if (kind === 'enum') {
        row = c.point('legacy_dictionary_enums', { generation_id: gen, definition_ordinal: d, ordinal: o });
        value = row && { kind, definitionOrdinal: d, ordinal: o, value: scalarValue({ kind: row.value_kind, string: row.string_value, number: row.number_text, boolean: row.boolean_value }) };
    }
    else if (kind === 'entry') {
        row = c.point('legacy_dictionary_entries', { generation_id: gen, definition_ordinal: d, ordinal: o });
        value = row && { kind, definitionOrdinal: d, ordinal: o, from: scalarValue(row, 'from_'), to: scalarValue(row, 'to_') };
    }
    else
        fail('DICTIONARY_STORAGE_INVALID');
    if (!row)
        fail('DICTIONARY_STORAGE_INVALID');
    return typedRow(value);
    }catch(e){if(e instanceof DictionaryError&&e.code==='DICTIONARY_WORK_LIMIT')throw e;return fail('DICTIONARY_STORAGE_INVALID')}
}
function childPage(c: DictionaryContext, table: string, gen: string, definitionOrdinal: number | undefined, after: number, limit: number) { const params: SQLInputValue[] = definitionOrdinal === undefined ? [gen, after, limit + 1] : [gen, definitionOrdinal, after, limit + 1], q = definitionOrdinal === undefined ? `SELECT * FROM ${table} WHERE generation_id=? AND ordinal>? ORDER BY ordinal LIMIT ?` : `SELECT * FROM ${table} WHERE generation_id=? AND definition_ordinal=? AND ordinal>? ORDER BY ordinal LIMIT ?`, rows = c.db.prepare(q).all(...params) as SqlRow[]; if (size(rows) > Math.min(1048576, c.b.base.limits.maxMetadataBytes))
    fail('DICTIONARY_READ_LIMIT'); c.add(size(rows)); return { rows: rows.slice(0, limit), nextAfter: rows.length > limit ? Number(rows[limit - 1].ordinal) : undefined }; }
export function definitionsPage(db: DatabaseSync, b: unknown, input: unknown, generationId: string, options: {
    afterOrdinal?: number;
    limit: number;
}) { const opts = own(options, ['limit'], ['afterOrdinal']), c = new DictionaryContext(db, b), o = mappingOwner(input), g = c.generation(uuid(generationId), o), limit = nat(opts.limit, 1, 100), after = nat(opts.afterOrdinal ?? 0); if (g.phase !== 'sealed')
    fail('DICTIONARY_GENERATION_INCOMPLETE'); const p = childPage(c, 'legacy_dictionary_definitions', generationId, undefined, after, limit); return { items: p.rows.map(r => { const v = authenticatedUnit(c, generationId, 'definition', Number(r.ordinal), Number(r.ordinal)); if (v.kind !== 'definition')
        fail('DICTIONARY_STORAGE_INVALID'); const { kind, ...item } = v; return item; }), ...p.nextAfter === undefined ? {} : { nextAfter: p.nextAfter } }; }
export function versionsPage(db: DatabaseSync, b: unknown, input: unknown, options: {
    upperVersion?: number;
    beforeVersion?: number;
    limit: number;
}) { const opts = own(options, ['limit'], ['upperVersion', 'beforeVersion']), c = new DictionaryContext(db, b), o = mappingOwner(input), head = c.ownerHead(o), upper = nat(opts.upperVersion ?? Number(head?.last_version ?? 0)), before = nat(opts.beforeVersion ?? upper + 1, 1), limit = nat(opts.limit, 1, 100); if (upper > Number(head?.last_version ?? 0) || before > upper + 1)
    fail('DICTIONARY_INPUT_INVALID'); const rows = c.db.prepare('SELECT version,published_at,generation_id FROM legacy_dictionary_versions WHERE platform=? AND source=? AND version<=? AND version<? ORDER BY version DESC LIMIT ?').all(o.platform, o.source, upper, before, limit + 1); return { items: rows.slice(0, limit).map(r => ({ version: Number(r.version), publishedAt: Number(r.published_at), generationId: String(r.generation_id) })), upperVersion: upper, ...rows.length > limit ? { nextBefore: Number(rows[limit - 1].version) } : {} }; }
/** Explicit single-generation assembly; no history cache. Small child pages yield to the host. */
export async function materializeDictionary(db: DatabaseSync, b: unknown, input: unknown, generationId: string): Promise<AttributeDictionaryDraft> {
    const initial = new DictionaryContext(db, b), o = mappingOwner(input), g = initial.generation(uuid(generationId), o);
    if (g.phase !== 'sealed')
        fail('DICTIONARY_GENERATION_INCOMPLETE');
    const out: AttributeDictionaryDraft = { identity: { userIdPath: JSON.parse(String(g.user_id_path)), ...g.nickname_path === null ? {} : { nicknamePath: JSON.parse(String(g.nickname_path)) } }, acceptedFormatVersions: [], definitions: [] };
    let after = 0;
    while (true) {
        const c = new DictionaryContext(db, b), p = childPage(c, 'legacy_dictionary_formats', generationId, undefined, after, 16);
        out.acceptedFormatVersions.push(...p.rows.map(r => { const v = authenticatedUnit(c, generationId, 'format', null, Number(r.ordinal)); return v.kind === 'format' ? v.value : fail('DICTIONARY_STORAGE_INVALID'); }));
        if (p.nextAfter === undefined)
            break;
        after = p.nextAfter;
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    after = 0;
    while (true) {
        const c = new DictionaryContext(db, b), p = childPage(c, 'legacy_dictionary_definitions', generationId, undefined, after, 32);
        for (const row of p.rows) {
            authenticatedUnit(c, generationId, 'definition', Number(row.ordinal), Number(row.ordinal));
            const definition: AttributeDefinition = { id: String(row.attribute_id), name: JSON.parse(String(row.name)), type: row.type as AttributeDefinition['type'], semantic: row.semantic as AttributeDefinition['semantic'], ...row.ttl_ms === null ? {} : { ttlMs: Number(row.ttl_ms) }, candidates: [] };
            const ordinal = Number(row.ordinal);
            for (const [table, tag] of [['legacy_dictionary_candidates', 'candidate'], ['legacy_dictionary_enums', 'enum'], ['legacy_dictionary_entries', 'entry']] as const) {
                let cursor = 0;
                const values: TypedRow[] = [];
                while (true) {
                    const cc = new DictionaryContext(db, b), page = childPage(cc, table, generationId, ordinal, cursor, 32);
                    for (const r of page.rows)
                        values.push(authenticatedUnit(cc, generationId, tag, ordinal, Number(r.ordinal)));
                    if (page.nextAfter === undefined)
                        break;
                    cursor = page.nextAfter;
                    await new Promise<void>(resolve => setImmediate(resolve));
                }
                if (tag === 'candidate')
                    definition.candidates = values.map(v => { if (v.kind !== 'candidate')
                        return fail('DICTIONARY_STORAGE_INVALID'); return { path: v.path, priority: v.priority, ...v.businessType === undefined ? {} : { businessType: v.businessType } }; });
                if (tag === 'enum' && definition.type === 'enum')
                    definition.enumValues = values.map(v => v.kind === 'enum' ? v.value : fail('DICTIONARY_STORAGE_INVALID'));
                if (tag === 'entry' && row.conversion_kind === 'table')
                    definition.conversion = { kind: 'table', entries: values.map(v => v.kind === 'entry' ? { from: v.from, to: v.to } : fail('DICTIONARY_STORAGE_INVALID')) };
            }
            if (row.conversion_kind === 'decimal')
                definition.conversion = { kind: 'decimal' };
            out.definitions.push(definition);
            if (size(out) > initial.b.base.limits.maxMetadataBytes)
                fail('DICTIONARY_READ_LIMIT');
        }
        if (p.nextAfter === undefined)
            break;
        after = p.nextAfter;
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    try {
        return validateAttributeDraft(out);
    }
    catch {
        return fail('DICTIONARY_STORAGE_INVALID');
    }
}
