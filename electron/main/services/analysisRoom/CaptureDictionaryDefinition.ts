import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { analysisId, analysisString, type MappingScope } from "../../../../shared/analysisRoom";
import { normalizeCaptureMetadataOwner, type CaptureMetadataOwner } from "./CaptureMetadataOwner";
import { attributePointer, interpretValue } from "./AttributeMapper";
import { DICTIONARY_DDL } from "./CaptureDictionaryDDL";
export { DICTIONARY_DDL } from "./CaptureDictionaryDDL";
export type MappingOwner = Extract<CaptureMetadataOwner, {
    kind: 'mapping';
}>;
export class DictionaryError extends Error {
    constructor(readonly code: string) { super(code); }
}
export function fail(c: string): never { throw new DictionaryError(c); }
export const sha = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
export const stable = (v: unknown): string => v === null || typeof v !== 'object' ? (Object.is(v, -0) ? '-0' : JSON.stringify(v)) : Array.isArray(v) ? '[' + v.map(stable).join(',') + ']' : '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable((v as Record<string, unknown>)[k])).join(',') + '}';
export const size = (v: unknown) => Buffer.byteLength(stable(v));
export function own(v: unknown, required: readonly string[], optional: readonly string[] = []) { if (!v || typeof v !== 'object' || types.isProxy(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v)))
    fail('DICTIONARY_INPUT_INVALID'); const names = Reflect.ownKeys(v); if (names.length > required.length + optional.length || names.some(k => typeof k !== 'string' || ![...required, ...optional].includes(k)))
    fail('DICTIONARY_INPUT_INVALID'); const out: Record<string, unknown> = {}; for (const k of names) {
    const d = Object.getOwnPropertyDescriptor(v, k)!;
    if (!d.enumerable || !('value' in d))
        fail('DICTIONARY_INPUT_INVALID');
    out[k as string] = d.value;
} if (required.some(k => !Object.hasOwn(out, k)))
    fail('DICTIONARY_INPUT_INVALID'); return out; }
export function nat(v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max)
    fail('DICTIONARY_INPUT_INVALID'); return v; }
export function text(v: unknown, max: number) { try {
    return analysisString(v, max);
}
catch {
    return fail('DICTIONARY_INPUT_INVALID');
} }
export function uuid(v: unknown) { try {
    return analysisId(v);
}
catch {
    return fail('DICTIONARY_INPUT_INVALID');
} }
export function hash(v: unknown) { if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v))
    fail('DICTIONARY_INPUT_INVALID'); return v; }
export function mappingOwner(v: unknown): MappingOwner { let o: CaptureMetadataOwner; try {
    o = normalizeCaptureMetadataOwner(v);
}
catch {
    return fail('DICTIONARY_OWNER_INVALID');
} if (o.kind !== 'mapping')
    fail('DICTIONARY_OWNER_INVALID'); return o; }
export function pointer(v: unknown) { const p = text(v, 2048); try {
    attributePointer(p);
}
catch {
    return fail('DICTIONARY_INPUT_INVALID');
} return p; }
export type Scalar = string | number | boolean;
export function scalar(v: unknown): Scalar { if (typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v) || typeof v === 'string' && v.length > 0 && v.length <= 1024)
    return v; return fail('DICTIONARY_INPUT_INVALID'); }
export function scalarColumns(value: Scalar, prefix = '') { return { [prefix + 'kind']: typeof value, [prefix + 'string']: typeof value === 'string' ? JSON.stringify(value) : null, [prefix + 'number']: typeof value === 'number' ? (Object.is(value, -0) ? '-0' : String(value)) : null, [prefix + 'boolean']: typeof value === 'boolean' ? (value ? 1 : 0) : null }; }
export function scalarValue(row: Record<string, unknown>, prefix = ''): Scalar { const kind = row[prefix + 'kind']; if (kind === 'string' && typeof row[prefix + 'string'] === 'string')
    return scalar(JSON.parse(row[prefix + 'string'] as string)); if (kind === 'number' && typeof row[prefix + 'number'] === 'string') {
    const raw = row[prefix + 'number'] as string, value = raw === '-0' ? -0 : Number(raw);
    if (!Number.isFinite(value) || (Object.is(value, -0) ? '-0' : String(value)) !== raw)
        fail('DICTIONARY_STORAGE_INVALID');
    return value;
} if (kind === 'boolean' && (row[prefix + 'boolean'] === 0 || row[prefix + 'boolean'] === 1))
    return row[prefix + 'boolean'] === 1; return fail('DICTIONARY_STORAGE_INVALID'); }
export type TypedRow = {
    kind: 'format';
    ordinal: number;
    value: number;
} | {
    kind: 'definition';
    ordinal: number;
    id: string;
    name: string;
    type: 'string' | 'number' | 'integer' | 'boolean' | 'enum';
    semantic: 'basic' | 'follow' | 'behavior-reserved';
    ttlMs?: number;
    conversionKind?: 'decimal' | 'table';
} | {
    kind: 'candidate';
    definitionOrdinal: number;
    ordinal: number;
    path: string;
    priority: number;
    businessType?: string;
} | {
    kind: 'enum';
    definitionOrdinal: number;
    ordinal: number;
    value: Scalar;
} | {
    kind: 'entry';
    definitionOrdinal: number;
    ordinal: number;
    from: Scalar;
    to: Scalar;
};
export const kinds = Object.freeze(['format', 'definition', 'candidate', 'enum', 'entry']);
export function typedRow(value: unknown): TypedRow {
    if (!value || typeof value !== 'object' || types.isProxy(value))
        fail('DICTIONARY_INPUT_INVALID');
    const tag = Object.getOwnPropertyDescriptor(value, 'kind');
    if (!tag || !('value' in tag) || typeof tag.value !== 'string' || !kinds.includes(tag.value))
        fail('DICTIONARY_INPUT_INVALID');
    const kind = tag.value, r = kind === 'format' ? own(value, ['kind', 'ordinal', 'value']) : kind === 'definition' ? own(value, ['kind', 'ordinal', 'id', 'name', 'type', 'semantic'], ['ttlMs', 'conversionKind']) : kind === 'candidate' ? own(value, ['kind', 'definitionOrdinal', 'ordinal', 'path', 'priority'], ['businessType']) : kind === 'enum' ? own(value, ['kind', 'definitionOrdinal', 'ordinal', 'value']) : own(value, ['kind', 'definitionOrdinal', 'ordinal', 'from', 'to']);
    r.ordinal = nat(r.ordinal, 1, kind === 'format' ? 16 : kind === 'candidate' ? 4 : 256);
    if ('definitionOrdinal' in r)
        r.definitionOrdinal = nat(r.definitionOrdinal, 1, 256);
    if (kind === 'format')
        r.value = nat(r.value, 1);
    if (kind === 'definition') {
        if (typeof r.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(r.id) || ['constructor', 'prototype'].includes(r.id))
            fail('DICTIONARY_INPUT_INVALID');
        r.name = text(r.name, 128);
        if (typeof r.type !== 'string' || !['string', 'number', 'integer', 'boolean', 'enum'].includes(r.type) || typeof r.semantic !== 'string' || !['basic', 'follow', 'behavior-reserved'].includes(r.semantic))
            fail('DICTIONARY_INPUT_INVALID');
        if (['purchaseCount', 'refundCount', 'orderOwnership'].includes(r.id) && r.semantic !== 'behavior-reserved')
            fail('DICTIONARY_INPUT_INVALID');
        if (r.ttlMs !== undefined)
            r.ttlMs = nat(r.ttlMs, 1000, 2592000000);
        else
            delete r.ttlMs;
        if (r.conversionKind !== undefined) {
            if (r.conversionKind !== 'table' && r.conversionKind !== 'decimal' || r.conversionKind === 'decimal' && !['number', 'integer'].includes(r.type))
                fail('DICTIONARY_INPUT_INVALID');
        }
        else
            delete r.conversionKind;
    }
    if (kind === 'candidate') {
        r.path = pointer(r.path);
        r.priority = nat(r.priority, Number.MIN_SAFE_INTEGER);
        if (r.businessType !== undefined)
            r.businessType = text(r.businessType, 128);
        else
            delete r.businessType;
    }
    if (kind === 'enum')
        r.value = scalar(r.value);
    if (kind === 'entry') {
        r.from = scalar(r.from);
        r.to = scalar(r.to);
    }
    return r as TypedRow;
}
export const normalizeSql = (v: string) => v.replace(/\bIF NOT EXISTS\b/gi, '').replace(/\s+/g, ' ').trim().replace(/;$/, '');
export const objectDefinitions = (ddl: string) => [...(ddl.match(/CREATE (?:TABLE|(?:UNIQUE )?INDEX) [^;]+;/g) ?? []), ...(ddl.match(/CREATE TRIGGER [\s\S]*? END;/g) ?? [])].map(s => { const m = normalizeSql(s).match(/^CREATE (?:UNIQUE )?(TABLE|INDEX|TRIGGER) (\w+)/)!; return Object.freeze({ type: m[1].toLowerCase(), name: m[2], sql: normalizeSql(s) }); });
export const DICTIONARY_OBJECTS = Object.freeze(objectDefinitions(DICTIONARY_DDL)), DICTIONARY_FINGERPRINT = sha(normalizeSql(DICTIONARY_DDL));
export const ZERO_DIGEST = '0'.repeat(64);
export const advanceDigest = (previous: string, row: TypedRow) => { const body = stable(row); return sha(previous + ':' + Buffer.byteLength(body) + ':' + body); };
export function abort(signal?: AbortSignal) { if (signal !== undefined) {
    try {
        if (types.isProxy(signal) || Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!.call(signal))
            fail('DICTIONARY_ABORTED');
    }
    catch {
        return fail('DICTIONARY_ABORTED');
    }
} }
export function array(value: unknown, max: number): unknown[] { if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max)
    fail('DICTIONARY_INPUT_INVALID'); const out: unknown[] = []; if (Reflect.ownKeys(value).length !== value.length + 1)
    fail('DICTIONARY_INPUT_INVALID'); for (let n = 0; n < value.length; n++) {
    const d = Object.getOwnPropertyDescriptor(value, String(n));
    if (!d || !('value' in d) || !d.enumerable)
        fail('DICTIONARY_INPUT_INVALID');
    out.push(d.value);
} return out; }
export function graphStats(value: unknown): {
    bytes: number;
    nodes: number;
} { if (value === null)
    return { bytes: 5, nodes: 1 }; if (typeof value === 'string')
    return { bytes: value.length * 3 + 2, nodes: 1 }; if (typeof value === 'number')
    return { bytes: 24, nodes: 1 }; if (typeof value === 'boolean')
    return { bytes: 5, nodes: 1 }; let bytes = 0, nodes = 1; for (const [k, v] of Object.entries(value as object)) {
    bytes += k.length * 3 + 4;
    const r = graphStats(v);
    bytes += r.bytes;
    nodes += r.nodes;
} return { bytes, nodes }; }
