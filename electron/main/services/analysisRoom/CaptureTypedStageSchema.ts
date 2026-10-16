import {CAPACITY_OBJECT_DEFINITIONS} from './CaptureCapacityDefinitionV2'
import { createHash } from 'node:crypto'
import { types } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import { analysisId } from '../../../../shared/analysisRoom'
import type { CaptureLimits } from '../../../../shared/analysisRoom'
import { CAPTURE_STORAGE_LIMITS, validateCaptureStorageLimits, type CaptureDatabaseIdentity } from './CaptureStorage'
import { preflightCaptureValue, validateCaptureIdentity } from './CaptureWorkerProtocol'
import {PROJECTION_STAGE_KIND,PROJECTION_STAGE_CAPABILITY,PROJECTION_STAGE_FINGERPRINT,PROJECTION_OBJECT_DEFINITIONS,PROJECTION_HEADER_KEYS,projectionExact,normalizeProjectionBinding,projectionDigest,projectionStable,projectionFailure,type ProjectionBinding,type ProjectionAdmission} from './CaptureTypedProjectionDefinition'

/** Unconsumed private typed-stage schema. No importer, worker or authority publication. */
export const TYPED_STAGE_KIND = 'legacy-typed'
export const TYPED_STAGE_VERSION = 1
export const TYPED_STAGE_CAPABILITY = 'session-metadata-v1'
export const TYPED_STAGE_DDL = `CREATE TABLE legacy_typed_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
CREATE TABLE legacy_typed_runs(
 run_id TEXT PRIMARY KEY,policy_digest TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=1),
 watermark INTEGER NOT NULL CHECK(watermark=revision),receipt_count INTEGER NOT NULL CHECK(receipt_count=revision),
 encoded_bytes INTEGER NOT NULL CHECK(encoded_bytes>=0),
 phase TEXT NOT NULL CHECK(phase IN('roles','metadata','charges','metadata-complete')),
 after_source_id INTEGER NOT NULL CHECK(after_source_id>=0),next_ordinal INTEGER NOT NULL CHECK(next_ordinal>=1),
 classified_sources INTEGER NOT NULL CHECK(classified_sources>=0),accepted_metadata INTEGER NOT NULL CHECK(accepted_metadata>=0),
 seeded_sessions INTEGER NOT NULL CHECK(seeded_sessions>=0),charged_sources INTEGER NOT NULL CHECK(charged_sources>=0),
 rejected INTEGER NOT NULL CHECK(rejected>=0),deferred INTEGER NOT NULL CHECK(deferred>=0),
 retained INTEGER NOT NULL CHECK(retained>=0),unresolved INTEGER NOT NULL CHECK(unresolved>=0),
 canonical_evidence_bytes INTEGER NOT NULL CHECK(canonical_evidence_bytes>=0)
) STRICT;
CREATE TABLE legacy_typed_sources(
 run_id TEXT NOT NULL,source_id INTEGER NOT NULL CHECK(source_id>=1),
 role TEXT NOT NULL CHECK(role IN('canonical-session','canonical-records','canonical-native','retained-alternate',
 'deferred-request','deferred-dictionary','deferred-history','deferred-config','unresolved-path')),
 source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
 source_size INTEGER NOT NULL CHECK(source_size>=0 AND source_size<=5368709120),session_hint TEXT,
 status TEXT NOT NULL CHECK(status IN('classified','accepted','rejected','retained','deferred','unresolved')),code TEXT,
 metadata_progress TEXT NOT NULL CHECK(metadata_progress IN('not-applicable','pending','accepted','rejected','deferred')),
 charge_progress TEXT NOT NULL CHECK(charge_progress IN('not-applicable','pending','charged','unresolved')),
 revision INTEGER NOT NULL CHECK(revision>=0),PRIMARY KEY(run_id,source_id),UNIQUE(run_id,source_id,role),
 FOREIGN KEY(run_id) REFERENCES legacy_typed_runs(run_id),FOREIGN KEY(source_id) REFERENCES legacy_sources(id),
 CHECK((role IN('canonical-session','canonical-records','canonical-native') AND session_hint IS NOT NULL)
 OR (role NOT IN('canonical-session','canonical-records','canonical-native') AND session_hint IS NULL))
) STRICT;
CREATE TABLE legacy_typed_units(
 run_id TEXT NOT NULL,source_id INTEGER NOT NULL,start_offset INTEGER NOT NULL CHECK(start_offset>=0),
 next_offset INTEGER NOT NULL CHECK(next_offset>start_offset),unit_kind TEXT NOT NULL CHECK(unit_kind IN('file','line')),
 line INTEGER,outcome TEXT NOT NULL CHECK(outcome IN('accepted','rejected','unresolved','retained','deferred')),code TEXT,
 hash_status TEXT NOT NULL CHECK(hash_status IN('literal','source-span-only')),literal_sha256 TEXT,
 session_id TEXT,account_id TEXT,platform TEXT,source TEXT,capture_position INTEGER,
 PRIMARY KEY(run_id,source_id,start_offset),
 UNIQUE(run_id,source_id,start_offset,outcome,session_id,account_id,platform,source),
 FOREIGN KEY(run_id,source_id) REFERENCES legacy_typed_sources(run_id,source_id),
 FOREIGN KEY(source_id,line) REFERENCES legacy_lines(source_id,line),
 FOREIGN KEY(session_id,account_id,platform,source) REFERENCES sessions(id,account_id,platform,source),
 CHECK((unit_kind='line' AND line IS NOT NULL AND line>=1) OR (unit_kind='file' AND line IS NULL AND start_offset=0)),
 CHECK((session_id IS NULL AND account_id IS NULL AND platform IS NULL AND source IS NULL)
 OR (session_id IS NOT NULL AND account_id IS NOT NULL AND platform IS NOT NULL AND source IS NOT NULL)),
 CHECK(outcome<>'accepted' OR session_id IS NOT NULL),
 CHECK((hash_status='literal' AND literal_sha256 IS NOT NULL AND length(literal_sha256)=64
 AND literal_sha256 NOT GLOB '*[^0-9a-f]*' AND next_offset-start_offset<=131074)
 OR (hash_status='source-span-only' AND literal_sha256 IS NULL)),
 CHECK(outcome<>'accepted' OR hash_status='literal'),CHECK(capture_position IS NULL OR capture_position>=1)
) STRICT;
CREATE UNIQUE INDEX legacy_typed_capture_owner ON capture_rows(physical_position,session_id,account_id,platform,source);
CREATE TABLE legacy_declared_sessions(
 run_id TEXT NOT NULL,session_id TEXT NOT NULL,metadata_source_id INTEGER NOT NULL,metadata_offset INTEGER NOT NULL CHECK(metadata_offset=0),
 metadata_outcome TEXT NOT NULL CHECK(metadata_outcome='accepted'),account_id TEXT NOT NULL,platform TEXT NOT NULL,source TEXT NOT NULL,
 declared_session_json TEXT NOT NULL CHECK(length(CAST(declared_session_json AS BLOB))<=16384 AND json_valid(declared_session_json)),
 created_sequence INTEGER,created_sequence_present INTEGER NOT NULL CHECK(created_sequence_present IN(0,1)),
 seed_ordinal INTEGER NOT NULL CHECK(seed_ordinal>=1),ordinal_policy TEXT NOT NULL CHECK(ordinal_policy='source-id-v1'),
 normalization_timestamp INTEGER NOT NULL CHECK(normalization_timestamp>=0),stopped_at_derived INTEGER NOT NULL CHECK(stopped_at_derived IN(0,1)),
 declared_originals_present INTEGER NOT NULL CHECK(declared_originals_present IN(0,1)),
 PRIMARY KEY(run_id,session_id),UNIQUE(run_id,session_id,account_id,platform,source),UNIQUE(run_id,metadata_source_id),UNIQUE(run_id,seed_ordinal),
 FOREIGN KEY(session_id,account_id,platform,source) REFERENCES sessions(id,account_id,platform,source),
 FOREIGN KEY(run_id,metadata_source_id,metadata_offset,metadata_outcome,session_id,account_id,platform,source)
 REFERENCES legacy_typed_units(run_id,source_id,start_offset,outcome,session_id,account_id,platform,source),
 CHECK((created_sequence_present=0 AND created_sequence IS NULL) OR (created_sequence_present=1 AND created_sequence>=1 AND created_sequence IS NOT NULL))
) STRICT;
CREATE TABLE legacy_session_stats(
 run_id TEXT NOT NULL,session_id TEXT NOT NULL,account_id TEXT NOT NULL,platform TEXT NOT NULL,source TEXT NOT NULL,
 projection_state TEXT NOT NULL CHECK(projection_state IN('not-projected','projecting','reconciled-partial')),
 accepted_count INTEGER NOT NULL CHECK(accepted_count>=0),rejected_count INTEGER NOT NULL CHECK(rejected_count>=0),
 unresolved_count INTEGER NOT NULL CHECK(unresolved_count>=0),max_record_sequence INTEGER NOT NULL CHECK(max_record_sequence>=0),
 parse_failed INTEGER NOT NULL CHECK(parse_failed>=0),redacted INTEGER NOT NULL CHECK(redacted>=0),
 native_valid_count INTEGER NOT NULL CHECK(native_valid_count>=0),native_rejected_count INTEGER NOT NULL CHECK(native_rejected_count>=0),
 paired_count INTEGER NOT NULL CHECK(paired_count>=0),orphan_count INTEGER NOT NULL CHECK(orphan_count>=0),ambiguous_count INTEGER NOT NULL CHECK(ambiguous_count>=0),
 charged_record_bytes INTEGER NOT NULL CHECK(charged_record_bytes>=0),charged_native_bytes INTEGER NOT NULL CHECK(charged_native_bytes>=0),
 witnessed_native_present INTEGER NOT NULL CHECK(witnessed_native_present IN(0,1)),revision INTEGER NOT NULL CHECK(revision>=0),
 PRIMARY KEY(run_id,session_id),FOREIGN KEY(run_id,session_id,account_id,platform,source)
 REFERENCES legacy_declared_sessions(run_id,session_id,account_id,platform,source)
) STRICT;
CREATE TABLE legacy_source_charges(
 run_id TEXT NOT NULL,source_id INTEGER NOT NULL,role TEXT NOT NULL CHECK(role IN('canonical-records','canonical-native')),
 source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),source_size INTEGER NOT NULL CHECK(source_size>=0),
 session_id TEXT NOT NULL,account_id TEXT NOT NULL,platform TEXT NOT NULL,source TEXT NOT NULL,
 charged_bytes INTEGER NOT NULL CHECK(charged_bytes=source_size),original_byte_delta INTEGER NOT NULL CHECK(original_byte_delta>=0),
 PRIMARY KEY(run_id,source_id),FOREIGN KEY(run_id,source_id,role) REFERENCES legacy_typed_sources(run_id,source_id,role),
 FOREIGN KEY(source_id) REFERENCES legacy_sources(id),FOREIGN KEY(run_id,session_id,account_id,platform,source)
 REFERENCES legacy_declared_sessions(run_id,session_id,account_id,platform,source),
 CHECK((role='canonical-native' AND original_byte_delta=source_size) OR (role='canonical-records' AND original_byte_delta=0))
) STRICT;
CREATE TABLE legacy_capture_links(
 capture_position INTEGER PRIMARY KEY,run_id TEXT NOT NULL,source_id INTEGER NOT NULL,start_offset INTEGER NOT NULL,
 unit_outcome TEXT NOT NULL CHECK(unit_outcome='accepted'),session_id TEXT NOT NULL,account_id TEXT NOT NULL,
 platform TEXT NOT NULL,source TEXT NOT NULL,UNIQUE(run_id,source_id,start_offset),
 FOREIGN KEY(capture_position,session_id,account_id,platform,source)
 REFERENCES capture_rows(physical_position,session_id,account_id,platform,source),
 FOREIGN KEY(run_id,source_id,start_offset,unit_outcome,session_id,account_id,platform,source)
 REFERENCES legacy_typed_units(run_id,source_id,start_offset,outcome,session_id,account_id,platform,source)
) STRICT;
CREATE TABLE legacy_native_units(
 run_id TEXT NOT NULL,source_id INTEGER NOT NULL,start_offset INTEGER NOT NULL,origin TEXT NOT NULL CHECK(origin='legacy-envelope'),
 validation_status TEXT NOT NULL CHECK(validation_status IN('accepted','rejected','unresolved','deferred')),
 session_id TEXT,account_id TEXT,platform TEXT,source TEXT,record_sequence INTEGER,original_sequence INTEGER,
 order_status TEXT NOT NULL CHECK(order_status IN('pending','valid','invalid','unresolved')),complete INTEGER CHECK(complete IN(0,1)),
 upstream_json BLOB CHECK(upstream_json IS NULL),upstream_sha256 TEXT CHECK(upstream_sha256 IS NULL),
 PRIMARY KEY(run_id,source_id,start_offset),UNIQUE(run_id,source_id,start_offset,session_id,account_id,platform,source),
 FOREIGN KEY(run_id,source_id,start_offset) REFERENCES legacy_typed_units(run_id,source_id,start_offset),
 FOREIGN KEY(session_id,account_id,platform,source) REFERENCES sessions(id,account_id,platform,source),
 CHECK((session_id IS NULL AND account_id IS NULL AND platform IS NULL AND source IS NULL)
 OR (session_id IS NOT NULL AND account_id IS NOT NULL AND platform IS NOT NULL AND source IS NOT NULL)),
 CHECK(record_sequence IS NULL OR record_sequence>=1),CHECK(original_sequence IS NULL OR original_sequence>=1),
 CHECK(validation_status<>'accepted' OR (session_id IS NOT NULL AND record_sequence IS NOT NULL AND original_sequence IS NOT NULL))
) STRICT;
CREATE TABLE legacy_native_links(
 run_id TEXT NOT NULL,native_source_id INTEGER NOT NULL,native_offset INTEGER NOT NULL,
 pairing_status TEXT NOT NULL CHECK(pairing_status IN('paired','orphan','ambiguous','unresolved')),code TEXT,
 capture_position INTEGER,session_id TEXT,account_id TEXT,platform TEXT,source TEXT,
 PRIMARY KEY(run_id,native_source_id,native_offset),UNIQUE(capture_position),
 FOREIGN KEY(run_id,native_source_id,native_offset) REFERENCES legacy_native_units(run_id,source_id,start_offset),
 FOREIGN KEY(run_id,native_source_id,native_offset,session_id,account_id,platform,source)
 REFERENCES legacy_native_units(run_id,source_id,start_offset,session_id,account_id,platform,source),
 FOREIGN KEY(capture_position,session_id,account_id,platform,source)
 REFERENCES capture_rows(physical_position,session_id,account_id,platform,source),
 CHECK((session_id IS NULL AND account_id IS NULL AND platform IS NULL AND source IS NULL)
 OR (session_id IS NOT NULL AND account_id IS NOT NULL AND platform IS NOT NULL AND source IS NOT NULL)),
 CHECK((pairing_status='paired' AND capture_position IS NOT NULL AND session_id IS NOT NULL)
 OR (pairing_status<>'paired' AND capture_position IS NULL))
) STRICT;
CREATE TABLE legacy_pair_groups(
 run_id TEXT NOT NULL,session_id TEXT NOT NULL,account_id TEXT NOT NULL,platform TEXT NOT NULL,source TEXT NOT NULL,
 record_sequence INTEGER NOT NULL CHECK(record_sequence>=1),phase TEXT NOT NULL CHECK(phase IN('captures','natives','frozen')),
 revision INTEGER NOT NULL CHECK(revision>=0),capture_cursor INTEGER NOT NULL CHECK(capture_cursor>=0),
 native_source_cursor INTEGER NOT NULL CHECK(native_source_cursor>=0),native_offset_cursor INTEGER NOT NULL CHECK(native_offset_cursor>=0),
 capture_count INTEGER NOT NULL CHECK(capture_count>=0),native_count INTEGER NOT NULL CHECK(native_count>=0),
 count_complete INTEGER NOT NULL CHECK(count_complete IN(0,1)),has_conflict INTEGER NOT NULL CHECK(has_conflict IN(0,1)),
 PRIMARY KEY(run_id,session_id,account_id,platform,source,record_sequence),FOREIGN KEY(run_id,session_id,account_id,platform,source)
 REFERENCES legacy_declared_sessions(run_id,session_id,account_id,platform,source),CHECK(phase<>'frozen' OR count_complete=1)
) STRICT;
CREATE TABLE legacy_control_receipts(
 run_id TEXT NOT NULL,operation_id TEXT NOT NULL,domain TEXT NOT NULL CHECK(domain IN('begin','source-roles','session-metadata','source-charge','phase-boundary')),
 intent_digest TEXT NOT NULL CHECK(length(intent_digest)=64 AND intent_digest NOT GLOB '*[^0-9a-f]*'),
 batch_digest TEXT NOT NULL CHECK(length(batch_digest)=64 AND batch_digest NOT GLOB '*[^0-9a-f]*'),
 expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),result_revision INTEGER NOT NULL CHECK(result_revision=expected_revision+1),
 watermark INTEGER NOT NULL CHECK(watermark=result_revision),phase TEXT NOT NULL CHECK(phase IN('roles','metadata','charges','metadata-complete')),
 after_source_id INTEGER NOT NULL CHECK(after_source_id>=0),
 selection_json TEXT NOT NULL CHECK(length(CAST(selection_json AS BLOB))<=131072 AND json_valid(selection_json)),
 receipt_json TEXT NOT NULL CHECK(length(CAST(receipt_json AS BLOB))<=131072 AND json_valid(receipt_json)),
 PRIMARY KEY(run_id,operation_id),FOREIGN KEY(run_id) REFERENCES legacy_typed_runs(run_id)
) STRICT;
CREATE INDEX legacy_typed_source_role ON legacy_typed_sources(run_id,role,source_id);
CREATE INDEX legacy_typed_unit_source ON legacy_typed_units(source_id,start_offset);
CREATE INDEX legacy_typed_unit_outcome ON legacy_typed_units(run_id,outcome,source_id,start_offset);
CREATE INDEX legacy_declared_owner ON legacy_declared_sessions(run_id,session_id,account_id,platform,source,seed_ordinal);
CREATE INDEX legacy_typed_capture_sequence ON capture_rows(session_id,account_id,platform,source,record_sequence,physical_position);
CREATE INDEX legacy_native_candidates ON legacy_native_units(run_id,session_id,account_id,platform,source,record_sequence,source_id,start_offset);
CREATE INDEX legacy_native_pairing ON legacy_native_links(run_id,pairing_status,native_source_id,native_offset);
CREATE INDEX legacy_group_phase ON legacy_pair_groups(run_id,phase,session_id,account_id,platform,source,record_sequence);
CREATE TRIGGER legacy_typed_meta_no_update BEFORE UPDATE ON legacy_typed_meta BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TYPED_META'); END;
CREATE TRIGGER legacy_typed_meta_no_delete BEFORE DELETE ON legacy_typed_meta BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TYPED_META'); END;
CREATE TRIGGER legacy_typed_run_binding BEFORE INSERT ON legacy_typed_runs
WHEN NEW.run_id IS NOT (SELECT value FROM legacy_typed_meta WHERE key='run_id')
 OR NEW.policy_digest IS NOT (SELECT value FROM legacy_typed_meta WHERE key='policy_digest')
BEGIN SELECT RAISE(ABORT,'TYPED_RUN_BINDING_MISMATCH'); END;
CREATE TRIGGER legacy_typed_run_identity BEFORE UPDATE ON legacy_typed_runs
WHEN OLD.run_id IS NOT NEW.run_id OR OLD.policy_digest IS NOT NEW.policy_digest
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TYPED_RUN'); END;
CREATE TRIGGER legacy_typed_runs_no_delete BEFORE DELETE ON legacy_typed_runs BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TYPED_RUN'); END;
CREATE TRIGGER legacy_typed_source_binding BEFORE INSERT ON legacy_typed_sources
WHEN NOT EXISTS(SELECT 1 FROM legacy_sources WHERE id=NEW.source_id AND verified=1 AND sha256=NEW.source_sha256 AND size=NEW.source_size)
BEGIN SELECT RAISE(ABORT,'TYPED_SOURCE_BINDING_MISMATCH'); END;
CREATE TRIGGER legacy_typed_source_identity BEFORE UPDATE ON legacy_typed_sources
WHEN OLD.run_id IS NOT NEW.run_id OR OLD.source_id IS NOT NEW.source_id OR OLD.role IS NOT NEW.role
 OR OLD.source_sha256 IS NOT NEW.source_sha256 OR OLD.source_size IS NOT NEW.source_size OR OLD.session_hint IS NOT NEW.session_hint
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TYPED_SOURCE'); END;
CREATE TRIGGER legacy_typed_sources_no_delete BEFORE DELETE ON legacy_typed_sources BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TYPED_SOURCE'); END;
CREATE TRIGGER legacy_typed_units_extent BEFORE INSERT ON legacy_typed_units
WHEN (NEW.unit_kind='line' AND NOT EXISTS(SELECT 1 FROM legacy_lines WHERE source_id=NEW.source_id
 AND line=NEW.line AND start_offset=NEW.start_offset AND next_offset=NEW.next_offset))
 OR (NEW.unit_kind='file' AND NOT EXISTS(SELECT 1 FROM legacy_sources WHERE id=NEW.source_id AND size=NEW.next_offset))
BEGIN SELECT RAISE(ABORT,'TYPED_EXTENT_MISMATCH'); END;
CREATE TRIGGER legacy_typed_unit_owner BEFORE INSERT ON legacy_typed_units
WHEN NEW.outcome='accepted' AND NOT EXISTS(SELECT 1 FROM legacy_typed_sources WHERE run_id=NEW.run_id AND source_id=NEW.source_id
 AND role IN('canonical-session','canonical-records','canonical-native') AND session_hint=NEW.session_id)
BEGIN SELECT RAISE(ABORT,'TYPED_UNIT_OWNER_MISMATCH'); END;
CREATE TRIGGER legacy_typed_units_no_update BEFORE UPDATE ON legacy_typed_units BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TYPED_UNIT'); END;
CREATE TRIGGER legacy_typed_units_no_delete BEFORE DELETE ON legacy_typed_units BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TYPED_UNIT'); END;
CREATE TRIGGER legacy_declared_binding BEFORE INSERT ON legacy_declared_sessions
WHEN NOT EXISTS(SELECT 1 FROM legacy_typed_sources WHERE run_id=NEW.run_id AND source_id=NEW.metadata_source_id
 AND role='canonical-session' AND session_hint=NEW.session_id)
 OR NOT EXISTS(SELECT 1 FROM sessions WHERE id=NEW.session_id AND ordinal=NEW.seed_ordinal)
 OR NOT EXISTS(SELECT 1 FROM legacy_typed_units AS u JOIN legacy_typed_sources AS s ON s.run_id=u.run_id AND s.source_id=u.source_id
 WHERE u.run_id=NEW.run_id AND u.source_id=NEW.metadata_source_id AND u.start_offset=0 AND u.unit_kind='file' AND u.line IS NULL
 AND u.next_offset=s.source_size AND u.literal_sha256=s.source_sha256)
BEGIN SELECT RAISE(ABORT,'TYPED_DECLARATION_BINDING_MISMATCH'); END;
CREATE TRIGGER legacy_declared_no_update BEFORE UPDATE ON legacy_declared_sessions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TYPED_DECLARATION'); END;
CREATE TRIGGER legacy_declared_no_delete BEFORE DELETE ON legacy_declared_sessions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TYPED_DECLARATION'); END;
CREATE TRIGGER legacy_stats_identity BEFORE UPDATE ON legacy_session_stats
WHEN OLD.run_id IS NOT NEW.run_id OR OLD.session_id IS NOT NEW.session_id OR OLD.account_id IS NOT NEW.account_id OR OLD.platform IS NOT NEW.platform OR OLD.source IS NOT NEW.source
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TYPED_STATS_OWNER'); END;
CREATE TRIGGER legacy_stats_no_delete BEFORE DELETE ON legacy_session_stats BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TYPED_STATS'); END;
CREATE TRIGGER legacy_charge_binding BEFORE INSERT ON legacy_source_charges
WHEN NOT EXISTS(SELECT 1 FROM legacy_sources WHERE id=NEW.source_id AND verified=1 AND sha256=NEW.source_sha256 AND size=NEW.source_size)
 OR NOT EXISTS(SELECT 1 FROM legacy_typed_sources WHERE run_id=NEW.run_id AND source_id=NEW.source_id
 AND role=NEW.role AND source_sha256=NEW.source_sha256 AND source_size=NEW.source_size AND session_hint=NEW.session_id)
BEGIN SELECT RAISE(ABORT,'TYPED_CHARGE_BINDING_MISMATCH'); END;
CREATE TRIGGER legacy_charges_no_update BEFORE UPDATE ON legacy_source_charges BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TYPED_CHARGE'); END;
CREATE TRIGGER legacy_charges_no_delete BEFORE DELETE ON legacy_source_charges BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TYPED_CHARGE'); END;
CREATE TRIGGER legacy_capture_links_match BEFORE INSERT ON legacy_capture_links
WHEN NOT EXISTS(SELECT 1 FROM legacy_typed_sources WHERE run_id=NEW.run_id AND source_id=NEW.source_id AND role='canonical-records')
 OR NOT EXISTS(SELECT 1 FROM legacy_typed_units WHERE run_id=NEW.run_id AND source_id=NEW.source_id AND start_offset=NEW.start_offset AND capture_position=NEW.capture_position)
 OR NOT EXISTS(SELECT 1 FROM capture_rows WHERE physical_position=NEW.capture_position
 AND source_id='legacy:'||(SELECT value FROM legacy_typed_meta WHERE key='database_id')||':'||NEW.source_id
 AND source_offset=NEW.start_offset AND next_offset=(SELECT next_offset FROM legacy_typed_units WHERE run_id=NEW.run_id AND source_id=NEW.source_id AND start_offset=NEW.start_offset)
 AND line_number=(SELECT line FROM legacy_typed_units WHERE run_id=NEW.run_id AND source_id=NEW.source_id AND start_offset=NEW.start_offset))
BEGIN SELECT RAISE(ABORT,'TYPED_CAPTURE_LINK_MISMATCH'); END;
CREATE TRIGGER legacy_capture_links_no_update BEFORE UPDATE ON legacy_capture_links BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TYPED_LINK'); END;
CREATE TRIGGER legacy_capture_links_no_delete BEFORE DELETE ON legacy_capture_links BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TYPED_LINK'); END;
CREATE TRIGGER legacy_native_unit_binding BEFORE INSERT ON legacy_native_units
WHEN NOT EXISTS(SELECT 1 FROM legacy_typed_sources WHERE run_id=NEW.run_id AND source_id=NEW.source_id AND role='canonical-native')
 OR (NEW.validation_status='accepted' AND NOT EXISTS(SELECT 1 FROM legacy_typed_units WHERE run_id=NEW.run_id AND source_id=NEW.source_id
 AND start_offset=NEW.start_offset AND outcome='accepted' AND session_id=NEW.session_id AND account_id=NEW.account_id AND platform=NEW.platform AND source=NEW.source))
BEGIN SELECT RAISE(ABORT,'TYPED_NATIVE_BINDING_MISMATCH'); END;
CREATE TRIGGER legacy_native_units_no_update BEFORE UPDATE ON legacy_native_units BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TYPED_NATIVE'); END;
CREATE TRIGGER legacy_native_units_no_delete BEFORE DELETE ON legacy_native_units BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TYPED_NATIVE'); END;
CREATE TRIGGER legacy_native_links_no_update BEFORE UPDATE ON legacy_native_links BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TYPED_PAIR'); END;
CREATE TRIGGER legacy_native_links_no_delete BEFORE DELETE ON legacy_native_links BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TYPED_PAIR'); END;
CREATE TRIGGER legacy_group_identity BEFORE UPDATE ON legacy_pair_groups
WHEN OLD.run_id IS NOT NEW.run_id OR OLD.session_id IS NOT NEW.session_id OR OLD.account_id IS NOT NEW.account_id
 OR OLD.platform IS NOT NEW.platform OR OLD.source IS NOT NEW.source OR OLD.record_sequence IS NOT NEW.record_sequence
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TYPED_GROUP'); END;
CREATE TRIGGER legacy_groups_no_delete BEFORE DELETE ON legacy_pair_groups BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TYPED_GROUP'); END;
CREATE TRIGGER legacy_control_receipts_no_update BEFORE UPDATE ON legacy_control_receipts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TYPED_RECEIPT'); END;
CREATE TRIGGER legacy_control_receipts_no_delete BEFORE DELETE ON legacy_control_receipts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_TYPED_RECEIPT'); END;
CREATE TRIGGER legacy_typed_physical_sources_no_insert BEFORE INSERT ON legacy_sources BEGIN SELECT RAISE(ABORT,'TYPED_MANIFEST_SEALED'); END;
CREATE TRIGGER legacy_typed_physical_sources_verified BEFORE UPDATE OF verified ON legacy_sources
WHEN OLD.verified IS NOT NEW.verified BEGIN SELECT RAISE(ABORT,'TYPED_MANIFEST_SEALED'); END;
CREATE TRIGGER legacy_typed_physical_meta_no_insert BEFORE INSERT ON legacy_import_meta BEGIN SELECT RAISE(ABORT,'TYPED_MANIFEST_SEALED'); END;
CREATE TRIGGER legacy_typed_physical_meta_no_update BEFORE UPDATE ON legacy_import_meta BEGIN SELECT RAISE(ABORT,'TYPED_MANIFEST_SEALED'); END;
CREATE TRIGGER legacy_typed_physical_meta_no_delete BEFORE DELETE ON legacy_import_meta BEGIN SELECT RAISE(ABORT,'TYPED_MANIFEST_SEALED'); END;`
const sha = (value:string) => createHash('sha256').update(value).digest('hex')
const normalize = (sql:string) => sql.replace(/\bIF NOT EXISTS\b/gi,'').replace(/\s+/g,' ').trim().replace(/;$/,'')
export const TYPED_STAGE_FINGERPRINT = sha(TYPED_STAGE_DDL.replace(/\s+/g,' ').trim())
export interface TypedStagePolicy {
 version:1;roleModuleDigest:string;metadataModuleDigest:string;stagedReaderContractDigest:string;
 ordinalPolicy:'source-id-v1';normalizationTimestamp:number;limitsDigest:string;
 metadataBytes:131072;decodedNodes:8192;decodedDepth:16;
 maxRowMutations:128;maxEncodedBytes:1048576;maxByteWork:1048576;
}
export interface TypedStageBinding {
 identity:CaptureDatabaseIdentity;runId:string;manifestDigest:string;limits:Readonly<CaptureLimits>;policy:Readonly<TypedStagePolicy>;
}
export interface TypedStageInspection {
 manifestDigest:string;sourceCount:number;sourceBytes:number;sourceHighWaterId:number;maxPageRows:number;activationAllowed:false;
}
export interface TypedStageAdmission {
 binding:TypedStageBinding;sourceCount:number;sourceBytes:number;sourceHighWaterId:number;bootstrapEncodedBytes:number;byteWork:number;
}
interface AdmissionMeter {used:number;max:number}
function reserve(meter:AdmissionMeter|undefined,bytes:number):void {
 if(!meter)return
 if(!Number.isSafeInteger(bytes)||bytes<0||meter.used+bytes>meter.max)fail('TYPED_ADMISSION_LIMIT')
 meter.used+=bytes
}
export class TypedStageSchemaError extends Error { constructor(readonly code:string) { super(code) } }
function fail(code:string):never { throw new TypedStageSchemaError(code) }
function stable(value:unknown):string {
 if(value===null||typeof value!=='object')return JSON.stringify(value)
 if(Array.isArray(value))return `[${value.map(stable).join(',')}]`
 const x=value as Record<string,unknown>;return `{${Object.keys(x).sort().map(k=>`${JSON.stringify(k)}:${stable(x[k])}`).join(',')}}`
}
function exact(input:unknown,keys:readonly string[]):asserts input is Record<string,unknown> {
 if(!input||typeof input!=='object'||types.isProxy(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))fail('TYPED_INPUT_INVALID')
 const own=Reflect.ownKeys(input)
 if(own.length!==keys.length||own.some(k=>typeof k!=='string'||!keys.includes(k)))fail('TYPED_INPUT_INVALID')
 for(const k of keys){const d=Object.getOwnPropertyDescriptor(input,k);if(!d||!d.enumerable||!('value'in d))fail('TYPED_INPUT_INVALID')}
}
function integer(value:unknown,min=0):number {
 if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min)fail('TYPED_DESCRIPTOR_INVALID');return value
}
function digest(value:unknown):string {
 if(typeof value!=='string'||!/^[0-9a-f]{64}$/.test(value))fail('TYPED_INPUT_INVALID');return value
}
const policyKeys=['version','roleModuleDigest','metadataModuleDigest','stagedReaderContractDigest','ordinalPolicy','normalizationTimestamp','limitsDigest','metadataBytes','decodedNodes','decodedDepth','maxRowMutations','maxEncodedBytes','maxByteWork'] as const
function identity(input:CaptureDatabaseIdentity):CaptureDatabaseIdentity {
 exact(input,['databaseId','generation','schemaVersion'])
 try{return validateCaptureIdentity(input)}catch{fail('TYPED_INPUT_INVALID')}
}
function binding(input:TypedStageBinding):TypedStageBinding {
 exact(input,['identity','runId','manifestDigest','limits','policy']);exact(input.limits,Object.keys(CAPTURE_STORAGE_LIMITS));exact(input.policy,policyKeys)
 let limits:Readonly<CaptureLimits>,runId:string
 try{limits=validateCaptureStorageLimits(input.limits);runId=analysisId(input.runId)}catch{fail('TYPED_INPUT_INVALID')}
 const p=input.policy
 for(const [key,value] of Object.entries({version:1,ordinalPolicy:'source-id-v1',metadataBytes:131072,decodedNodes:8192,decodedDepth:16,maxRowMutations:128,maxEncodedBytes:1048576,maxByteWork:1048576}))
  if(p[key as keyof TypedStagePolicy]!==value)fail('TYPED_INPUT_INVALID')
 integer(p.normalizationTimestamp)
 for(const k of ['roleModuleDigest','metadataModuleDigest','stagedReaderContractDigest','limitsDigest'] as const)digest(p[k])
 if(p.limitsDigest!==sha(stable(limits)))fail('TYPED_BINDING_CONFLICT')
 const result:TypedStageBinding={identity:identity(input.identity),runId,manifestDigest:digest(input.manifestDigest),limits,policy:Object.freeze({...p})}
 try{preflightCaptureValue(result,limits.maxPendingBytes,limits.maxDepth)}catch{fail('TYPED_BOOTSTRAP_LIMIT')}
 return result
}
const baseNames=['capture_rows_scope','original_rows_session','sessions_ordinal','sessions_scope','capture_rows','database_meta','field_entries','legacy_chunks','legacy_import_meta','legacy_lines','legacy_sources','operation_receipts','original_rows','sessions','capture_rows_immutable_delete','capture_rows_immutable_update','legacy_chunks_no_delete','legacy_chunks_no_update','legacy_lines_no_delete','legacy_lines_no_update','legacy_sources_no_delete','legacy_sources_no_identity_update','original_rows_immutable_delete','original_rows_immutable_update','receipts_immutable_delete','receipts_immutable_update']
// Reviewed core1 + physical-stage1 object SQL, ordered by type/name and normalized.
const baseFingerprint='76817cee32be166ef95b0fb3d30f68177e9095bacdc297525d0afe94caba867d'
const definitions=[...(TYPED_STAGE_DDL.match(/CREATE (?:TABLE|(?:UNIQUE )?INDEX) [^;]+;/g)??[]),...(TYPED_STAGE_DDL.match(/CREATE TRIGGER [\s\S]*? END;/g)??[])].map(sql=>{
 const m=normalize(sql).match(/^CREATE (?:UNIQUE )?(TABLE|INDEX|TRIGGER) (\w+)/)!
 return {type:m[1].toLowerCase(),name:m[2],sql:normalize(sql)}
})
function catalog(db:DatabaseSync,extended:boolean|'projection-v1'|'capacity-v2',meter?:AdmissionMeter):void {
 const exactDefinitions=extended==='capacity-v2'?[...definitions,...PROJECTION_OBJECT_DEFINITIONS,...CAPACITY_OBJECT_DEFINITIONS]:extended==='projection-v1'?[...definitions,...PROJECTION_OBJECT_DEFINITIONS]:definitions
 const wanted=extended?[...baseNames,...exactDefinitions.map(x=>x.name)]:baseNames
 const scalar=db.prepare("SELECT type,substr(name,1,129) AS name,length(CAST(name AS BLOB)) AS n,length(CAST(sql AS BLOB)) AS b FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name LIMIT ?").all(wanted.length+1)
 reserve(meter,2*Buffer.byteLength(stable(scalar)))
 if(scalar.length!==wanted.length||scalar.some(x=>Number(x.n)>128||!Number.isSafeInteger(Number(x.b))||Number(x.b)<1||Number(x.b)>32768||!wanted.includes(String(x.name))))fail('TYPED_SCHEMA_INVALID')
 const base:string[]=[];let textWork=0
 for(const row of scalar){
  textWork+=Number(row.b)*2;if(textWork>1048576)fail('TYPED_SCHEMA_INVALID')
  reserve(meter,3*Number(row.b)+2*Buffer.byteLength(`${row.type}|${row.name}|\n`))
  const text=db.prepare('SELECT substr(sql,1,32769) AS sql FROM sqlite_master WHERE type=? AND name=?').get(row.type,row.name)
  if(!text||typeof text.sql!=='string')fail('TYPED_SCHEMA_INVALID')
  const sql=normalize(text.sql)
  if(baseNames.includes(String(row.name)))base.push(`${row.type}|${row.name}|${sql}\n`)
  else if(!exactDefinitions.some(x=>x.type===row.type&&x.name===row.name&&x.sql===sql))fail('TYPED_SCHEMA_INVALID')
 }
 if(sha(base.join(''))!==baseFingerprint)fail('TYPED_SCHEMA_INVALID')
}
function coreIdentity(db:DatabaseSync,i:CaptureDatabaseIdentity,meter?:AdmissionMeter):void {
 for(const [key,value] of [['database_id',i.databaseId],['generation',String(i.generation)],['schema_version','1']]){
  if(meter){const row=db.prepare('SELECT length(CAST(value AS BLOB)) AS n FROM database_meta WHERE key=?').get(key);reserve(meter,2*Buffer.byteLength(stable(row??null)))
   if(row?.n!==Buffer.byteLength(value))fail('TYPED_IDENTITY_CONFLICT');reserve(meter,3*Number(row.n))}
  const actual=meter?db.prepare('SELECT substr(value,1,37) AS value FROM database_meta WHERE key=?').get(key):db.prepare('SELECT value FROM database_meta WHERE key=?').get(key)
  if(actual?.value!==value)fail('TYPED_IDENTITY_CONFLICT')
 }
}
function physicalHeader(db:DatabaseSync,meter?:AdmissionMeter):void {
 for(const [key,value] of [['version','1'],['status','verified'],['inventory_complete','1']]){
  if(meter){const row=db.prepare('SELECT length(CAST(value AS BLOB)) AS n FROM legacy_import_meta WHERE key=?').get(key);reserve(meter,2*Buffer.byteLength(stable(row??null)))
   if(row?.n!==Buffer.byteLength(value))fail('TYPED_STAGE_NOT_VERIFIED');reserve(meter,3*Number(row.n))}
  const actual=meter?db.prepare('SELECT substr(value,1,33) AS value FROM legacy_import_meta WHERE key=?').get(key):db.prepare('SELECT value FROM legacy_import_meta WHERE key=?').get(key)
  if(actual?.value!==value)fail('TYPED_STAGE_NOT_VERIFIED')
 }
}
function emptyCore(db:DatabaseSync):void {
 for(const table of ['sessions','capture_rows','original_rows','operation_receipts','field_entries'])if(db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())fail('TYPED_CORE_NOT_EMPTY')
 for(const key of ['commit_watermark','session_ordinal','total_logical_bytes'])if(db.prepare('SELECT value FROM database_meta WHERE key=?').get(key)?.value!=='0')fail('TYPED_CORE_NOT_EMPTY')
}
function sourceTail(db:DatabaseSync):number {
 if(db.prepare('SELECT id FROM legacy_sources WHERE id<=0 ORDER BY id LIMIT 1').get())fail('TYPED_DESCRIPTOR_INVALID')
 return integer(db.prepare('SELECT id FROM legacy_sources ORDER BY id DESC LIMIT 1').get()?.id??0)
}
/** Explicit bootstrap/resume-only scalar scans, never a bounded import-step guard. */
function finalMembership(db:DatabaseSync,count:number,high:number):void {
 physicalHeader(db)
 if(sourceTail(db)!==high||integer(db.prepare('SELECT COUNT(*) AS n FROM legacy_sources').get()!.n)!==count)fail('TYPED_MANIFEST_CONFLICT')
 if(db.prepare('SELECT id FROM legacy_sources WHERE verified<>1 LIMIT 1').get())fail('TYPED_STAGE_NOT_VERIFIED')
}
async function inspectInventory(db:DatabaseSync):Promise<TypedStageInspection> {
 const high=sourceTail(db),hash=createHash('sha256');let cursor=0,sourceCount=0,sourceBytes=0,maxPageRows=0
 for(;;){
  const scalar=db.prepare('SELECT id,size,verified,length(CAST(relative_path AS BLOB)) AS path_bytes,length(CAST(fingerprint AS BLOB)) AS fp_bytes,length(CAST(sha256 AS BLOB)) AS sha_bytes FROM legacy_sources WHERE id>? AND id<=? ORDER BY id LIMIT 128').all(cursor,high)
  if(!scalar.length)break
  for(const x of scalar){integer(x.id,1);integer(x.size);if(Number(x.size)>5368709120)fail('TYPED_DESCRIPTOR_INVALID')
   if(x.verified!==1)fail('TYPED_STAGE_NOT_VERIFIED')
   if(Number(x.path_bytes)<1||Number(x.path_bytes)>4096||Number(x.fp_bytes)>2048||Number(x.sha_bytes)!==64)fail('TYPED_DESCRIPTOR_LIMIT')}
  const last=Number(scalar[scalar.length-1].id)
  const rows=db.prepare('SELECT id,size,verified,substr(relative_path,1,4097) AS relative_path,substr(fingerprint,1,2049) AS fingerprint,substr(sha256,1,65) AS sha256 FROM legacy_sources WHERE id>? AND id<=? ORDER BY id LIMIT 128').all(cursor,last)
  if(rows.length!==scalar.length||Buffer.byteLength(stable(rows))>1048576)fail('TYPED_DESCRIPTOR_LIMIT')
  maxPageRows=Math.max(maxPageRows,rows.length)
  for(const row of rows){digest(row.sha256);sourceCount=integer(sourceCount+1);sourceBytes=integer(sourceBytes+Number(row.size));cursor=Number(row.id)
   for(const item of [row.id,row.relative_path,row.size,row.sha256,row.fingerprint,row.verified]){const bytes=Buffer.from(String(item));hash.update(String(bytes.length)+':').update(bytes)}}
  await new Promise<void>(done=>setImmediate(done))
 }
 finalMembership(db,sourceCount,high)
 return {manifestDigest:hash.digest('hex'),sourceCount,sourceBytes,sourceHighWaterId:high,maxPageRows,activationAllowed:false}
}
/** Explicit paged bootstrap traversal; not a bounded control/worker request. */
export async function inspectTypedStageInput(db:DatabaseSync,input:CaptureDatabaseIdentity):Promise<TypedStageInspection> {
 const i=identity(input);catalog(db,false);coreIdentity(db,i);physicalHeader(db)
 const seen=await inspectInventory(db);catalog(db,false);coreIdentity(db,i);physicalHeader(db);return seen
}
const headerKeys=['kind','version','capability','schema_complete','activation_allowed','physical_stage_version','database_id','generation','run_id','manifest_digest','policy_digest','policy_json','limits_json','schema_fingerprint','source_count','source_bytes','source_high_water_id','bootstrap_encoded_bytes']
function expectedHeader(b:TypedStageBinding,seen:TypedStageInspection):Record<string,string> {
 const h:Record<string,string>={kind:TYPED_STAGE_KIND,version:'1',capability:TYPED_STAGE_CAPABILITY,schema_complete:'0',activation_allowed:'0',physical_stage_version:'1',
 database_id:b.identity.databaseId,generation:String(b.identity.generation),run_id:b.runId,manifest_digest:b.manifestDigest,policy_digest:sha(stable(b.policy)),policy_json:stable(b.policy),limits_json:stable(b.limits),
 schema_fingerprint:TYPED_STAGE_FINGERPRINT,source_count:String(seen.sourceCount),source_bytes:String(seen.sourceBytes),source_high_water_id:String(seen.sourceHighWaterId),bootstrap_encoded_bytes:'0'}
 for(let n=0;n<8;n++){const bytes=String(Buffer.byteLength(stable(h)));if(h.bootstrap_encoded_bytes===bytes)return h;h.bootstrap_encoded_bytes=bytes}
 fail('TYPED_BOOTSTRAP_LIMIT')
}
function header(db:DatabaseSync,meter?:AdmissionMeter):Record<string,string> {
 const scalar=db.prepare('SELECT substr(key,1,129) AS key,length(CAST(key AS BLOB)) AS k,length(CAST(value AS BLOB)) AS v FROM legacy_typed_meta ORDER BY key LIMIT 19').all()
 reserve(meter,2*Buffer.byteLength(stable(scalar)))
 if(scalar.length!==18||scalar.some(x=>Number(x.k)>128||Number(x.v)>16384||!headerKeys.includes(String(x.key))))fail('TYPED_HEADER_INVALID')
 const h:Record<string,string>={}
 for(const x of scalar){reserve(meter,3*Number(x.v));const value=db.prepare('SELECT substr(value,1,16385) AS value FROM legacy_typed_meta WHERE key=?').get(x.key)?.value
  if(typeof value!=='string')fail('TYPED_HEADER_INVALID');h[String(x.key)]=value}
 for(const k of ['source_count','source_bytes','source_high_water_id','bootstrap_encoded_bytes'])if(!/^(0|[1-9]\d*)$/.test(h[k])||!Number.isSafeInteger(Number(h[k])))fail('TYPED_HEADER_INVALID')
 if(Buffer.byteLength(stable(h))>16384)fail('TYPED_HEADER_INVALID');return h
}
function checkedHeader(db:DatabaseSync,b:TypedStageBinding,meter?:AdmissionMeter,mode:'base'|'projection-v1'|'capacity-v2'='base'):Record<string,string> {
 catalog(db,mode==='base'?true:mode,meter);coreIdentity(db,b.identity,meter);physicalHeader(db,meter);const h=header(db,meter)
 const wanted=expectedHeader(b,{manifestDigest:b.manifestDigest,sourceCount:Number(h.source_count),sourceBytes:Number(h.source_bytes),sourceHighWaterId:Number(h.source_high_water_id),maxPageRows:0,activationAllowed:false})
 if(stable(h)!==stable(wanted))fail('TYPED_BINDING_CONFLICT');return h
}
/** Fixed catalog/header/input checks only. No source walk, membership COUNT or mutation. */
export function readTypedStageAdmission(db:DatabaseSync,input:TypedStageBinding,maxByteWork:number):TypedStageAdmission {
 if(typeof maxByteWork!=='number'||!Number.isSafeInteger(maxByteWork)||maxByteWork<1||maxByteWork>1048576)fail('TYPED_INPUT_INVALID')
 const b=binding(input),meter:AdmissionMeter={used:0,max:maxByteWork};reserve(meter,2*Buffer.byteLength(stable(b)))
 const h=checkedHeader(db,b,meter)
 const seen:TypedStageInspection={manifestDigest:b.manifestDigest,sourceCount:Number(h.source_count),sourceBytes:Number(h.source_bytes),sourceHighWaterId:Number(h.source_high_water_id),maxPageRows:0,activationAllowed:false}
 admission(b,seen,h)
 return {binding:b,sourceCount:seen.sourceCount,sourceBytes:seen.sourceBytes,sourceHighWaterId:seen.sourceHighWaterId,bootstrapEncodedBytes:Number(h.bootstrap_encoded_bytes),byteWork:meter.used}
}
const projectionRunColumns=['run_id','policy_digest','revision','watermark','receipt_count','encoded_bytes','phase','after_source_id','next_ordinal','classified_sources','accepted_metadata','seeded_sessions','charged_sources','rejected','deferred','retained','unresolved','canonical_evidence_bytes']
/** Bounded point snapshot; full authentication still belongs to the existing DB receipt decoder. */
export function readProjectionBaseRunSnapshot(db:DatabaseSync,runId:string):Record<string,string|number>{
 const r=db.prepare(`SELECT ${projectionRunColumns.map(k=>['run_id','policy_digest','phase'].includes(k)?`substr(${k},1,65) AS ${k}`:k).join(',')} FROM legacy_typed_runs WHERE run_id=?`).get(runId)
 if(!r||r.run_id!==runId||r.phase!=='metadata-complete'||r.revision!==r.watermark||r.revision!==r.receipt_count)projectionFailure('PROJECTION_PREFIX_INVALID')
 for(const k of projectionRunColumns)if(!['run_id','policy_digest','phase'].includes(k)&&(typeof r[k]!=='number'||!Number.isSafeInteger(r[k])||Number(r[k])<0))projectionFailure('PROJECTION_PREFIX_INVALID')
 return r as Record<string,string|number>
}
function projectionExpected(b:ProjectionBinding,a:TypedStageAdmission,run:Record<string,string|number>,prefixDigest:string):Record<string,string>{
 const h:Record<string,string>={kind:PROJECTION_STAGE_KIND,version:'1',capability:PROJECTION_STAGE_CAPABILITY,schema_complete:'0',activation_allowed:'0',database_id:b.base.identity.databaseId,generation:String(b.base.identity.generation),base_run_id:b.base.runId,base_manifest_digest:b.base.manifestDigest,base_prefix_operation_id:b.basePrefixOperationId,base_prefix_revision:String(run.revision),base_prefix_receipt_digest:prefixDigest,base_prefix_run_digest:projectionDigest(run),base_source_count:String(a.sourceCount),base_source_bytes:String(a.sourceBytes),base_encoded_bytes:String(run.encoded_bytes),base_bootstrap_encoded_bytes:String(a.bootstrapEncodedBytes),companion_fingerprint:PROJECTION_STAGE_FINGERPRINT,limits_json:projectionStable(b.base.limits),policy_json:projectionStable(b.policy),policy_digest:projectionDigest(b.policy),bootstrap_encoded_bytes:'0'}
 for(let n=0;n<8;n++){const bytes=String(Buffer.byteLength(projectionStable(h)));if(h.bootstrap_encoded_bytes===bytes)return h;h.bootstrap_encoded_bytes=bytes}projectionFailure('PROJECTION_ADMISSION_LIMIT')
}
/** Internal creation helper: inputs have just passed base admission and DB receipt authentication. */
export function projectionHeaderForAuthenticatedPrefix(b:ProjectionBinding,a:TypedStageAdmission,run:Record<string,string|number>,prefixDigest:string):Record<string,string>{return projectionExpected(b,a,run,prefixDigest)}
/** Exact known147 union, metered structural prefix only; this result is deliberately not an authenticated ACK. */
function projectionStructuralAdmission(db:DatabaseSync,input:ProjectionBinding,maxByteWork:number,mode:'projection-v1'|'capacity-v2'):ProjectionAdmission{
 if(typeof maxByteWork!=='number'||!Number.isSafeInteger(maxByteWork)||maxByteWork<1||maxByteWork>1048576)projectionFailure('PROJECTION_INPUT_INVALID')
 projectionExact(input,['base','basePrefixOperationId','policy']);const normalized=binding(input.base),b=normalizeProjectionBinding(input,normalized),meter:AdmissionMeter={used:0,max:maxByteWork};reserve(meter,2*Buffer.byteLength(stable(b)))
 const h=checkedHeader(db,normalized,meter,mode),seen:TypedStageInspection={manifestDigest:normalized.manifestDigest,sourceCount:Number(h.source_count),sourceBytes:Number(h.source_bytes),sourceHighWaterId:Number(h.source_high_water_id),maxPageRows:0,activationAllowed:false};admission(normalized,seen,h)
 const a:TypedStageAdmission={binding:normalized,sourceCount:seen.sourceCount,sourceBytes:seen.sourceBytes,sourceHighWaterId:seen.sourceHighWaterId,bootstrapEncodedBytes:Number(h.bootstrap_encoded_bytes),byteWork:meter.used}
 const sizes=db.prepare('SELECT substr(key,1,129) AS key,length(CAST(key AS BLOB)) AS k,length(CAST(value AS BLOB)) AS n FROM legacy_projection_meta ORDER BY key LIMIT 23').all();reserve(meter,2*Buffer.byteLength(stable(sizes)))
 if(sizes.length!==22||sizes.some(x=>typeof x.key!=='string'||!PROJECTION_HEADER_KEYS.includes(x.key as typeof PROJECTION_HEADER_KEYS[number])||Number(x.k)>128||!Number.isSafeInteger(Number(x.n))||Number(x.n)>16384))projectionFailure('PROJECTION_HEADER_INVALID')
 const actual:Record<string,string>={};for(const x of sizes){reserve(meter,3*Number(x.n));const v=db.prepare('SELECT substr(value,1,16385) AS value FROM legacy_projection_meta WHERE key=?').get(x.key)?.value;if(typeof v!=='string')projectionFailure('PROJECTION_HEADER_INVALID');actual[String(x.key)]=v}
 reserve(meter,8192);const run=readProjectionBaseRunSnapshot(db,normalized.runId)
 const len=db.prepare('SELECT length(CAST(receipt_json AS BLOB)) AS n FROM legacy_control_receipts WHERE run_id=? AND operation_id=?').get(normalized.runId,b.basePrefixOperationId);reserve(meter,2*Buffer.byteLength(stable(len??null)))
 if(!len||typeof len.n!=='number'||!Number.isSafeInteger(len.n)||len.n<1||len.n>Math.min(131072,normalized.limits.maxRecordBytes,normalized.limits.maxMetadataBytes))projectionFailure('PROJECTION_PREFIX_INVALID');reserve(meter,6*len.n)
 let receipt:Record<string,unknown>;try{const text=db.prepare('SELECT substr(receipt_json,1,131073) AS value FROM legacy_control_receipts WHERE run_id=? AND operation_id=?').get(normalized.runId,b.basePrefixOperationId)?.value;if(typeof text!=='string')projectionFailure('PROJECTION_PREFIX_INVALID');receipt=JSON.parse(text);preflightCaptureValue(receipt,131072,normalized.limits.maxDepth)}catch{projectionFailure('PROJECTION_PREFIX_INVALID')}
 if(receipt.runId!==normalized.runId||receipt.operationId!==b.basePrefixOperationId||receipt.resultRevision!==run.revision||!receipt.cursor||typeof receipt.cursor!=='object'||(receipt.cursor as Record<string,unknown>).phase!=='metadata-complete')projectionFailure('PROJECTION_PREFIX_INVALID')
 if(stable(actual)!==stable(projectionExpected(b,a,run,projectionDigest(receipt))))projectionFailure('PROJECTION_BINDING_CONFLICT')
 if(Number(actual.bootstrap_encoded_bytes)>Math.min(16384,normalized.limits.maxRecordBytes,normalized.limits.maxMetadataBytes,normalized.limits.maxPendingBytes)||seen.sourceBytes+a.bootstrapEncodedBytes+Number(run.encoded_bytes)+Number(actual.bootstrap_encoded_bytes)>normalized.limits.maxStorageBytes)projectionFailure('PROJECTION_ADMISSION_LIMIT')
 return {base:a,binding:b,header:Object.freeze(actual),byteWork:meter.used,activationAllowed:false,prefixAuthenticated:false}
}
function admission(b:TypedStageBinding,seen:TypedStageInspection,h:Record<string,string>):void {
 const charge=Buffer.byteLength(stable(h))
 if(charge>Math.min(16384,b.limits.maxMetadataBytes,b.limits.maxRecordBytes,b.limits.maxPendingBytes)||seen.sourceBytes+charge>b.limits.maxStorageBytes)fail('TYPED_BOOTSTRAP_LIMIT')
}
function full(db:DatabaseSync):void {db.exec('PRAGMA foreign_keys=ON');db.exec('PRAGMA journal_mode=WAL');db.exec('PRAGMA synchronous=FULL')}
export async function createTypedStageSchema(db:DatabaseSync,input:TypedStageBinding):Promise<void> {
 const b=binding(input);catalog(db,false);coreIdentity(db,b.identity);physicalHeader(db);emptyCore(db)
 const seen=await inspectInventory(db)
 if(seen.manifestDigest!==b.manifestDigest)fail('TYPED_MANIFEST_CONFLICT')
 const h=expectedHeader(b,seen);admission(b,seen,h);full(db)
 db.exec('BEGIN IMMEDIATE')
 try{
  catalog(db,false);coreIdentity(db,b.identity);physicalHeader(db);emptyCore(db)
  finalMembership(db,seen.sourceCount,seen.sourceHighWaterId)
  db.exec(TYPED_STAGE_DDL);const put=db.prepare('INSERT INTO legacy_typed_meta(key,value) VALUES(?,?)')
  for(const [key,value] of Object.entries(h))put.run(key,value)
  db.exec('COMMIT')
 }catch(error){try{db.exec('ROLLBACK')}catch{};if(error instanceof TypedStageSchemaError)throw error;fail('TYPED_SCHEMA_CREATE_FAILED')}
}
export async function resumeTypedStageSchema(db:DatabaseSync,input:TypedStageBinding):Promise<void> {
 const b=binding(input),h=checkedHeader(db,b),seen=await inspectInventory(db)
 if(seen.manifestDigest!==b.manifestDigest||h.source_count!==String(seen.sourceCount)||h.source_bytes!==String(seen.sourceBytes)||h.source_high_water_id!==String(seen.sourceHighWaterId))fail('TYPED_MANIFEST_CONFLICT')
 if(stable(h)!==stable(expectedHeader(b,seen)))fail('TYPED_HEADER_INVALID')
 admission(b,seen,h);checkedHeader(db,b);finalMembership(db,seen.sourceCount,seen.sourceHighWaterId);full(db)
}

/** Old public default remains exact147. No caller-selectable catalog. */
export function readTypedStageProjectionAdmission(db:DatabaseSync,input:ProjectionBinding,maxByteWork:number):ProjectionAdmission{return projectionStructuralAdmission(db,input,maxByteWork,'projection-v1')}
/** Fixed capacity successor structural branch; still not ACK authentication. */
export function readTypedStageCapacityAdmission(db:DatabaseSync,input:ProjectionBinding,maxByteWork:number):ProjectionAdmission{return projectionStructuralAdmission(db,input,maxByteWork,'capacity-v2')}
