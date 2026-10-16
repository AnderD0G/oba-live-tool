type Action = 'start' | 'stop' | 'reanalyze';
import { own, nat, text, digest, bytes, fail, add } from './CaptureMetadataRequestDefinition';
import { analysisId } from '../../../../shared/analysisRoom';
function id(v: unknown): string { try {
    return analysisId(v);
}
catch {
    return fail('KEY_RECEIPT_INVALID');
} }
export interface RequestKeyReceipt {
    version: 1;
    kind: 'request-key';
    databaseId: string;
    generation: number;
    schemaVersion: 1;
    baseRunId: string;
    operationId: string;
    intentDigest: string;
    accountId: string;
    requestId: string;
    action: Action;
    expectedRevision: number;
    resultRevision: number;
    watermark: number;
    keyOrdinal: number;
    keyInserted: boolean;
    scopeKnown: boolean;
    encodedBytes: number;
    rowMutations: number;
    byteWork: number;
    retainedImmutableBytes: number;
    retainedMutableBytes: number;
    activationAllowed: false;
    sharedCapacityVerified: false;
    physicalProofVerified: false;
    domainAdmissionVerified: false;
    reused: boolean;
}
const receiptKeys = Object.freeze(['version', 'kind', 'databaseId', 'generation', 'schemaVersion', 'baseRunId', 'operationId', 'intentDigest', 'accountId', 'requestId', 'action', 'expectedRevision', 'resultRevision', 'watermark', 'keyOrdinal', 'keyInserted', 'scopeKnown', 'encodedBytes', 'rowMutations', 'byteWork', 'retainedImmutableBytes', 'retainedMutableBytes', 'activationAllowed', 'sharedCapacityVerified', 'physicalProofVerified', 'domainAdmissionVerified', 'reused']);
function action(v: unknown): void { if (typeof v !== 'string' || !['start', 'stop', 'reanalyze'].includes(v))
    fail('KEY_RECEIPT_INVALID'); }
export function decodeRequestKeyReceipt(value: unknown): RequestKeyReceipt { const r = own(value, receiptKeys); if (r.version !== 1 || r.kind !== 'request-key' || r.schemaVersion !== 1 || r.activationAllowed !== false || r.sharedCapacityVerified !== false || r.physicalProofVerified !== false || r.domainAdmissionVerified !== false)
    fail('KEY_RECEIPT_INVALID'); id(r.databaseId); id(r.baseRunId); nat(r.generation, 1); text(r.operationId, 256); digest(r.intentDigest); text(r.accountId, 200); text(r.requestId, 128); action(r.action); for (const k of ['expectedRevision', 'resultRevision', 'watermark', 'keyOrdinal', 'encodedBytes', 'rowMutations', 'byteWork', 'retainedImmutableBytes', 'retainedMutableBytes'])
    nat(r[k], k === 'expectedRevision' ? 0 : 1); for (const k of ['keyInserted', 'scopeKnown', 'reused'])
    if (typeof r[k] !== 'boolean')
        fail('KEY_RECEIPT_INVALID'); if (r.resultRevision !== add(Number(r.expectedRevision), 1) || r.watermark !== r.resultRevision || Number(r.keyOrdinal) > Number(r.resultRevision) || r.rowMutations !== (r.keyInserted ? 3 : 2) || Number(r.encodedBytes) > 1048576 || Number(r.byteWork) > 1048576 || bytes(r) > 8192)
    fail('KEY_RECEIPT_INVALID'); return r as unknown as RequestKeyReceipt; }
