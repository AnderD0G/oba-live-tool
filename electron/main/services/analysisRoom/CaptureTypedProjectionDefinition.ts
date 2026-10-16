import {createHash} from 'node:crypto'
import {types} from 'node:util'
import {analysisId} from '../../../../shared/analysisRoom'
import type {TypedStageBinding,TypedStageAdmission} from './CaptureTypedStageSchema'
export const PROJECTION_STAGE_KIND='legacy-projection'
export const PROJECTION_STAGE_VERSION=1
export const PROJECTION_STAGE_CAPABILITY='facts-native-fields-v1'
// Unconsumed private companion definition. No projection writer or authority.
export const PROJECTION_STAGE_DDL=`-- TASK57 PRIVATE COMPANION DDL. UNCONSUMED BY LIVE/STORE AUTHORITY.
-- Requires exact frozen Task45 base84, completed metadata prefix and empty reserved targets.
CREATE TABLE legacy_projection_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
CREATE TABLE legacy_projection_run(
 base_run_id TEXT PRIMARY KEY,policy_digest TEXT NOT NULL CHECK(length(policy_digest)=64 AND policy_digest NOT GLOB '*[^0-9a-f]*'),
 revision INTEGER NOT NULL CHECK(revision>=1 AND revision<=9007199254740991),
 watermark INTEGER NOT NULL CHECK(watermark=revision),receipt_count INTEGER NOT NULL CHECK(receipt_count=revision),
 encoded_bytes INTEGER NOT NULL CHECK(encoded_bytes>=0 AND encoded_bytes<=9007199254740991),
 phase TEXT NOT NULL CHECK(phase IN('sources','records','natives','freeze-groups','pair','fields','reconcile','order','verified-partial')),
 source_phase TEXT NOT NULL CHECK(source_phase IN('owners','members','sealed')),
 after_seed_ordinal INTEGER NOT NULL CHECK(after_seed_ordinal>=0),after_source_id INTEGER NOT NULL CHECK(after_source_id>=0),
 current_source_id INTEGER CHECK(current_source_id IS NULL OR current_source_id>=1),
 next_capture_position INTEGER NOT NULL CHECK(next_capture_position>=1 AND next_capture_position<=9007199254740991),
 capture_upper_position INTEGER NOT NULL CHECK(capture_upper_position>=0 AND capture_upper_position<next_capture_position),
 group_session_id TEXT,group_account_id TEXT,group_platform TEXT,group_source TEXT,group_record_sequence INTEGER,
 native_source_cursor INTEGER NOT NULL CHECK(native_source_cursor>=0),native_offset_cursor INTEGER NOT NULL CHECK(native_offset_cursor>=0),
 order_bucket INTEGER NOT NULL CHECK(order_bucket IN(0,1)),order_value INTEGER NOT NULL CHECK(order_value>=0),
 order_metadata_source_id INTEGER NOT NULL CHECK(order_metadata_source_id>=0),order_session_id TEXT,
 next_effective_order INTEGER NOT NULL CHECK(next_effective_order>=1 AND next_effective_order<=9007199254740991),
 owner_count INTEGER NOT NULL CHECK(owner_count>=0),source_count INTEGER NOT NULL CHECK(source_count>=0),
 accepted_records INTEGER NOT NULL CHECK(accepted_records>=0),rejected_records INTEGER NOT NULL CHECK(rejected_records>=0),
 unresolved_records INTEGER NOT NULL CHECK(unresolved_records>=0),deferred_records INTEGER NOT NULL CHECK(deferred_records>=0),
 validated_natives INTEGER NOT NULL CHECK(validated_natives>=0),order_accepted_natives INTEGER NOT NULL CHECK(order_accepted_natives>=0),
 order_invalid_natives INTEGER NOT NULL CHECK(order_invalid_natives>=0),rejected_natives INTEGER NOT NULL CHECK(rejected_natives>=0),
 unresolved_natives INTEGER NOT NULL CHECK(unresolved_natives>=0),deferred_natives INTEGER NOT NULL CHECK(deferred_natives>=0),
 frozen_groups INTEGER NOT NULL CHECK(frozen_groups>=0),paired INTEGER NOT NULL CHECK(paired>=0),
 orphan INTEGER NOT NULL CHECK(orphan>=0),ambiguous INTEGER NOT NULL CHECK(ambiguous>=0),unresolved_pairs INTEGER NOT NULL CHECK(unresolved_pairs>=0),
 field_nodes INTEGER NOT NULL CHECK(field_nodes>=0),reconciled_sessions INTEGER NOT NULL CHECK(reconciled_sessions>=0),
 ordered_sessions INTEGER NOT NULL CHECK(ordered_sessions>=0),projected_blob_bytes INTEGER NOT NULL CHECK(projected_blob_bytes>=0),
 FOREIGN KEY(base_run_id) REFERENCES legacy_typed_runs(run_id),
 FOREIGN KEY(base_run_id,current_source_id) REFERENCES legacy_projection_sources(base_run_id,source_id),
 CHECK((group_session_id IS NULL AND group_account_id IS NULL AND group_platform IS NULL AND group_source IS NULL AND group_record_sequence IS NULL)
 OR (group_session_id IS NOT NULL AND group_account_id IS NOT NULL AND group_platform IS NOT NULL AND group_source IS NOT NULL AND group_record_sequence>=1 AND group_record_sequence IS NOT NULL)),
 CHECK(order_accepted_natives+order_invalid_natives=validated_natives),CHECK(order_session_id IS NULL OR length(order_session_id)=36)
) STRICT;
CREATE TABLE legacy_projection_sources(
 base_run_id TEXT NOT NULL,source_id INTEGER NOT NULL CHECK(source_id>=1),
 role TEXT NOT NULL CHECK(role IN('canonical-records','canonical-native')),
 source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),source_size INTEGER NOT NULL CHECK(source_size>=0),
 session_id TEXT,account_id TEXT,platform TEXT,source TEXT,seed_ordinal INTEGER,shard_number INTEGER,
 status TEXT NOT NULL CHECK(status IN('pending','reading','accepted','deferred','unresolved')),
 last_line INTEGER NOT NULL CHECK(last_line>=0),next_offset INTEGER NOT NULL CHECK(next_offset>=0 AND next_offset<=source_size),
 accepted_units INTEGER NOT NULL CHECK(accepted_units>=0),rejected_units INTEGER NOT NULL CHECK(rejected_units>=0),
 deferred_units INTEGER NOT NULL CHECK(deferred_units>=0),unresolved_units INTEGER NOT NULL CHECK(unresolved_units>=0),
 unknown_header INTEGER NOT NULL CHECK(unknown_header IN(0,1)),revision INTEGER NOT NULL CHECK(revision>=0),
 PRIMARY KEY(base_run_id,source_id),UNIQUE(base_run_id,source_id,role),
 FOREIGN KEY(base_run_id,source_id,role) REFERENCES legacy_typed_sources(run_id,source_id,role),
 FOREIGN KEY(base_run_id,session_id,account_id,platform,source) REFERENCES legacy_declared_sessions(run_id,session_id,account_id,platform,source),
 CHECK((session_id IS NULL AND account_id IS NULL AND platform IS NULL AND source IS NULL AND seed_ordinal IS NULL)
 OR (session_id IS NOT NULL AND account_id IS NOT NULL AND platform IS NOT NULL AND source IS NOT NULL AND seed_ordinal>=1 AND seed_ordinal IS NOT NULL)),
 CHECK((role='canonical-records' AND shard_number>=0 AND shard_number<=999999 AND shard_number IS NOT NULL)
 OR (role='canonical-native' AND shard_number IS NULL)),CHECK(status<>'accepted' OR next_offset=source_size),
 CHECK(session_id IS NOT NULL OR (status='unresolved' AND next_offset=0 AND last_line=0))
) STRICT;
CREATE TABLE legacy_projection_native_order(
 base_run_id TEXT NOT NULL,session_id TEXT NOT NULL,account_id TEXT NOT NULL,platform TEXT NOT NULL,source TEXT NOT NULL,
 seed_ordinal INTEGER NOT NULL CHECK(seed_ordinal>=1),record_sources INTEGER NOT NULL CHECK(record_sources>=0),
 record_terminal_sources INTEGER NOT NULL CHECK(record_terminal_sources>=0 AND record_terminal_sources<=record_sources),
 native_sources INTEGER NOT NULL CHECK(native_sources>=0),native_terminal_sources INTEGER NOT NULL CHECK(native_terminal_sources>=0 AND native_terminal_sources<=native_sources),
 max_capture_record_sequence INTEGER NOT NULL CHECK(max_capture_record_sequence>=0),
 last_original_sequence INTEGER NOT NULL CHECK(last_original_sequence>=0),last_record_sequence INTEGER NOT NULL CHECK(last_record_sequence>=0),
 max_witnessed_original_sequence INTEGER NOT NULL CHECK(max_witnessed_original_sequence>=last_original_sequence),
 max_witnessed_native_record_sequence INTEGER NOT NULL CHECK(max_witnessed_native_record_sequence>=last_record_sequence),
 validated_count INTEGER NOT NULL CHECK(validated_count>=0),order_accepted_count INTEGER NOT NULL CHECK(order_accepted_count>=0),
 order_invalid_count INTEGER NOT NULL CHECK(order_invalid_count>=0),native_redacted_count INTEGER NOT NULL CHECK(native_redacted_count>=0),
 record_unknown_header INTEGER NOT NULL CHECK(record_unknown_header IN(0,1)),native_unknown_header INTEGER NOT NULL CHECK(native_unknown_header IN(0,1)),
 native_present INTEGER NOT NULL CHECK(native_present IN(0,1)),incomplete_native INTEGER NOT NULL CHECK(incomplete_native IN(0,1)),
 revision INTEGER NOT NULL CHECK(revision>=0),PRIMARY KEY(base_run_id,session_id,account_id,platform,source),
 FOREIGN KEY(base_run_id,session_id,account_id,platform,source) REFERENCES legacy_declared_sessions(run_id,session_id,account_id,platform,source),
 CHECK(order_accepted_count+order_invalid_count=validated_count)
) STRICT;
-- Exact parent key for line identity: build only while legacy_capture_links is empty.
CREATE UNIQUE INDEX legacy_projection_capture_link_owner ON legacy_capture_links(capture_position,run_id,source_id,start_offset,session_id,account_id,platform,source);
CREATE TABLE legacy_projection_line_identity(
 capture_position INTEGER PRIMARY KEY,base_run_id TEXT NOT NULL,source_id INTEGER NOT NULL,start_offset INTEGER NOT NULL,
 next_offset INTEGER NOT NULL CHECK(next_offset>start_offset AND next_offset-start_offset<=131074),line INTEGER NOT NULL CHECK(line>=1),
 session_id TEXT NOT NULL,account_id TEXT NOT NULL,platform TEXT NOT NULL,source TEXT NOT NULL,
 literal_sha256 TEXT NOT NULL CHECK(length(literal_sha256)=64 AND literal_sha256 NOT GLOB '*[^0-9a-f]*'),
 projection_sha256 TEXT NOT NULL CHECK(length(projection_sha256)=64 AND projection_sha256 NOT GLOB '*[^0-9a-f]*'),
 projection_bytes INTEGER NOT NULL CHECK(projection_bytes>=1 AND projection_bytes<=131072),
 UNIQUE(base_run_id,source_id,start_offset),
 FOREIGN KEY(capture_position,session_id,account_id,platform,source) REFERENCES capture_rows(physical_position,session_id,account_id,platform,source),
 FOREIGN KEY(capture_position,base_run_id,source_id,start_offset,session_id,account_id,platform,source)
 REFERENCES legacy_capture_links(capture_position,run_id,source_id,start_offset,session_id,account_id,platform,source),
 FOREIGN KEY(source_id,line) REFERENCES legacy_lines(source_id,line)
) STRICT;
CREATE TABLE legacy_projection_field_state(
 base_run_id TEXT NOT NULL,session_id TEXT NOT NULL,account_id TEXT NOT NULL,platform TEXT NOT NULL,source TEXT NOT NULL,
 seed_ordinal INTEGER NOT NULL CHECK(seed_ordinal>=1),phase TEXT NOT NULL CHECK(phase IN('pending','reading','done')),
 upper_capture_position INTEGER NOT NULL CHECK(upper_capture_position>=0),after_capture_position INTEGER NOT NULL CHECK(after_capture_position>=0 AND after_capture_position<=upper_capture_position),
 current_capture_position INTEGER,node_ordinal INTEGER NOT NULL CHECK(node_ordinal>=0 AND node_ordinal<=8192),
 path_count INTEGER NOT NULL CHECK(path_count>=0 AND path_count<=1000),bad_record_lines INTEGER NOT NULL CHECK(bad_record_lines>=0),
 has_deferred INTEGER NOT NULL CHECK(has_deferred IN(0,1)),has_unresolved INTEGER NOT NULL CHECK(has_unresolved IN(0,1)),
 sanitized_incomplete INTEGER NOT NULL CHECK(sanitized_incomplete IN(0,1)),path_cap INTEGER NOT NULL CHECK(path_cap IN(0,1)),
 path_omitted INTEGER NOT NULL CHECK(path_omitted IN(0,1)),resource_omitted INTEGER NOT NULL CHECK(resource_omitted IN(0,1)),
 complete INTEGER NOT NULL CHECK(complete IN(0,1)),revision INTEGER NOT NULL CHECK(revision>=0),
 PRIMARY KEY(base_run_id,session_id,account_id,platform,source),
 FOREIGN KEY(base_run_id,session_id,account_id,platform,source) REFERENCES legacy_declared_sessions(run_id,session_id,account_id,platform,source),
 FOREIGN KEY(current_capture_position,session_id,account_id,platform,source) REFERENCES capture_rows(physical_position,session_id,account_id,platform,source),
 CHECK(current_capture_position IS NULL OR (current_capture_position>after_capture_position AND current_capture_position<=upper_capture_position)),
 CHECK(current_capture_position IS NOT NULL OR node_ordinal=0),
 CHECK(complete=0 OR (phase='done' AND current_capture_position IS NULL AND bad_record_lines=0 AND has_deferred=0 AND has_unresolved=0
 AND sanitized_incomplete=0 AND path_cap=0 AND path_omitted=0 AND resource_omitted=0))
) STRICT;
CREATE TABLE legacy_projection_field_links(
 base_run_id TEXT NOT NULL,session_id TEXT NOT NULL,account_id TEXT NOT NULL,platform TEXT NOT NULL,source TEXT NOT NULL,
 path TEXT NOT NULL CHECK(length(CAST(path AS BLOB))<=4096),
 PRIMARY KEY(base_run_id,session_id,account_id,platform,source,path),
 FOREIGN KEY(base_run_id,session_id,account_id,platform,source) REFERENCES legacy_declared_sessions(run_id,session_id,account_id,platform,source),
 FOREIGN KEY(session_id,path) REFERENCES field_entries(session_id,path)
) STRICT;
CREATE TABLE legacy_projection_pair_decisions(
 base_run_id TEXT NOT NULL,native_source_id INTEGER NOT NULL,native_offset INTEGER NOT NULL,
 session_id TEXT,account_id TEXT,platform TEXT,source TEXT,record_sequence INTEGER,
 status TEXT NOT NULL CHECK(status IN('paired','orphan','ambiguous','unresolved')),code TEXT NOT NULL CHECK(length(CAST(code AS BLOB))<=128),
 capture_count INTEGER,native_count INTEGER,probe_capture_position INTEGER,capture_position INTEGER,
 native_literal_sha256 TEXT,capture_literal_sha256 TEXT,
 policy_digest TEXT NOT NULL CHECK(length(policy_digest)=64 AND policy_digest NOT GLOB '*[^0-9a-f]*'),
 proof_digest TEXT NOT NULL CHECK(length(proof_digest)=64 AND proof_digest NOT GLOB '*[^0-9a-f]*'),
 PRIMARY KEY(base_run_id,native_source_id,native_offset),
 FOREIGN KEY(base_run_id,native_source_id,native_offset) REFERENCES legacy_native_units(run_id,source_id,start_offset),
 FOREIGN KEY(base_run_id,native_source_id,native_offset,session_id,account_id,platform,source)
 REFERENCES legacy_native_units(run_id,source_id,start_offset,session_id,account_id,platform,source),
 FOREIGN KEY(base_run_id,session_id,account_id,platform,source,record_sequence)
 REFERENCES legacy_pair_groups(run_id,session_id,account_id,platform,source,record_sequence),
 FOREIGN KEY(capture_position,session_id,account_id,platform,source) REFERENCES capture_rows(physical_position,session_id,account_id,platform,source),
 FOREIGN KEY(probe_capture_position,session_id,account_id,platform,source) REFERENCES capture_rows(physical_position,session_id,account_id,platform,source),
 CHECK((session_id IS NULL AND account_id IS NULL AND platform IS NULL AND source IS NULL AND record_sequence IS NULL AND capture_count IS NULL AND native_count IS NULL)
 OR (session_id IS NOT NULL AND account_id IS NOT NULL AND platform IS NOT NULL AND source IS NOT NULL AND record_sequence>=1 AND record_sequence IS NOT NULL
 AND capture_count>=0 AND capture_count IS NOT NULL AND native_count>=1 AND native_count IS NOT NULL)),
 CHECK((native_literal_sha256 IS NULL) OR (length(native_literal_sha256)=64 AND native_literal_sha256 NOT GLOB '*[^0-9a-f]*')),
 CHECK((capture_literal_sha256 IS NULL AND probe_capture_position IS NULL) OR (capture_literal_sha256 IS NOT NULL AND probe_capture_position IS NOT NULL
 AND length(capture_literal_sha256)=64 AND capture_literal_sha256 NOT GLOB '*[^0-9a-f]*')),
 CHECK(probe_capture_position IS NULL OR session_id IS NOT NULL),
 CHECK((status='paired' AND capture_position IS NOT NULL AND capture_position=probe_capture_position AND native_literal_sha256 IS NOT NULL
 AND capture_literal_sha256 IS NOT NULL AND capture_count=1 AND native_count=1 AND session_id IS NOT NULL) OR (status<>'paired' AND capture_position IS NULL))
) STRICT;
CREATE TABLE legacy_projection_reconciliations(
 base_run_id TEXT NOT NULL,session_id TEXT NOT NULL,account_id TEXT NOT NULL,platform TEXT NOT NULL,source TEXT NOT NULL,
 metadata_source_id INTEGER NOT NULL,declared_snapshot_sha256 TEXT NOT NULL CHECK(length(declared_snapshot_sha256)=64 AND declared_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
 provenance TEXT NOT NULL CHECK(provenance='derived-recovery'),policy_digest TEXT NOT NULL CHECK(length(policy_digest)=64 AND policy_digest NOT GLOB '*[^0-9a-f]*'),
 witnessed_saved INTEGER NOT NULL CHECK(witnessed_saved>=0),witnessed_max_record_sequence INTEGER NOT NULL CHECK(witnessed_max_record_sequence>=0),
 witnessed_parse_failed INTEGER NOT NULL CHECK(witnessed_parse_failed>=0),witnessed_redacted INTEGER NOT NULL CHECK(witnessed_redacted>=0),
 witnessed_order_accepted_natives INTEGER NOT NULL CHECK(witnessed_order_accepted_natives>=0),witnessed_last_original_sequence INTEGER NOT NULL CHECK(witnessed_last_original_sequence>=0),
 charged_record_bytes INTEGER NOT NULL CHECK(charged_record_bytes>=0),charged_native_bytes INTEGER NOT NULL CHECK(charged_native_bytes>=0),
 original_presence INTEGER NOT NULL CHECK(original_presence IN(0,1)),
 derived_received INTEGER NOT NULL CHECK(derived_received>=0),derived_saved INTEGER NOT NULL CHECK(derived_saved>=0),
 derived_dropped INTEGER NOT NULL CHECK(derived_dropped>=0),derived_pending INTEGER NOT NULL CHECK(derived_pending=0),
 derived_parse_failed INTEGER NOT NULL CHECK(derived_parse_failed>=0),derived_redacted INTEGER NOT NULL CHECK(derived_redacted>=0),
 derived_bytes INTEGER NOT NULL CHECK(derived_bytes=charged_record_bytes+charged_native_bytes),
 derived_original_received INTEGER,derived_original_saved INTEGER,derived_original_dropped INTEGER,derived_original_pending INTEGER,derived_original_bytes INTEGER,derived_original_redacted INTEGER,
 derived_status TEXT NOT NULL CHECK(derived_status IN('completed','interrupted','storage-error')),
 derived_complete INTEGER NOT NULL CHECK(derived_complete IN(0,1)),derived_reason TEXT CHECK(derived_reason IS NULL OR length(CAST(derived_reason AS BLOB))<=256),
 normalization_timestamp INTEGER NOT NULL CHECK(normalization_timestamp>=0),
 discrepancy_json TEXT NOT NULL CHECK(json_valid(discrepancy_json) AND length(CAST(discrepancy_json AS BLOB))<=4096),
 subset_incomplete INTEGER NOT NULL CHECK(subset_incomplete=1),activation_allowed INTEGER NOT NULL CHECK(activation_allowed=0),
 PRIMARY KEY(base_run_id,session_id,account_id,platform,source),
 FOREIGN KEY(base_run_id,session_id,account_id,platform,source) REFERENCES legacy_declared_sessions(run_id,session_id,account_id,platform,source),
 CHECK((original_presence=0 AND derived_original_received IS NULL AND derived_original_saved IS NULL AND derived_original_dropped IS NULL
 AND derived_original_pending IS NULL AND derived_original_bytes IS NULL AND derived_original_redacted IS NULL)
 OR (original_presence=1 AND derived_original_received>=0 AND derived_original_received IS NOT NULL AND derived_original_saved>=0 AND derived_original_saved IS NOT NULL
 AND derived_original_dropped>=0 AND derived_original_dropped IS NOT NULL AND derived_original_pending=0 AND derived_original_pending IS NOT NULL
 AND derived_original_bytes=charged_native_bytes AND derived_original_bytes IS NOT NULL AND derived_original_redacted>=0 AND derived_original_redacted IS NOT NULL))
) STRICT;
CREATE TABLE legacy_projection_session_order(
 base_run_id TEXT NOT NULL,session_id TEXT NOT NULL,account_id TEXT NOT NULL,platform TEXT NOT NULL,source TEXT NOT NULL,
 metadata_source_id INTEGER NOT NULL,seed_ordinal INTEGER NOT NULL CHECK(seed_ordinal>=1),
 created_sequence INTEGER,created_sequence_present INTEGER NOT NULL CHECK(created_sequence_present IN(0,1)),
 policy TEXT NOT NULL CHECK(policy='declared-first-stable-v1'),sort_bucket INTEGER NOT NULL CHECK(sort_bucket IN(0,1)),
 declared_sort_value INTEGER NOT NULL CHECK(declared_sort_value>=0),effective_order INTEGER,
 missing_warning INTEGER NOT NULL CHECK(missing_warning IN(0,1)),collision_warning INTEGER,
 PRIMARY KEY(base_run_id,session_id,account_id,platform,source),UNIQUE(base_run_id,effective_order),
 FOREIGN KEY(base_run_id,session_id,account_id,platform,source) REFERENCES legacy_declared_sessions(run_id,session_id,account_id,platform,source),
 CHECK((created_sequence_present=1 AND created_sequence>=1 AND created_sequence IS NOT NULL AND sort_bucket=0 AND declared_sort_value=created_sequence AND missing_warning=0)
 OR (created_sequence_present=0 AND created_sequence IS NULL AND sort_bucket=1 AND declared_sort_value=0 AND missing_warning=1)),
 CHECK((effective_order IS NULL AND collision_warning IS NULL) OR (effective_order>=1 AND effective_order IS NOT NULL AND collision_warning IN(0,1) AND collision_warning IS NOT NULL))
) STRICT;
CREATE TABLE legacy_projection_receipts(
 base_run_id TEXT NOT NULL,operation_id TEXT NOT NULL,
 domain TEXT NOT NULL CHECK(domain IN('begin','sources','records','natives','freeze-groups','pair','fields','reconcile','order','phase-boundary')),
 intent_digest TEXT NOT NULL CHECK(length(intent_digest)=64 AND intent_digest NOT GLOB '*[^0-9a-f]*'),
 batch_digest TEXT NOT NULL CHECK(length(batch_digest)=64 AND batch_digest NOT GLOB '*[^0-9a-f]*'),
 expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),result_revision INTEGER NOT NULL CHECK(result_revision=expected_revision+1),
 watermark INTEGER NOT NULL CHECK(watermark=result_revision),
 phase TEXT NOT NULL CHECK(phase IN('sources','records','natives','freeze-groups','pair','fields','reconcile','order','verified-partial')),
 selection_json TEXT NOT NULL CHECK(json_valid(selection_json) AND length(CAST(selection_json AS BLOB))<=131072),
 receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB))<=131072),
 PRIMARY KEY(base_run_id,operation_id),FOREIGN KEY(base_run_id) REFERENCES legacy_projection_run(base_run_id)
) STRICT;
CREATE INDEX legacy_projection_source_work ON legacy_projection_sources(base_run_id,role,status,seed_ordinal,shard_number,source_id);
CREATE INDEX legacy_projection_source_owner ON legacy_projection_sources(base_run_id,session_id,account_id,platform,source,role,status,source_id);
CREATE INDEX legacy_projection_field_work ON legacy_projection_field_state(base_run_id,phase,seed_ordinal,session_id);
CREATE INDEX legacy_projection_order_key ON legacy_projection_session_order(base_run_id,sort_bucket,declared_sort_value,metadata_source_id,session_id);
CREATE INDEX legacy_projection_pair_work ON legacy_projection_pair_decisions(base_run_id,status,native_source_id,native_offset);

CREATE TRIGGER legacy_projection_meta_no_update BEFORE UPDATE ON legacy_projection_meta BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PROJECTION_META'); END;
CREATE TRIGGER legacy_projection_meta_no_delete BEFORE DELETE ON legacy_projection_meta BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PROJECTION_META'); END;
CREATE TRIGGER legacy_projection_run_binding BEFORE INSERT ON legacy_projection_run
WHEN NEW.base_run_id IS NOT (SELECT value FROM legacy_projection_meta WHERE key='base_run_id')
 OR NEW.policy_digest IS NOT (SELECT value FROM legacy_projection_meta WHERE key='policy_digest')
BEGIN SELECT RAISE(ABORT,'PROJECTION_RUN_BINDING'); END;
CREATE TRIGGER legacy_projection_run_identity BEFORE UPDATE ON legacy_projection_run
WHEN OLD.base_run_id IS NOT NEW.base_run_id OR OLD.policy_digest IS NOT NEW.policy_digest
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PROJECTION_RUN'); END;
CREATE TRIGGER legacy_projection_run_no_delete BEFORE DELETE ON legacy_projection_run BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PROJECTION_RUN'); END;
CREATE TRIGGER legacy_projection_base_run_sealed BEFORE UPDATE ON legacy_typed_runs
WHEN EXISTS(SELECT 1 FROM legacy_projection_meta WHERE key='base_run_id' AND value=OLD.run_id)
BEGIN SELECT RAISE(ABORT,'PROJECTION_BASE_PREFIX_SEALED'); END;
CREATE TRIGGER legacy_projection_base_source_sealed BEFORE UPDATE ON legacy_typed_sources
WHEN EXISTS(SELECT 1 FROM legacy_projection_meta WHERE key='base_run_id' AND value=OLD.run_id)
BEGIN SELECT RAISE(ABORT,'PROJECTION_BASE_PREFIX_SEALED'); END;
CREATE TRIGGER legacy_projection_base_receipt_sealed BEFORE INSERT ON legacy_control_receipts
WHEN EXISTS(SELECT 1 FROM legacy_projection_meta WHERE key='base_run_id' AND value=NEW.run_id)
BEGIN SELECT RAISE(ABORT,'PROJECTION_BASE_PREFIX_SEALED'); END;
CREATE TRIGGER legacy_projection_source_binding BEFORE INSERT ON legacy_projection_sources
WHEN NOT EXISTS(SELECT 1 FROM legacy_projection_run WHERE base_run_id=NEW.base_run_id AND phase='sources' AND source_phase='members')
 OR NOT EXISTS(SELECT 1 FROM legacy_typed_sources WHERE run_id=NEW.base_run_id AND source_id=NEW.source_id
 AND role=NEW.role AND source_sha256=NEW.source_sha256 AND source_size=NEW.source_size)
 OR (NEW.session_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM legacy_declared_sessions AS d JOIN legacy_source_charges AS c
 ON c.run_id=d.run_id AND c.session_id=d.session_id AND c.account_id=d.account_id AND c.platform=d.platform AND c.source=d.source
 WHERE d.run_id=NEW.base_run_id AND d.session_id=NEW.session_id AND d.account_id=NEW.account_id AND d.platform=NEW.platform AND d.source=NEW.source
 AND d.seed_ordinal=NEW.seed_ordinal AND c.source_id=NEW.source_id AND c.role=NEW.role AND c.source_sha256=NEW.source_sha256 AND c.source_size=NEW.source_size))
BEGIN SELECT RAISE(ABORT,'PROJECTION_SOURCE_BINDING'); END;
CREATE TRIGGER legacy_projection_source_identity BEFORE UPDATE ON legacy_projection_sources
WHEN OLD.base_run_id IS NOT NEW.base_run_id OR OLD.source_id IS NOT NEW.source_id OR OLD.role IS NOT NEW.role
 OR OLD.source_sha256 IS NOT NEW.source_sha256 OR OLD.source_size IS NOT NEW.source_size OR OLD.session_id IS NOT NEW.session_id
 OR OLD.account_id IS NOT NEW.account_id OR OLD.platform IS NOT NEW.platform OR OLD.source IS NOT NEW.source OR OLD.seed_ordinal IS NOT NEW.seed_ordinal OR OLD.shard_number IS NOT NEW.shard_number
 OR OLD.status IN('accepted','deferred','unresolved') OR NEW.next_offset<OLD.next_offset OR NEW.last_line<OLD.last_line OR NEW.revision<>OLD.revision+1
BEGIN SELECT RAISE(ABORT,'PROJECTION_SOURCE_PROGRESS'); END;
CREATE TRIGGER legacy_projection_source_no_delete BEFORE DELETE ON legacy_projection_sources BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PROJECTION_SOURCE'); END;
CREATE TRIGGER legacy_projection_order_owner BEFORE INSERT ON legacy_projection_native_order
WHEN NOT EXISTS(SELECT 1 FROM legacy_projection_run WHERE base_run_id=NEW.base_run_id AND phase='sources' AND source_phase='owners')
 OR NOT EXISTS(SELECT 1 FROM legacy_declared_sessions WHERE run_id=NEW.base_run_id AND session_id=NEW.session_id AND account_id=NEW.account_id AND platform=NEW.platform AND source=NEW.source AND seed_ordinal=NEW.seed_ordinal)
BEGIN SELECT RAISE(ABORT,'PROJECTION_OWNER_BINDING'); END;
CREATE TRIGGER legacy_projection_order_identity BEFORE UPDATE ON legacy_projection_native_order
WHEN OLD.base_run_id IS NOT NEW.base_run_id OR OLD.session_id IS NOT NEW.session_id OR OLD.account_id IS NOT NEW.account_id OR OLD.platform IS NOT NEW.platform
 OR OLD.source IS NOT NEW.source OR OLD.seed_ordinal IS NOT NEW.seed_ordinal OR NEW.last_original_sequence<OLD.last_original_sequence OR NEW.last_record_sequence<OLD.last_record_sequence
BEGIN SELECT RAISE(ABORT,'PROJECTION_NATIVE_ORDER_PROGRESS'); END;
CREATE TRIGGER legacy_projection_order_no_delete BEFORE DELETE ON legacy_projection_native_order BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PROJECTION_ORDER'); END;
CREATE TRIGGER legacy_projection_line_binding BEFORE INSERT ON legacy_projection_line_identity
WHEN NOT EXISTS(SELECT 1 FROM legacy_typed_units WHERE run_id=NEW.base_run_id AND source_id=NEW.source_id AND start_offset=NEW.start_offset
 AND outcome='accepted' AND unit_kind='line' AND line=NEW.line AND next_offset=NEW.next_offset AND hash_status='literal' AND literal_sha256=NEW.literal_sha256 AND capture_position=NEW.capture_position)
 OR NOT EXISTS(SELECT 1 FROM capture_rows WHERE physical_position=NEW.capture_position AND length(record_line)=NEW.projection_bytes)
BEGIN SELECT RAISE(ABORT,'PROJECTION_LINE_BINDING'); END;
CREATE TRIGGER legacy_projection_line_no_update BEFORE UPDATE ON legacy_projection_line_identity BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PROJECTION_LINE'); END;
CREATE TRIGGER legacy_projection_line_no_delete BEFORE DELETE ON legacy_projection_line_identity BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PROJECTION_LINE'); END;
CREATE TRIGGER legacy_projection_native_final_order BEFORE INSERT ON legacy_native_units
WHEN NEW.validation_status='accepted' AND (NEW.order_status NOT IN('valid','invalid')
 OR NOT EXISTS(SELECT 1 FROM legacy_projection_native_order WHERE base_run_id=NEW.run_id AND session_id=NEW.session_id AND account_id=NEW.account_id AND platform=NEW.platform AND source=NEW.source)
 OR (NEW.order_status='valid')<>EXISTS(SELECT 1 FROM legacy_projection_native_order WHERE base_run_id=NEW.run_id AND session_id=NEW.session_id AND account_id=NEW.account_id AND platform=NEW.platform AND source=NEW.source
 AND NEW.original_sequence>last_original_sequence AND NEW.record_sequence>last_record_sequence AND NEW.record_sequence<=max_capture_record_sequence))
BEGIN SELECT RAISE(ABORT,'PROJECTION_FINAL_NATIVE_ORDER'); END;
CREATE TRIGGER legacy_projection_capture_phase BEFORE INSERT ON legacy_capture_links
WHEN NOT EXISTS(SELECT 1 FROM legacy_projection_run WHERE base_run_id=NEW.run_id AND phase='records')
 OR NOT EXISTS(SELECT 1 FROM legacy_projection_sources WHERE base_run_id=NEW.run_id AND source_id=NEW.source_id AND role='canonical-records' AND status IN('pending','reading')
 AND session_id=NEW.session_id AND account_id=NEW.account_id AND platform=NEW.platform AND source=NEW.source)
 OR EXISTS(SELECT 1 FROM legacy_pair_groups AS g JOIN capture_rows AS c ON c.physical_position=NEW.capture_position
 WHERE g.run_id=NEW.run_id AND g.session_id=NEW.session_id AND g.account_id=NEW.account_id AND g.platform=NEW.platform AND g.source=NEW.source AND g.record_sequence=c.record_sequence AND g.phase='frozen')
BEGIN SELECT RAISE(ABORT,'PROJECTION_CAPTURE_PHASE'); END;
CREATE TRIGGER legacy_projection_native_phase BEFORE INSERT ON legacy_native_units
WHEN NOT EXISTS(SELECT 1 FROM legacy_projection_run WHERE base_run_id=NEW.run_id AND phase='natives')
 OR NOT EXISTS(SELECT 1 FROM legacy_projection_sources AS s JOIN legacy_projection_native_order AS o ON o.base_run_id=s.base_run_id
 AND o.session_id=s.session_id AND o.account_id=s.account_id AND o.platform=s.platform AND o.source=s.source
 WHERE s.base_run_id=NEW.run_id AND s.source_id=NEW.source_id AND s.role='canonical-native' AND s.status IN('pending','reading') AND o.record_terminal_sources=o.record_sources)
 OR (NEW.validation_status='accepted' AND EXISTS(SELECT 1 FROM legacy_pair_groups WHERE run_id=NEW.run_id AND session_id=NEW.session_id AND account_id=NEW.account_id AND platform=NEW.platform AND source=NEW.source AND record_sequence=NEW.record_sequence AND phase='frozen'))
BEGIN SELECT RAISE(ABORT,'PROJECTION_NATIVE_PHASE'); END;
-- Linear counters: a unique immutable physical link/native insertion contributes once.
CREATE TRIGGER legacy_projection_count_capture AFTER INSERT ON legacy_capture_links
BEGIN
 INSERT INTO legacy_pair_groups(run_id,session_id,account_id,platform,source,record_sequence,phase,revision,capture_cursor,native_source_cursor,native_offset_cursor,capture_count,native_count,count_complete,has_conflict)
 SELECT NEW.run_id,NEW.session_id,NEW.account_id,NEW.platform,NEW.source,record_sequence,'captures',1,0,0,0,1,0,0,0 FROM capture_rows WHERE physical_position=NEW.capture_position
 ON CONFLICT(run_id,session_id,account_id,platform,source,record_sequence) DO UPDATE SET capture_count=capture_count+1,revision=revision+1;
END;
CREATE TRIGGER legacy_projection_count_native AFTER INSERT ON legacy_native_units WHEN NEW.validation_status='accepted'
BEGIN
 INSERT INTO legacy_pair_groups(run_id,session_id,account_id,platform,source,record_sequence,phase,revision,capture_cursor,native_source_cursor,native_offset_cursor,capture_count,native_count,count_complete,has_conflict)
 VALUES(NEW.run_id,NEW.session_id,NEW.account_id,NEW.platform,NEW.source,NEW.record_sequence,'natives',1,0,0,0,0,1,0,0)
 ON CONFLICT(run_id,session_id,account_id,platform,source,record_sequence) DO UPDATE SET native_count=native_count+1,phase='natives',revision=revision+1;
 UPDATE legacy_projection_native_order SET
 last_original_sequence=CASE WHEN NEW.order_status='valid' THEN NEW.original_sequence ELSE last_original_sequence END,
 last_record_sequence=CASE WHEN NEW.order_status='valid' THEN NEW.record_sequence ELSE last_record_sequence END,
 max_witnessed_original_sequence=MAX(max_witnessed_original_sequence,NEW.original_sequence),
 max_witnessed_native_record_sequence=MAX(max_witnessed_native_record_sequence,NEW.record_sequence),
 validated_count=validated_count+1,order_accepted_count=order_accepted_count+CASE WHEN NEW.order_status='valid' THEN 1 ELSE 0 END,
 order_invalid_count=order_invalid_count+CASE WHEN NEW.order_status='invalid' THEN 1 ELSE 0 END,revision=revision+1
 WHERE base_run_id=NEW.run_id AND session_id=NEW.session_id AND account_id=NEW.account_id AND platform=NEW.platform AND source=NEW.source;
END;
CREATE TRIGGER legacy_projection_group_frozen BEFORE UPDATE ON legacy_pair_groups WHEN OLD.phase='frozen'
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PROJECTION_GROUP'); END;
CREATE TRIGGER legacy_projection_group_insert_guard BEFORE INSERT ON legacy_pair_groups
WHEN NEW.revision<>1 OR NEW.count_complete<>0 OR NEW.has_conflict<>0
 OR NOT ((NEW.phase='captures' AND NEW.capture_count=1 AND NEW.native_count=0 AND EXISTS(SELECT 1 FROM legacy_projection_run WHERE base_run_id=NEW.run_id AND phase='records'))
 OR (NEW.phase='natives' AND NEW.capture_count=0 AND NEW.native_count=1 AND EXISTS(SELECT 1 FROM legacy_projection_run WHERE base_run_id=NEW.run_id AND phase='natives')))
BEGIN SELECT RAISE(ABORT,'PROJECTION_GROUP_INSERT'); END;
CREATE TRIGGER legacy_projection_group_update_guard BEFORE UPDATE ON legacy_pair_groups WHEN OLD.phase<>'frozen'
 AND (NEW.revision<>OLD.revision+1 OR NEW.capture_count>9007199254740991 OR NEW.native_count>9007199254740991
 OR NOT ((NEW.phase='captures' AND NEW.capture_count=OLD.capture_count+1 AND NEW.native_count=OLD.native_count AND NEW.count_complete=0
 AND EXISTS(SELECT 1 FROM legacy_projection_run WHERE base_run_id=NEW.run_id AND phase='records'))
 OR (NEW.phase='natives' AND NEW.capture_count=OLD.capture_count AND NEW.native_count=OLD.native_count+1 AND NEW.count_complete=0
 AND EXISTS(SELECT 1 FROM legacy_projection_run WHERE base_run_id=NEW.run_id AND phase='natives'))
 OR (NEW.phase='frozen' AND NEW.capture_count=OLD.capture_count AND NEW.native_count=OLD.native_count AND NEW.count_complete=1
 AND EXISTS(SELECT 1 FROM legacy_projection_run WHERE base_run_id=NEW.run_id AND phase='freeze-groups'))))
BEGIN SELECT RAISE(ABORT,'PROJECTION_GROUP_UPDATE'); END;
CREATE TRIGGER legacy_projection_group_freeze BEFORE UPDATE ON legacy_pair_groups WHEN NEW.phase='frozen'
 AND (NOT EXISTS(SELECT 1 FROM legacy_projection_run WHERE base_run_id=NEW.run_id AND phase='freeze-groups')
 OR NOT EXISTS(SELECT 1 FROM legacy_projection_native_order WHERE base_run_id=NEW.run_id AND session_id=NEW.session_id AND account_id=NEW.account_id AND platform=NEW.platform AND source=NEW.source
 AND record_terminal_sources=record_sources AND native_terminal_sources=native_sources)
 OR EXISTS(SELECT 1 FROM legacy_projection_sources WHERE base_run_id=NEW.run_id AND session_id=NEW.session_id AND account_id=NEW.account_id AND platform=NEW.platform AND source=NEW.source
 AND role IN('canonical-records','canonical-native') AND status IN('pending','reading') LIMIT 1) OR NEW.count_complete<>1)
BEGIN SELECT RAISE(ABORT,'PROJECTION_GROUP_NOT_TERMINAL'); END;
CREATE TRIGGER legacy_projection_pair_binding BEFORE INSERT ON legacy_projection_pair_decisions
WHEN NEW.policy_digest IS NOT (SELECT value FROM legacy_projection_meta WHERE key='policy_digest')
 OR NOT EXISTS(SELECT 1 FROM legacy_projection_run WHERE base_run_id=NEW.base_run_id AND phase='pair')
 OR (NEW.session_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM legacy_pair_groups WHERE run_id=NEW.base_run_id AND session_id=NEW.session_id AND account_id=NEW.account_id AND platform=NEW.platform AND source=NEW.source AND record_sequence=NEW.record_sequence
 AND phase='frozen' AND count_complete=1 AND capture_count=NEW.capture_count AND native_count=NEW.native_count))
 OR (NEW.native_literal_sha256 IS NOT NULL AND NOT EXISTS(SELECT 1 FROM legacy_typed_units WHERE run_id=NEW.base_run_id AND source_id=NEW.native_source_id AND start_offset=NEW.native_offset AND hash_status='literal' AND literal_sha256=NEW.native_literal_sha256))
 OR (NEW.probe_capture_position IS NOT NULL AND NOT EXISTS(SELECT 1 FROM legacy_projection_line_identity WHERE capture_position=NEW.probe_capture_position AND base_run_id=NEW.base_run_id AND session_id=NEW.session_id AND account_id=NEW.account_id AND platform=NEW.platform AND source=NEW.source AND literal_sha256=NEW.capture_literal_sha256))
 OR (NEW.status='paired' AND (NOT EXISTS(SELECT 1 FROM legacy_native_units WHERE run_id=NEW.base_run_id AND source_id=NEW.native_source_id AND start_offset=NEW.native_offset AND validation_status='accepted' AND order_status='valid' AND record_sequence=NEW.record_sequence)
 OR NOT EXISTS(SELECT 1 FROM legacy_pair_groups WHERE run_id=NEW.base_run_id AND session_id=NEW.session_id AND account_id=NEW.account_id AND platform=NEW.platform AND source=NEW.source AND record_sequence=NEW.record_sequence AND has_conflict=0)
 OR NOT EXISTS(SELECT 1 FROM capture_rows WHERE physical_position=NEW.capture_position AND record_sequence=NEW.record_sequence)
 OR NOT EXISTS(SELECT 1 FROM legacy_projection_native_order WHERE base_run_id=NEW.base_run_id AND session_id=NEW.session_id AND account_id=NEW.account_id AND platform=NEW.platform AND source=NEW.source
 AND record_terminal_sources=record_sources AND native_terminal_sources=native_sources AND record_unknown_header=0 AND native_unknown_header=0)))
BEGIN SELECT RAISE(ABORT,'PROJECTION_PAIR_BINDING'); END;
CREATE TRIGGER legacy_projection_pair_no_update BEFORE UPDATE ON legacy_projection_pair_decisions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PROJECTION_PAIR'); END;
CREATE TRIGGER legacy_projection_pair_no_delete BEFORE DELETE ON legacy_projection_pair_decisions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PROJECTION_PAIR'); END;
CREATE TRIGGER legacy_projection_native_link_binding BEFORE INSERT ON legacy_native_links
WHEN NOT EXISTS(SELECT 1 FROM legacy_projection_pair_decisions WHERE base_run_id=NEW.run_id AND native_source_id=NEW.native_source_id AND native_offset=NEW.native_offset
 AND status=NEW.pairing_status AND code IS NEW.code AND capture_position IS NEW.capture_position AND session_id IS NEW.session_id AND account_id IS NEW.account_id AND platform IS NEW.platform AND source IS NEW.source)
BEGIN SELECT RAISE(ABORT,'PROJECTION_NATIVE_LINK_PROOF'); END;
CREATE TRIGGER legacy_projection_field_owner BEFORE INSERT ON legacy_projection_field_state
WHEN NOT EXISTS(SELECT 1 FROM legacy_projection_run WHERE base_run_id=NEW.base_run_id AND phase='sources' AND source_phase='owners')
 OR NOT EXISTS(SELECT 1 FROM legacy_declared_sessions WHERE run_id=NEW.base_run_id AND session_id=NEW.session_id AND account_id=NEW.account_id AND platform=NEW.platform AND source=NEW.source AND seed_ordinal=NEW.seed_ordinal)
BEGIN SELECT RAISE(ABORT,'PROJECTION_FIELD_OWNER'); END;
CREATE TRIGGER legacy_projection_field_identity BEFORE UPDATE ON legacy_projection_field_state
WHEN OLD.base_run_id IS NOT NEW.base_run_id OR OLD.session_id IS NOT NEW.session_id OR OLD.account_id IS NOT NEW.account_id OR OLD.platform IS NOT NEW.platform OR OLD.source IS NOT NEW.source OR OLD.seed_ordinal IS NOT NEW.seed_ordinal
 OR OLD.phase='done' OR NEW.after_capture_position<OLD.after_capture_position OR NEW.revision<>OLD.revision+1
BEGIN SELECT RAISE(ABORT,'PROJECTION_FIELD_PROGRESS'); END;
CREATE TRIGGER legacy_projection_field_state_no_delete BEFORE DELETE ON legacy_projection_field_state BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PROJECTION_FIELD_STATE'); END;
CREATE TRIGGER legacy_projection_field_link_no_update BEFORE UPDATE ON legacy_projection_field_links BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PROJECTION_FIELD_LINK'); END;
CREATE TRIGGER legacy_projection_field_link_no_delete BEFORE DELETE ON legacy_projection_field_links BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PROJECTION_FIELD_LINK'); END;
CREATE TRIGGER legacy_projection_field_insert_guard BEFORE INSERT ON field_entries
WHEN EXISTS(SELECT 1 FROM legacy_declared_sessions WHERE run_id=(SELECT value FROM legacy_projection_meta WHERE key='base_run_id') AND session_id=NEW.session_id)
 AND (NOT EXISTS(SELECT 1 FROM legacy_projection_run WHERE phase='fields') OR NEW.count<1 OR NEW.count>9007199254740991
 OR length(CAST(NEW.path AS BLOB))>4096 OR length(CAST(NEW.types AS BLOB))>256 OR NOT json_valid(NEW.types)
 OR length(CAST(NEW.examples AS BLOB))>1024 OR NOT json_valid(NEW.examples) OR json_type(NEW.examples)<>'array' OR json_array_length(NEW.examples)>3)
BEGIN SELECT RAISE(ABORT,'PROJECTION_FIELD_VALUES'); END;
CREATE TRIGGER legacy_projection_field_update_guard BEFORE UPDATE ON field_entries
WHEN (EXISTS(SELECT 1 FROM legacy_declared_sessions WHERE run_id=(SELECT value FROM legacy_projection_meta WHERE key='base_run_id') AND session_id=OLD.session_id)
 OR EXISTS(SELECT 1 FROM legacy_declared_sessions WHERE run_id=(SELECT value FROM legacy_projection_meta WHERE key='base_run_id') AND session_id=NEW.session_id))
 AND (NOT EXISTS(SELECT 1 FROM legacy_projection_run WHERE phase='fields') OR OLD.session_id IS NOT NEW.session_id OR OLD.path IS NOT NEW.path
 OR NEW.count<OLD.count OR NEW.count>9007199254740991 OR length(CAST(NEW.types AS BLOB))>256 OR NOT json_valid(NEW.types)
 OR length(CAST(NEW.examples AS BLOB))>1024 OR NOT json_valid(NEW.examples) OR json_type(NEW.examples)<>'array' OR json_array_length(NEW.examples)>3)
BEGIN SELECT RAISE(ABORT,'PROJECTION_FIELD_VALUES'); END;
CREATE TRIGGER legacy_projection_field_no_delete BEFORE DELETE ON field_entries WHEN EXISTS(SELECT 1 FROM legacy_declared_sessions WHERE run_id=(SELECT value FROM legacy_projection_meta WHERE key='base_run_id') AND session_id=OLD.session_id)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PROJECTION_FIELD'); END;
CREATE TRIGGER legacy_projection_reconcile_binding BEFORE INSERT ON legacy_projection_reconciliations
WHEN NEW.policy_digest IS NOT (SELECT value FROM legacy_projection_meta WHERE key='policy_digest')
 OR NOT EXISTS(SELECT 1 FROM legacy_projection_run WHERE base_run_id=NEW.base_run_id AND phase='reconcile')
 OR NOT EXISTS(SELECT 1 FROM legacy_declared_sessions WHERE run_id=NEW.base_run_id AND session_id=NEW.session_id AND account_id=NEW.account_id AND platform=NEW.platform AND source=NEW.source AND metadata_source_id=NEW.metadata_source_id)
BEGIN SELECT RAISE(ABORT,'PROJECTION_RECONCILE_BINDING'); END;
CREATE TRIGGER legacy_projection_reconcile_no_update BEFORE UPDATE ON legacy_projection_reconciliations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PROJECTION_RECONCILIATION'); END;
CREATE TRIGGER legacy_projection_reconcile_no_delete BEFORE DELETE ON legacy_projection_reconciliations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PROJECTION_RECONCILIATION'); END;
CREATE TRIGGER legacy_projection_session_order_binding BEFORE INSERT ON legacy_projection_session_order
WHEN NOT EXISTS(SELECT 1 FROM legacy_projection_run WHERE base_run_id=NEW.base_run_id AND phase='sources' AND source_phase='owners')
 OR NOT EXISTS(SELECT 1 FROM legacy_declared_sessions WHERE run_id=NEW.base_run_id AND session_id=NEW.session_id AND account_id=NEW.account_id AND platform=NEW.platform AND source=NEW.source
 AND metadata_source_id=NEW.metadata_source_id AND seed_ordinal=NEW.seed_ordinal AND created_sequence IS NEW.created_sequence AND created_sequence_present=NEW.created_sequence_present)
BEGIN SELECT RAISE(ABORT,'PROJECTION_SESSION_ORDER_BINDING'); END;
CREATE TRIGGER legacy_projection_session_order_identity BEFORE UPDATE ON legacy_projection_session_order
WHEN OLD.base_run_id IS NOT NEW.base_run_id OR OLD.session_id IS NOT NEW.session_id OR OLD.account_id IS NOT NEW.account_id OR OLD.platform IS NOT NEW.platform OR OLD.source IS NOT NEW.source
 OR OLD.metadata_source_id IS NOT NEW.metadata_source_id OR OLD.seed_ordinal IS NOT NEW.seed_ordinal OR OLD.created_sequence IS NOT NEW.created_sequence OR OLD.created_sequence_present IS NOT NEW.created_sequence_present
 OR OLD.policy IS NOT NEW.policy OR OLD.sort_bucket IS NOT NEW.sort_bucket OR OLD.declared_sort_value IS NOT NEW.declared_sort_value OR OLD.missing_warning IS NOT NEW.missing_warning
 OR OLD.effective_order IS NOT NULL OR NEW.effective_order IS NULL OR NEW.collision_warning IS NULL
 OR NOT EXISTS(SELECT 1 FROM legacy_projection_run WHERE base_run_id=NEW.base_run_id AND phase='order')
BEGIN SELECT RAISE(ABORT,'PROJECTION_EFFECTIVE_ORDER_PROGRESS'); END;
CREATE TRIGGER legacy_projection_session_order_no_delete BEFORE DELETE ON legacy_projection_session_order BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PROJECTION_SESSION_ORDER'); END;
CREATE TRIGGER legacy_projection_receipt_no_update BEFORE UPDATE ON legacy_projection_receipts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PROJECTION_RECEIPT'); END;
CREATE TRIGGER legacy_projection_receipt_no_delete BEFORE DELETE ON legacy_projection_receipts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PROJECTION_RECEIPT'); END;
`
export const PROJECTION_STAGE_FINGERPRINT=createHash('sha256').update(PROJECTION_STAGE_DDL.replace(/\s+/g,' ').trim()).digest('hex')
export interface ProjectionPolicy {
 version:1;recordModuleDigest:string;nativeModuleDigest:string;readerModuleDigest:string;
 fieldAlgorithmDigest:string;reconciliationAlgorithmDigest:string;
 orderPolicy:'declared-first-stable-v1';pairingPolicy:'literal-unique-with-order-v1';
 normalizationTimestamp:number;limitsDigest:string;decodedNodes:8192;
 maxRowMutations:128;maxEncodedBytes:1048576;maxByteWork:1048576;
 maxFieldPaths:1000;maxFieldPathBytes:4096;maxFieldExamples:3;maxFieldExampleBytes:256;
}
export interface ProjectionBinding {base:TypedStageBinding;basePrefixOperationId:string;policy:Readonly<ProjectionPolicy>}
export interface ProjectionAdmission {
 base:TypedStageAdmission;binding:ProjectionBinding;header:Readonly<Record<string,string>>;
 byteWork:number;activationAllowed:false;prefixAuthenticated:false;
}
export class TypedProjectionSchemaError extends Error {constructor(readonly code:string){super(code)}}
export function projectionFailure(code:string):never{throw new TypedProjectionSchemaError(code)}
export function projectionStable(x:unknown):string{return Array.isArray(x)?'['+x.map(projectionStable).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+projectionStable((x as Record<string,unknown>)[k])).join(',')+'}':JSON.stringify(x)}
export const projectionDigest=(x:unknown)=>createHash('sha256').update(projectionStable(x)).digest('hex')
export const PROJECTION_POLICY_KEYS=Object.freeze(['version','recordModuleDigest','nativeModuleDigest','readerModuleDigest','fieldAlgorithmDigest','reconciliationAlgorithmDigest','orderPolicy','pairingPolicy','normalizationTimestamp','limitsDigest','decodedNodes','maxRowMutations','maxEncodedBytes','maxByteWork','maxFieldPaths','maxFieldPathBytes','maxFieldExamples','maxFieldExampleBytes'] as const)
export const PROJECTION_HEADER_KEYS=Object.freeze(['kind','version','capability','schema_complete','activation_allowed','database_id','generation','base_run_id','base_manifest_digest','base_prefix_operation_id','base_prefix_revision','base_prefix_receipt_digest','base_prefix_run_digest','base_source_count','base_source_bytes','base_encoded_bytes','base_bootstrap_encoded_bytes','companion_fingerprint','limits_json','policy_json','policy_digest','bootstrap_encoded_bytes'] as const)
export const PROJECTION_OBJECT_DEFINITIONS=Object.freeze([...(PROJECTION_STAGE_DDL.match(/CREATE (?:TABLE|(?:UNIQUE )?INDEX) [^;]+;/g)??[]),...(PROJECTION_STAGE_DDL.match(/CREATE TRIGGER [\s\S]*?\bEND;/g)??[])].map(sql=>{const normalized=sql.replace(/\s+/g,' ').trim().replace(/;$/,''),m=normalized.match(/^CREATE (?:UNIQUE )?(TABLE|INDEX|TRIGGER) (\w+)/)!;return Object.freeze({type:m[1].toLowerCase(),name:m[2],sql:normalized})}))
export function projectionExact(x:unknown,keys:readonly string[]):asserts x is Record<string,unknown>{if(!x||typeof x!=='object'||types.isProxy(x)||![null,Object.prototype].includes(Object.getPrototypeOf(x))||Reflect.ownKeys(x).length!==keys.length)projectionFailure('PROJECTION_INPUT_INVALID');for(const k of keys){const d=Object.getOwnPropertyDescriptor(x,k);if(!d||!d.enumerable||!('value'in d))projectionFailure('PROJECTION_INPUT_INVALID')}}
/** Pure input normalization only. The base argument must come from base schema admission. */
export function normalizeProjectionBinding(input:ProjectionBinding,base:TypedStageBinding):ProjectionBinding{
 projectionExact(input,['base','basePrefixOperationId','policy']);projectionExact(input.policy,PROJECTION_POLICY_KEYS)
 let operationId:string;try{operationId=analysisId(input.basePrefixOperationId)}catch{projectionFailure('PROJECTION_INPUT_INVALID')}
 const p=input.policy
 for(const [k,v]of Object.entries({version:1,orderPolicy:'declared-first-stable-v1',pairingPolicy:'literal-unique-with-order-v1',decodedNodes:8192,maxRowMutations:128,maxEncodedBytes:1048576,maxByteWork:1048576,maxFieldPaths:1000,maxFieldPathBytes:4096,maxFieldExamples:3,maxFieldExampleBytes:256}))if(p[k as keyof ProjectionPolicy]!==v)projectionFailure('PROJECTION_INPUT_INVALID')
 if(typeof p.normalizationTimestamp!=='number'||!Number.isSafeInteger(p.normalizationTimestamp)||p.normalizationTimestamp<0)projectionFailure('PROJECTION_INPUT_INVALID')
 for(const k of ['recordModuleDigest','nativeModuleDigest','readerModuleDigest','fieldAlgorithmDigest','reconciliationAlgorithmDigest','limitsDigest'] as const)if(typeof p[k]!=='string'||!/^[0-9a-f]{64}$/.test(p[k]))projectionFailure('PROJECTION_INPUT_INVALID')
 if(p.normalizationTimestamp!==base.policy.normalizationTimestamp||p.limitsDigest!==projectionDigest(base.limits))projectionFailure('PROJECTION_BINDING_CONFLICT')
 return {base,basePrefixOperationId:operationId,policy:Object.freeze({...p})}
}
