// Fixed Task73 literal; scalar JSON text preserves UTF16 code units, never whole configuration blobs.
export const INTERACTION_DDL = `CREATE TABLE legacy_interaction_meta(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL CHECK(version=1),
 database_id TEXT NOT NULL CHECK(length(database_id)=36),generation INTEGER NOT NULL CHECK(generation>=1),
 base_run_id TEXT NOT NULL UNIQUE,base_header_digest TEXT NOT NULL,schema_fingerprint TEXT NOT NULL,policy_digest TEXT NOT NULL,
 schema_complete INTEGER NOT NULL CHECK(schema_complete=0),activation_allowed INTEGER NOT NULL CHECK(activation_allowed=0),
 FOREIGN KEY(base_run_id) REFERENCES legacy_typed_runs(run_id)
) STRICT;
CREATE TABLE legacy_interaction_run(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),base_run_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991),
 watermark INTEGER NOT NULL CHECK(watermark=revision),receipt_count INTEGER NOT NULL CHECK(receipt_count=revision),
 immutable_bytes INTEGER NOT NULL CHECK(immutable_bytes>=0),mutable_bytes INTEGER NOT NULL CHECK(mutable_bytes>=0),last_operation_id TEXT,
 CHECK((revision=0 AND last_operation_id IS NULL) OR (revision>0 AND length(last_operation_id)=36)),
 FOREIGN KEY(base_run_id) REFERENCES legacy_interaction_meta(base_run_id)
) STRICT;
CREATE TABLE legacy_interaction_heads(
 account_id TEXT PRIMARY KEY CHECK(json_valid(account_id) AND json_type(account_id)='text' AND length(CAST(account_id AS BLOB)) BETWEEN 2 AND 1202 AND length(json_extract(account_id,'$'))>=1),revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991),current_revision INTEGER,
 CHECK(current_revision IS NULL OR current_revision=revision),
 FOREIGN KEY(account_id,current_revision) REFERENCES legacy_interaction_revisions(account_id,revision)
) STRICT;
CREATE TABLE legacy_interaction_generations(
 generation_id TEXT PRIMARY KEY CHECK(length(generation_id)=36),account_id TEXT NOT NULL,family TEXT NOT NULL CHECK(family IN('routing','groups')),
 origin TEXT NOT NULL CHECK(origin IN('operator','application-default')),
 expected_config_revision INTEGER NOT NULL CHECK(expected_config_revision>=0),stage_revision INTEGER NOT NULL CHECK(stage_revision>=1),phase TEXT NOT NULL CHECK(phase IN('upload','verify-units','verify-items','sealed')),
 expected_units INTEGER NOT NULL CHECK(expected_units BETWEEN 0 AND 65536),expected_items INTEGER NOT NULL CHECK(expected_items BETWEEN 0 AND 100),
 next_ordinal INTEGER NOT NULL CHECK(next_ordinal>=1),verify_ordinal INTEGER NOT NULL CHECK(verify_ordinal>=0),verify_item INTEGER NOT NULL CHECK(verify_item>=0),
 content_digest TEXT NOT NULL CHECK(length(content_digest)=64),uploaded_digest TEXT NOT NULL CHECK(length(uploaded_digest)=64),verified_digest TEXT NOT NULL CHECK(length(verified_digest)=64),items_digest TEXT NOT NULL CHECK(length(items_digest)=64),
 mode TEXT,auto_enabled INTEGER,enter_at TEXT,exit_below TEXT,hold_ms TEXT,fans_club_weight TEXT,pay_level_weight TEXT,purchase_weight TEXT,
 behavior_present INTEGER,expected_behavior INTEGER,groups_enabled INTEGER,unresolved_attributes INTEGER NOT NULL CHECK(unresolved_attributes BETWEEN 0 AND 2000),
 CHECK((family='routing' AND mode IS NOT NULL AND mode IN('focus','selective','all') AND auto_enabled IS NOT NULL AND auto_enabled IN(0,1) AND enter_at IS NOT NULL AND exit_below IS NOT NULL AND hold_ms IS NOT NULL AND fans_club_weight IS NOT NULL AND pay_level_weight IS NOT NULL AND purchase_weight IS NOT NULL AND behavior_present IS NOT NULL AND behavior_present IN(0,1) AND expected_behavior IS NOT NULL AND expected_behavior BETWEEN 0 AND 7 AND groups_enabled IS NULL)
 OR(family='groups' AND mode IS NULL AND auto_enabled IS NULL AND enter_at IS NULL AND exit_below IS NULL AND hold_ms IS NULL AND fans_club_weight IS NULL AND pay_level_weight IS NULL AND purchase_weight IS NULL AND behavior_present IS NULL AND expected_behavior IS NULL AND groups_enabled IS NOT NULL AND groups_enabled IN(0,1))),
 CHECK(origin='operator' OR (family='routing' AND expected_config_revision=0)),
 UNIQUE(account_id,generation_id),UNIQUE(account_id,generation_id,family),FOREIGN KEY(account_id) REFERENCES legacy_interaction_heads(account_id)
) STRICT;
CREATE TABLE legacy_interaction_revisions(
 account_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=0),routing_generation_id TEXT NOT NULL,routing_family TEXT NOT NULL CHECK(routing_family='routing'),
 groups_generation_id TEXT,groups_family TEXT,operation_id TEXT NOT NULL CHECK(length(operation_id)=36),
 PRIMARY KEY(account_id,revision),CHECK((groups_generation_id IS NULL AND groups_family IS NULL) OR(groups_generation_id IS NOT NULL AND groups_family='groups')),
 FOREIGN KEY(account_id) REFERENCES legacy_interaction_heads(account_id),
 FOREIGN KEY(account_id,routing_generation_id,routing_family) REFERENCES legacy_interaction_generations(account_id,generation_id,family),
 FOREIGN KEY(account_id,groups_generation_id,groups_family) REFERENCES legacy_interaction_generations(account_id,generation_id,family)
) STRICT;
CREATE TABLE legacy_interaction_units(
 account_id TEXT NOT NULL,generation_id TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal>=1),kind TEXT NOT NULL CHECK(kind IN('item','event','condition','manual','behavior')),
 item_ordinal INTEGER,branch TEXT,child_ordinal INTEGER,typed_digest TEXT NOT NULL CHECK(length(typed_digest)=64),
 PRIMARY KEY(generation_id,ordinal),FOREIGN KEY(account_id,generation_id) REFERENCES legacy_interaction_generations(account_id,generation_id)
) STRICT;
CREATE TABLE legacy_interaction_items(
 account_id TEXT NOT NULL,generation_id TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 100),family TEXT NOT NULL CHECK(family IN('routing','groups')),
 item_id TEXT NOT NULL CHECK(length(item_id) BETWEEN 1 AND 80),name TEXT NOT NULL CHECK(json_valid(name) AND json_type(name)='text' AND length(CAST(name AS BLOB)) BETWEEN 2 AND 722 AND length(json_extract(name,'$'))>=1),enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),priority TEXT NOT NULL,
 event_count INTEGER NOT NULL CHECK(event_count BETWEEN 1 AND 2),all_count INTEGER NOT NULL CHECK(all_count BETWEEN 0 AND 20),any_present INTEGER NOT NULL CHECK(any_present IN(0,1)),any_count INTEGER NOT NULL CHECK(any_count BETWEEN 0 AND 20),
 voice INTEGER,text_enabled INTEGER,guidance TEXT CHECK(guidance IS NULL OR (json_valid(guidance) AND json_type(guidance)='text' AND length(CAST(guidance AS BLOB))<=6002)),platform TEXT,source TEXT,manual_present INTEGER,manual_count INTEGER,fallback INTEGER,cooldown_ms TEXT,channel TEXT,template TEXT CHECK(template IS NULL OR (json_valid(template) AND json_type(template)='text' AND length(CAST(template AS BLOB))<=6002)),include_nickname INTEGER,
 CHECK(any_present=1 OR any_count=0),
 CHECK((family='routing' AND voice IS NOT NULL AND voice IN(0,1) AND text_enabled IS NOT NULL AND text_enabled IN(0,1) AND platform IS NULL AND source IS NULL AND manual_present IS NULL AND manual_count IS NULL AND fallback IS NULL AND cooldown_ms IS NULL AND channel IS NULL AND template IS NULL AND include_nickname IS NULL)
 OR(family='groups' AND voice IS NULL AND text_enabled IS NULL AND platform IS NOT NULL AND source IS NOT NULL AND source IN('control','compass') AND manual_present IS NOT NULL AND manual_present IN(0,1) AND manual_count IS NOT NULL AND manual_count BETWEEN 0 AND 200 AND (manual_present=1 OR manual_count=0) AND (fallback IS NULL OR fallback IN(0,1)) AND channel IS NOT NULL AND channel IN('text','voice-preferred') AND guidance IS NOT NULL AND include_nickname IS NOT NULL AND include_nickname IN(0,1) AND all_count+any_count<=20)),
 PRIMARY KEY(generation_id,ordinal),UNIQUE(generation_id,item_id),UNIQUE(account_id,generation_id,ordinal),
 FOREIGN KEY(account_id,generation_id,family) REFERENCES legacy_interaction_generations(account_id,generation_id,family)
) STRICT;
CREATE TABLE legacy_interaction_events(
 account_id TEXT NOT NULL,generation_id TEXT NOT NULL,item_ordinal INTEGER NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 2),event TEXT NOT NULL CHECK(event IN('viewer.enter','viewer.comment')),
 PRIMARY KEY(generation_id,item_ordinal,ordinal),FOREIGN KEY(account_id,generation_id,item_ordinal) REFERENCES legacy_interaction_items(account_id,generation_id,ordinal)
) STRICT;
CREATE TABLE legacy_interaction_conditions(
 account_id TEXT NOT NULL,generation_id TEXT NOT NULL,item_ordinal INTEGER NOT NULL,branch TEXT NOT NULL CHECK(branch IN('all','any')),ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 20),
 field_kind TEXT NOT NULL CHECK(field_kind IN('builtin','attribute')),field_id TEXT NOT NULL CHECK(json_valid(field_id) AND json_type(field_id)='text' AND length(CAST(field_id AS BLOB)) BETWEEN 2 AND 386),op TEXT NOT NULL CHECK(op IN('eq','gte','lte','exists','isUnknown')),
 value_kind TEXT NOT NULL CHECK(value_kind IN('absent','string','number','boolean')),string_value TEXT CHECK(string_value IS NULL OR (json_valid(string_value) AND json_type(string_value)='text')), number_text TEXT,boolean_value INTEGER,
 CHECK((value_kind='absent' AND string_value IS NULL AND number_text IS NULL AND boolean_value IS NULL)
 OR(value_kind='string' AND string_value IS NOT NULL AND number_text IS NULL AND boolean_value IS NULL)
 OR(value_kind='number' AND string_value IS NULL AND number_text IS NOT NULL AND boolean_value IS NULL)
 OR(value_kind='boolean' AND string_value IS NULL AND number_text IS NULL AND boolean_value IS NOT NULL AND boolean_value IN(0,1))),
 PRIMARY KEY(generation_id,item_ordinal,branch,ordinal),FOREIGN KEY(account_id,generation_id,item_ordinal) REFERENCES legacy_interaction_items(account_id,generation_id,ordinal)
) STRICT;
CREATE TABLE legacy_interaction_manual_ids(
 account_id TEXT NOT NULL,generation_id TEXT NOT NULL,item_ordinal INTEGER NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 200),target_account_id TEXT NOT NULL CHECK(json_valid(target_account_id) AND json_type(target_account_id)='text' AND length(CAST(target_account_id AS BLOB))<=1202),target_platform TEXT NOT NULL,user_id TEXT NOT NULL CHECK(json_valid(user_id) AND json_type(user_id)='text' AND length(CAST(user_id AS BLOB))<=1538),
 PRIMARY KEY(generation_id,item_ordinal,ordinal),UNIQUE(generation_id,item_ordinal,target_account_id,target_platform,user_id),FOREIGN KEY(account_id,generation_id,item_ordinal) REFERENCES legacy_interaction_items(account_id,generation_id,ordinal)
) STRICT;
CREATE TABLE legacy_interaction_behavior_weights(
 account_id TEXT NOT NULL,generation_id TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 7),behavior TEXT NOT NULL CHECK(behavior IN('enter','comment','follow','like','subscription','fanclub','repeatComment')),weight_text TEXT NOT NULL,
 PRIMARY KEY(generation_id,ordinal),UNIQUE(generation_id,behavior),FOREIGN KEY(account_id,generation_id) REFERENCES legacy_interaction_generations(account_id,generation_id)
) STRICT;
CREATE TABLE legacy_interaction_account_mappings(
 account_id TEXT NOT NULL,platform TEXT NOT NULL,source TEXT NOT NULL CHECK(source IN('control','compass')),config_revision INTEGER NOT NULL,groups_generation_id TEXT NOT NULL,
 groups_enabled INTEGER NOT NULL CHECK(groups_enabled IN(0,1)),enabled_groups INTEGER NOT NULL CHECK(enabled_groups BETWEEN 0 AND 100),
 PRIMARY KEY(account_id,platform,source),FOREIGN KEY(account_id,config_revision) REFERENCES legacy_interaction_revisions(account_id,revision),FOREIGN KEY(account_id,groups_generation_id) REFERENCES legacy_interaction_generations(account_id,generation_id)
) STRICT;
CREATE INDEX legacy_interaction_mapping_accounts ON legacy_interaction_account_mappings(platform,source,account_id);
CREATE INDEX legacy_interaction_mapping_enabled ON legacy_interaction_account_mappings(platform,source,groups_enabled,account_id) WHERE enabled_groups>0;
CREATE TABLE legacy_interaction_mapping_dependencies(
 platform TEXT NOT NULL,source TEXT NOT NULL CHECK(source IN('control','compass')),stamp INTEGER NOT NULL CHECK(stamp BETWEEN 1 AND 9007199254740991),
 referenced_accounts INTEGER NOT NULL CHECK(referenced_accounts>=0),enabled_accounts INTEGER NOT NULL CHECK(enabled_accounts BETWEEN 0 AND referenced_accounts),last_operation_id TEXT NOT NULL CHECK(length(last_operation_id)=36),PRIMARY KEY(platform,source)
) STRICT;
CREATE TABLE legacy_interaction_dictionary_refs(
 account_id TEXT NOT NULL,generation_id TEXT NOT NULL,platform TEXT NOT NULL,source TEXT NOT NULL CHECK(source IN('control','compass')),version_known INTEGER NOT NULL CHECK(version_known IN(0,1)),version INTEGER,dictionary_generation_id TEXT,content_digest TEXT,
 CHECK((version_known=0 AND version IS NULL AND dictionary_generation_id IS NULL AND content_digest IS NULL) OR(version_known=1 AND version IS NOT NULL AND version>=1 AND dictionary_generation_id IS NOT NULL AND length(dictionary_generation_id)=36 AND content_digest IS NOT NULL AND length(content_digest)=64)),
 PRIMARY KEY(generation_id,platform,source),FOREIGN KEY(account_id,generation_id) REFERENCES legacy_interaction_generations(account_id,generation_id)
) STRICT;
CREATE TABLE legacy_interaction_receipts(
 operation_id TEXT PRIMARY KEY CHECK(length(operation_id)=36),base_run_id TEXT NOT NULL,account_id TEXT NOT NULL,generation_id TEXT,
 method TEXT NOT NULL CHECK(method IN('prepare','append','verify','publish-routing','publish-groups')),intent_digest TEXT NOT NULL CHECK(length(intent_digest)=64),receipt_digest TEXT NOT NULL CHECK(length(receipt_digest)=64),
 selection_json TEXT NOT NULL CHECK(json_valid(selection_json) AND length(CAST(selection_json AS BLOB))<=16384),receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB))<=8192),
 FOREIGN KEY(base_run_id) REFERENCES legacy_interaction_meta(base_run_id),FOREIGN KEY(account_id) REFERENCES legacy_interaction_heads(account_id),FOREIGN KEY(account_id,generation_id) REFERENCES legacy_interaction_generations(account_id,generation_id)
) STRICT;
CREATE TRIGGER legacy_interaction_meta_update BEFORE UPDATE ON legacy_interaction_meta BEGIN SELECT RAISE(ABORT,'INTERACTION_META_IMMUTABLE'); END;
CREATE TRIGGER legacy_interaction_meta_delete BEFORE DELETE ON legacy_interaction_meta BEGIN SELECT RAISE(ABORT,'INTERACTION_META_IMMUTABLE'); END;
CREATE TRIGGER legacy_interaction_revisions_update BEFORE UPDATE ON legacy_interaction_revisions BEGIN SELECT RAISE(ABORT,'INTERACTION_REVISION_IMMUTABLE'); END;
CREATE TRIGGER legacy_interaction_revisions_delete BEFORE DELETE ON legacy_interaction_revisions BEGIN SELECT RAISE(ABORT,'INTERACTION_REVISION_IMMUTABLE'); END;
CREATE TRIGGER legacy_interaction_receipts_update BEFORE UPDATE ON legacy_interaction_receipts BEGIN SELECT RAISE(ABORT,'INTERACTION_RECEIPT_IMMUTABLE'); END;
CREATE TRIGGER legacy_interaction_receipts_delete BEFORE DELETE ON legacy_interaction_receipts BEGIN SELECT RAISE(ABORT,'INTERACTION_RECEIPT_IMMUTABLE'); END;

CREATE TRIGGER legacy_interaction_run_delete BEFORE DELETE ON legacy_interaction_run BEGIN SELECT RAISE(ABORT,'INTERACTION_RUN_IMMUTABLE'); END;
CREATE TRIGGER legacy_interaction_run_guard BEFORE UPDATE ON legacy_interaction_run WHEN NEW.singleton<>OLD.singleton OR NEW.base_run_id IS NOT OLD.base_run_id OR NEW.revision<>OLD.revision+1 OR NEW.watermark<>NEW.revision OR NEW.receipt_count<>NEW.revision OR NEW.immutable_bytes<=OLD.immutable_bytes OR NEW.last_operation_id IS NULL BEGIN SELECT RAISE(ABORT,'INTERACTION_RUN_INVALID'); END;
CREATE TRIGGER legacy_interaction_heads_delete BEFORE DELETE ON legacy_interaction_heads BEGIN SELECT RAISE(ABORT,'INTERACTION_HEAD_IMMUTABLE'); END;
CREATE TRIGGER legacy_interaction_heads_update BEFORE UPDATE ON legacy_interaction_heads WHEN NEW.account_id IS NOT OLD.account_id OR NEW.revision<>OLD.revision+1 OR NEW.current_revision IS NULL OR NEW.current_revision<>NEW.revision BEGIN SELECT RAISE(ABORT,'INTERACTION_HEAD_INVALID'); END;
CREATE TRIGGER legacy_interaction_generation_delete BEFORE DELETE ON legacy_interaction_generations BEGIN SELECT RAISE(ABORT,'INTERACTION_GENERATION_IMMUTABLE'); END;
CREATE TRIGGER legacy_interaction_revision_binding BEFORE INSERT ON legacy_interaction_revisions WHEN NOT EXISTS(SELECT 1 FROM legacy_interaction_generations g WHERE g.account_id=NEW.account_id AND g.generation_id=NEW.routing_generation_id AND g.family='routing' AND g.phase='sealed') OR (NEW.groups_generation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM legacy_interaction_generations g WHERE g.account_id=NEW.account_id AND g.generation_id=NEW.groups_generation_id AND g.family='groups' AND g.phase='sealed')) BEGIN SELECT RAISE(ABORT,'INTERACTION_REVISION_INVALID'); END;
CREATE TRIGGER legacy_interaction_mapping_dependency_delete BEFORE DELETE ON legacy_interaction_mapping_dependencies BEGIN SELECT RAISE(ABORT,'INTERACTION_DEPENDENCY_IMMUTABLE'); END;
CREATE TRIGGER legacy_interaction_mapping_dependency_update BEFORE UPDATE ON legacy_interaction_mapping_dependencies WHEN NEW.platform IS NOT OLD.platform OR NEW.source IS NOT OLD.source OR NEW.stamp<>OLD.stamp+1 BEGIN SELECT RAISE(ABORT,'INTERACTION_DEPENDENCY_INVALID'); END;
CREATE TRIGGER legacy_interaction_mapping_identity BEFORE UPDATE ON legacy_interaction_account_mappings WHEN NEW.account_id IS NOT OLD.account_id OR NEW.platform IS NOT OLD.platform OR NEW.source IS NOT OLD.source BEGIN SELECT RAISE(ABORT,'INTERACTION_REFERENCE_IMMUTABLE'); END;
CREATE INDEX legacy_interaction_item_mapping ON legacy_interaction_items(generation_id,platform,source,enabled,ordinal) WHERE family='groups';
CREATE TRIGGER legacy_interaction_units_update BEFORE UPDATE ON legacy_interaction_units BEGIN SELECT RAISE(ABORT,'INTERACTION_CONTENT_IMMUTABLE'); END;
CREATE TRIGGER legacy_interaction_units_delete BEFORE DELETE ON legacy_interaction_units BEGIN SELECT RAISE(ABORT,'INTERACTION_CONTENT_IMMUTABLE'); END;
CREATE TRIGGER legacy_interaction_units_insert BEFORE INSERT ON legacy_interaction_units WHEN NOT EXISTS(SELECT 1 FROM legacy_interaction_generations g WHERE g.account_id=NEW.account_id AND g.generation_id=NEW.generation_id AND g.phase='upload') BEGIN SELECT RAISE(ABORT,'INTERACTION_UPLOAD_CLOSED'); END;
CREATE TRIGGER legacy_interaction_items_update BEFORE UPDATE ON legacy_interaction_items BEGIN SELECT RAISE(ABORT,'INTERACTION_CONTENT_IMMUTABLE'); END;
CREATE TRIGGER legacy_interaction_items_delete BEFORE DELETE ON legacy_interaction_items BEGIN SELECT RAISE(ABORT,'INTERACTION_CONTENT_IMMUTABLE'); END;
CREATE TRIGGER legacy_interaction_items_insert BEFORE INSERT ON legacy_interaction_items WHEN NOT EXISTS(SELECT 1 FROM legacy_interaction_generations g WHERE g.account_id=NEW.account_id AND g.generation_id=NEW.generation_id AND g.phase='upload') BEGIN SELECT RAISE(ABORT,'INTERACTION_UPLOAD_CLOSED'); END;
CREATE TRIGGER legacy_interaction_events_update BEFORE UPDATE ON legacy_interaction_events BEGIN SELECT RAISE(ABORT,'INTERACTION_CONTENT_IMMUTABLE'); END;
CREATE TRIGGER legacy_interaction_events_delete BEFORE DELETE ON legacy_interaction_events BEGIN SELECT RAISE(ABORT,'INTERACTION_CONTENT_IMMUTABLE'); END;
CREATE TRIGGER legacy_interaction_events_insert BEFORE INSERT ON legacy_interaction_events WHEN NOT EXISTS(SELECT 1 FROM legacy_interaction_generations g WHERE g.account_id=NEW.account_id AND g.generation_id=NEW.generation_id AND g.phase='upload') BEGIN SELECT RAISE(ABORT,'INTERACTION_UPLOAD_CLOSED'); END;
CREATE TRIGGER legacy_interaction_conditions_update BEFORE UPDATE ON legacy_interaction_conditions BEGIN SELECT RAISE(ABORT,'INTERACTION_CONTENT_IMMUTABLE'); END;
CREATE TRIGGER legacy_interaction_conditions_delete BEFORE DELETE ON legacy_interaction_conditions BEGIN SELECT RAISE(ABORT,'INTERACTION_CONTENT_IMMUTABLE'); END;
CREATE TRIGGER legacy_interaction_conditions_insert BEFORE INSERT ON legacy_interaction_conditions WHEN NOT EXISTS(SELECT 1 FROM legacy_interaction_generations g WHERE g.account_id=NEW.account_id AND g.generation_id=NEW.generation_id AND g.phase='upload') BEGIN SELECT RAISE(ABORT,'INTERACTION_UPLOAD_CLOSED'); END;
CREATE TRIGGER legacy_interaction_manual_ids_update BEFORE UPDATE ON legacy_interaction_manual_ids BEGIN SELECT RAISE(ABORT,'INTERACTION_CONTENT_IMMUTABLE'); END;
CREATE TRIGGER legacy_interaction_manual_ids_delete BEFORE DELETE ON legacy_interaction_manual_ids BEGIN SELECT RAISE(ABORT,'INTERACTION_CONTENT_IMMUTABLE'); END;
CREATE TRIGGER legacy_interaction_manual_ids_insert BEFORE INSERT ON legacy_interaction_manual_ids WHEN NOT EXISTS(SELECT 1 FROM legacy_interaction_generations g WHERE g.account_id=NEW.account_id AND g.generation_id=NEW.generation_id AND g.phase='upload') BEGIN SELECT RAISE(ABORT,'INTERACTION_UPLOAD_CLOSED'); END;
CREATE TRIGGER legacy_interaction_behavior_weights_update BEFORE UPDATE ON legacy_interaction_behavior_weights BEGIN SELECT RAISE(ABORT,'INTERACTION_CONTENT_IMMUTABLE'); END;
CREATE TRIGGER legacy_interaction_behavior_weights_delete BEFORE DELETE ON legacy_interaction_behavior_weights BEGIN SELECT RAISE(ABORT,'INTERACTION_CONTENT_IMMUTABLE'); END;
CREATE TRIGGER legacy_interaction_behavior_weights_insert BEFORE INSERT ON legacy_interaction_behavior_weights WHEN NOT EXISTS(SELECT 1 FROM legacy_interaction_generations g WHERE g.account_id=NEW.account_id AND g.generation_id=NEW.generation_id AND g.phase='upload') BEGIN SELECT RAISE(ABORT,'INTERACTION_UPLOAD_CLOSED'); END;
CREATE TRIGGER legacy_interaction_dictionary_refs_update BEFORE UPDATE ON legacy_interaction_dictionary_refs BEGIN SELECT RAISE(ABORT,'INTERACTION_CONTENT_IMMUTABLE'); END;
CREATE TRIGGER legacy_interaction_dictionary_refs_delete BEFORE DELETE ON legacy_interaction_dictionary_refs BEGIN SELECT RAISE(ABORT,'INTERACTION_CONTENT_IMMUTABLE'); END;
CREATE TRIGGER legacy_interaction_dictionary_refs_insert BEFORE INSERT ON legacy_interaction_dictionary_refs WHEN NOT EXISTS(SELECT 1 FROM legacy_interaction_generations g WHERE g.account_id=NEW.account_id AND g.generation_id=NEW.generation_id AND g.phase='upload') BEGIN SELECT RAISE(ABORT,'INTERACTION_UPLOAD_CLOSED'); END;
CREATE TRIGGER legacy_interaction_generation_update BEFORE UPDATE ON legacy_interaction_generations WHEN OLD.phase='sealed' OR NEW.generation_id IS NOT OLD.generation_id OR NEW.account_id IS NOT OLD.account_id OR NEW.family IS NOT OLD.family OR NEW.origin IS NOT OLD.origin OR NEW.expected_config_revision IS NOT OLD.expected_config_revision OR NEW.expected_units IS NOT OLD.expected_units OR NEW.expected_items IS NOT OLD.expected_items OR NEW.content_digest IS NOT OLD.content_digest OR NEW.mode IS NOT OLD.mode OR NEW.auto_enabled IS NOT OLD.auto_enabled OR NEW.enter_at IS NOT OLD.enter_at OR NEW.exit_below IS NOT OLD.exit_below OR NEW.hold_ms IS NOT OLD.hold_ms OR NEW.fans_club_weight IS NOT OLD.fans_club_weight OR NEW.pay_level_weight IS NOT OLD.pay_level_weight OR NEW.purchase_weight IS NOT OLD.purchase_weight OR NEW.behavior_present IS NOT OLD.behavior_present OR NEW.expected_behavior IS NOT OLD.expected_behavior OR NEW.groups_enabled IS NOT OLD.groups_enabled OR NEW.stage_revision<>OLD.stage_revision+1 OR NEW.next_ordinal<OLD.next_ordinal OR NEW.verify_ordinal<OLD.verify_ordinal OR NEW.verify_item<OLD.verify_item OR NEW.unresolved_attributes<OLD.unresolved_attributes OR NOT((OLD.phase='upload' AND NEW.phase IN('upload','verify-units')) OR(OLD.phase='verify-units' AND NEW.phase IN('verify-units','verify-items')) OR(OLD.phase='verify-items' AND NEW.phase IN('verify-items','sealed'))) BEGIN SELECT RAISE(ABORT,'INTERACTION_GENERATION_INVALID'); END;
CREATE TRIGGER legacy_interaction_mapping_binding BEFORE INSERT ON legacy_interaction_account_mappings WHEN NOT EXISTS(SELECT 1 FROM legacy_interaction_heads h JOIN legacy_interaction_revisions r ON r.account_id=h.account_id AND r.revision=h.current_revision JOIN legacy_interaction_generations g ON g.account_id=r.account_id AND g.generation_id=r.groups_generation_id WHERE h.account_id=NEW.account_id AND h.current_revision=NEW.config_revision AND r.groups_generation_id=NEW.groups_generation_id AND g.family='groups' AND g.phase='sealed' AND g.groups_enabled=NEW.groups_enabled) BEGIN SELECT RAISE(ABORT,'INTERACTION_REFERENCE_INVALID'); END;
CREATE INDEX legacy_interaction_unit_children ON legacy_interaction_units(generation_id,kind,item_ordinal,child_ordinal,branch);
CREATE TRIGGER legacy_interaction_mapping_update_binding BEFORE UPDATE ON legacy_interaction_account_mappings WHEN NOT EXISTS(SELECT 1 FROM legacy_interaction_heads h JOIN legacy_interaction_revisions r ON r.account_id=h.account_id AND r.revision=h.current_revision JOIN legacy_interaction_generations g ON g.account_id=r.account_id AND g.generation_id=r.groups_generation_id WHERE h.account_id=NEW.account_id AND h.current_revision=NEW.config_revision AND r.groups_generation_id=NEW.groups_generation_id AND g.family='groups' AND g.phase='sealed' AND g.groups_enabled=NEW.groups_enabled) BEGIN SELECT RAISE(ABORT,'INTERACTION_REFERENCE_INVALID'); END;
`
