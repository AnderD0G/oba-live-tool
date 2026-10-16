import {createHash} from 'node:crypto'
export const CAPACITY_SUCCESSOR_DDL=`
CREATE TABLE legacy_capacity_meta(
 id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL CHECK(version=2),
 database_id TEXT NOT NULL CHECK(length(database_id)=36),generation INTEGER NOT NULL CHECK(generation>=1 AND generation<=9007199254740991),
 base_run_id TEXT NOT NULL,policy_digest TEXT NOT NULL,binding_digest TEXT NOT NULL,parent_catalog_digest TEXT NOT NULL,
 parent_prefix_operation_id TEXT NOT NULL,parent_prefix_row_digest TEXT NOT NULL,parent_header_digest TEXT NOT NULL,
 policy_json TEXT NOT NULL CHECK(length(CAST(policy_json AS BLOB))<=4096),fingerprint TEXT NOT NULL,
 source_bytes INTEGER NOT NULL CHECK(source_bytes>=0 AND source_bytes<=5368709120),
 initial_retained_bytes INTEGER NOT NULL CHECK(initial_retained_bytes>=0 AND initial_retained_bytes<=25769803776),
 UNIQUE(database_id,generation,base_run_id),UNIQUE(base_run_id,policy_digest),
 FOREIGN KEY(base_run_id) REFERENCES legacy_typed_runs(run_id)
) STRICT;
CREATE TABLE legacy_capacity_run(
 base_run_id TEXT PRIMARY KEY,policy_digest TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>=0 AND revision<=9007199254740991),
 watermark INTEGER NOT NULL CHECK(watermark=revision),receipt_count INTEGER NOT NULL CHECK(receipt_count=revision),
 immutable_bytes INTEGER NOT NULL CHECK(immutable_bytes>=0 AND immutable_bytes<=25769803776),
 mutable_bytes INTEGER NOT NULL CHECK(mutable_bytes>=0 AND mutable_bytes<=25769803776),
 latest_operation_id TEXT,
 CHECK((revision=0 AND latest_operation_id IS NULL) OR (revision>0 AND latest_operation_id IS NOT NULL)),
 FOREIGN KEY(base_run_id,policy_digest) REFERENCES legacy_capacity_meta(base_run_id,policy_digest)
) STRICT;
CREATE TABLE legacy_capacity_mutable(
 base_run_id TEXT NOT NULL,object_key TEXT NOT NULL CHECK(length(CAST(object_key AS BLOB))<=128),
 value_json TEXT NOT NULL CHECK(length(CAST(value_json AS BLOB))<=65536),retained_bytes INTEGER NOT NULL CHECK(retained_bytes>=0),
 PRIMARY KEY(base_run_id,object_key),FOREIGN KEY(base_run_id) REFERENCES legacy_capacity_run(base_run_id)
) STRICT;
CREATE TABLE legacy_capacity_receipts(
 base_run_id TEXT NOT NULL,operation_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=1 AND revision<=9007199254740991),
 intent_digest TEXT NOT NULL,receipt_digest TEXT NOT NULL,receipt_json TEXT NOT NULL CHECK(length(CAST(receipt_json AS BLOB))<=4096),
 PRIMARY KEY(base_run_id,operation_id),UNIQUE(base_run_id,revision),FOREIGN KEY(base_run_id) REFERENCES legacy_capacity_run(base_run_id)
) STRICT;
CREATE TRIGGER legacy_capacity_meta_no_update BEFORE UPDATE ON legacy_capacity_meta BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CAPACITY_META'); END;
CREATE TRIGGER legacy_capacity_meta_no_delete BEFORE DELETE ON legacy_capacity_meta BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CAPACITY_META'); END;
CREATE TRIGGER legacy_capacity_run_guard BEFORE UPDATE ON legacy_capacity_run
WHEN OLD.base_run_id IS NOT NEW.base_run_id OR OLD.policy_digest IS NOT NEW.policy_digest
 OR NEW.revision<>OLD.revision+1 OR NEW.watermark<>NEW.revision OR NEW.receipt_count<>NEW.revision
 OR NEW.immutable_bytes<=OLD.immutable_bytes OR NEW.latest_operation_id IS NULL
BEGIN SELECT RAISE(ABORT,'CAPACITY_RUN_CONFLICT'); END;
CREATE TRIGGER legacy_capacity_run_no_delete BEFORE DELETE ON legacy_capacity_run BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CAPACITY_RUN'); END;
CREATE TRIGGER legacy_capacity_mutable_identity BEFORE UPDATE ON legacy_capacity_mutable
WHEN OLD.base_run_id IS NOT NEW.base_run_id OR OLD.object_key IS NOT NEW.object_key
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CAPACITY_OBJECT'); END;
CREATE TRIGGER legacy_capacity_mutable_no_delete BEFORE DELETE ON legacy_capacity_mutable BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CAPACITY_OBJECT'); END;
CREATE TRIGGER legacy_capacity_receipts_no_update BEFORE UPDATE ON legacy_capacity_receipts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CAPACITY_RECEIPT'); END;
CREATE TRIGGER legacy_capacity_receipts_no_delete BEFORE DELETE ON legacy_capacity_receipts BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CAPACITY_RECEIPT'); END;
CREATE TRIGGER legacy_capacity_receipt_binding BEFORE INSERT ON legacy_capacity_receipts
WHEN NOT EXISTS(SELECT 1 FROM legacy_capacity_run WHERE base_run_id=NEW.base_run_id AND revision=NEW.revision AND latest_operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'CAPACITY_RECEIPT_CONFLICT'); END;
`
const sha=(value:string)=>createHash('sha256').update(value).digest('hex')
export const normalizeCapacitySql=(sql:string)=>sql.replace(/\bIF NOT EXISTS\b/gi,'').replace(/\s+/g,' ').trim().replace(/;$/,'')
export const CAPACITY_FINGERPRINT=sha(CAPACITY_SUCCESSOR_DDL.replace(/\s+/g,' ').trim())
export const CAPACITY_OBJECT_DEFINITIONS=Object.freeze([...(CAPACITY_SUCCESSOR_DDL.match(/CREATE TABLE [^;]+;/g)??[]),...(CAPACITY_SUCCESSOR_DDL.match(/CREATE TRIGGER [\s\S]*? END;/g)??[])].map(sql=>{const m=/CREATE (TABLE|TRIGGER) ([a-z_]+)/.exec(sql)!;return Object.freeze({type:m[1].toLowerCase(),name:m[2],sql:normalizeCapacitySql(sql)})}))


