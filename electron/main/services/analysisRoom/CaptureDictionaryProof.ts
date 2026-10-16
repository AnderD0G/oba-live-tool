import { types } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { PreviewProofStore, previewDigest, type PreviewBinding } from "./PreviewProofStore";
import { DictionaryContext } from "./CaptureDictionarySchema";
import { materializeDictionary, dictionaryVersion } from "./CaptureDictionaryView";
import { own, mappingOwner, uuid, nat, text, fail, stable, type MappingOwner } from "./CaptureDictionaryDefinition";
export type DictionaryPublicationPermit = Readonly<{
    kind: 'dictionary-publication-permit';
}>;
type PermitData = {
    db: DatabaseSync;
    databaseId: string;
    generation: number;
    runId: string;
    owner: MappingOwner;
    generationId: string;
    revision: number;
    contentDigest: string;
    typedDigest: string;
    dependencyStamp: number;
    rollbackFromVersion?: number;
    proofs: PreviewProofStore;
    token: string;
    binding: PreviewBinding;
};
const permits = new WeakMap<object, PermitData>();
/** Trusted Main adapter only. No token/permit is accepted on a worker wire command. */
export async function dictionaryPublicationPermit(db: DatabaseSync, b: unknown, input: unknown, proofs: PreviewProofStore, token: string, rollbackFromVersion?: number): Promise<DictionaryPublicationPermit> { if (!proofs || types.isProxy(proofs) || Object.getPrototypeOf(proofs) !== PreviewProofStore.prototype || Object.hasOwn(proofs, 'binding') || Object.hasOwn(proofs, 'assertCurrent'))
    fail('DICTIONARY_PREVIEW_STALE'); const c = new DictionaryContext(db, b), o = mappingOwner(input), head = c.ownerHead(o); if (!head || typeof head.draft_generation_id !== 'string')
    fail('DICTIONARY_GENERATION_INCOMPLETE'); const gen = c.generation(head.draft_generation_id, o), dep = c.dependency(o); if (gen.phase !== 'sealed')
    fail('DICTIONARY_GENERATION_INCOMPLETE'); let raw: unknown; try {
    raw = PreviewProofStore.prototype.binding.call(proofs, uuid(token));
}
catch {
    return fail('DICTIONARY_PREVIEW_STALE');
} ; const original = own(raw, ['kind', 'accountId', 'platform', 'source', 'revision', 'sessionId', 'formatVersion', 'adapterFormatVersion', 'start', 'end', 'contentDigest', 'dependencyRevision']); if (original.kind !== 'dictionary' || original.platform !== o.platform || original.source !== o.source)
    fail('DICTIONARY_PREVIEW_STALE'); text(original.accountId, 200); uuid(original.sessionId); nat(original.revision); const format = nat(original.formatVersion, 1), adapter = nat(original.adapterFormatVersion, 1), start = nat(original.start, 1), end = nat(original.end, start); if (end - start + 1 > 200 || !db.prepare('SELECT 1 FROM legacy_dictionary_formats WHERE generation_id=? AND format_version=?').get(gen.generation_id!, format) || !db.prepare('SELECT 1 FROM legacy_dictionary_formats WHERE generation_id=? AND format_version=?').get(gen.generation_id!, adapter))
    fail('DICTIONARY_PREVIEW_STALE'); const assembled = await materializeDictionary(db, b, o, String(gen.generation_id)), contentDigest = previewDigest(assembled), binding: PreviewBinding = { kind: 'dictionary', accountId: text(original.accountId, 200), platform: o.platform, source: o.source, revision: Number(head.revision), sessionId: uuid(original.sessionId), formatVersion: format, adapterFormatVersion: adapter, start, end, contentDigest, dependencyRevision: String(dep.stamp) }; if (stable(binding) !== stable(original))
    fail('DICTIONARY_PREVIEW_STALE'); if (rollbackFromVersion !== undefined) {
    nat(rollbackFromVersion, 1);
    const old = dictionaryVersion(db, b, o, rollbackFromVersion);
    if (!old || previewDigest(await materializeDictionary(db, b, o, old.generationId)) !== contentDigest)
        fail('DICTIONARY_ROLLBACK_INVALID');
} ; const current = new DictionaryContext(db, b), now = current.ownerHead(o), nowdep = current.dependency(o); if (now?.revision !== head.revision || now.draft_generation_id !== gen.generation_id || nowdep.stamp !== dep.stamp)
    fail('DICTIONARY_PREVIEW_STALE'); try {
    PreviewProofStore.prototype.assertCurrent.call(proofs, token, binding);
}
catch {
    return fail('DICTIONARY_PREVIEW_STALE');
} ; const permit = Object.freeze({ kind: 'dictionary-publication-permit' as const }); permits.set(permit, { db, databaseId: c.b.base.identity.databaseId, generation: c.b.base.identity.generation, runId: c.b.base.runId, owner: o, generationId: String(gen.generation_id), revision: Number(head.revision), contentDigest, typedDigest: String(gen.content_digest), dependencyStamp: dep.stamp, ...rollbackFromVersion === undefined ? {} : { rollbackFromVersion }, proofs, token, binding }); return permit; }
export function assertDictionaryPermit(c: DictionaryContext, o: MappingOwner, revision: number, permit: unknown, rollbackFromVersion?: number) { if (!permit || typeof permit !== 'object' || types.isProxy(permit))
    fail('DICTIONARY_PREVIEW_STALE'); const p = permits.get(permit); if (!p || p.db !== c.db || p.databaseId !== c.b.base.identity.databaseId || p.generation !== c.b.base.identity.generation || p.runId !== c.b.base.runId || p.owner.platform !== o.platform || p.owner.source !== o.source || p.revision !== revision || p.rollbackFromVersion !== rollbackFromVersion)
    fail('DICTIONARY_PREVIEW_STALE'); const h = c.ownerHead(o), g = c.generation(p.generationId, o), dep = c.dependency(o); if (h?.revision !== revision || h.draft_generation_id !== p.generationId || g.phase !== 'sealed' || g.content_digest !== p.typedDigest || dep.stamp !== p.dependencyStamp)
    fail('DICTIONARY_PREVIEW_STALE'); if (dep.enabledAccounts !== 0)
    fail('DICTIONARY_GROUP_DEPENDENCY'); try {
    PreviewProofStore.prototype.assertCurrent.call(p.proofs, p.token, p.binding);
}
catch {
    return fail('DICTIONARY_PREVIEW_STALE');
} ; return { generation: g, contentDigest: p.typedDigest }; }
/** Recheck after owned publication writes; the preview itself binds the prior revision. */
export function recheckPublishedDictionaryPermit(c:DictionaryContext,o:MappingOwner,priorRevision:number,publishedVersion:number,permit:unknown){
    if(!permit||typeof permit!=='object'||types.isProxy(permit))fail('DICTIONARY_PREVIEW_STALE')
    const p=permits.get(permit)
    if(!p||p.db!==c.db||p.owner.platform!==o.platform||p.owner.source!==o.source||p.revision!==priorRevision)fail('DICTIONARY_PREVIEW_STALE')
    const head=c.ownerHead(o),g=c.generation(p.generationId,o),v=c.point('legacy_dictionary_versions',{platform:o.platform,source:o.source,version:publishedVersion}),dep=c.dependency(o)
    if(head?.revision!==priorRevision+1||head.active_version!==publishedVersion||head.draft_generation_id!==p.generationId||g.phase!=='sealed'||g.content_digest!==p.typedDigest||v?.generation_id!==p.generationId||v.content_digest!==p.typedDigest||dep.stamp!==p.dependencyStamp)fail('DICTIONARY_PREVIEW_STALE')
    if(dep.enabledAccounts!==0)fail('DICTIONARY_GROUP_DEPENDENCY')
    try{PreviewProofStore.prototype.assertCurrent.call(p.proofs,p.token,p.binding)}catch{return fail('DICTIONARY_PREVIEW_STALE')}
}
