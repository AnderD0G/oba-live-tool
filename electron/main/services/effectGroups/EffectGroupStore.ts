import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  canonicalEffectGroupJson, EffectGroupError, effectGroupInteger, effectGroupObject, effectGroupString,
  normalizeEffectGroupsConfig, type EffectGroupProof, type EffectGroupProofBinding, type EffectGroupResource,
  type EffectGroupRunEvent, type EffectGroupsConfig,
} from '../../../../shared/effectGroups'

export interface EffectGroupOperation {
  accountId: string
  requestId: string
  kind: 'apply' | 'sync' | 'preview' | 'retire'
  contentHash: string
  state: 'pending' | 'completed' | 'failed'
  detail?: Record<string, unknown>
  response?: Record<string, unknown>
}
export interface EffectGroupRetirement {
  accountId: string
  groupId: string
  generation: number
  at: number
  reason: string
}
export interface EffectGroupSaveProof { token: string; binding: EffectGroupProofBinding; now?: number }
const digest = (value: unknown) => createHash('sha256').update(canonicalEffectGroupJson(value)).digest('hex')
const configContent = (config: EffectGroupsConfig) => ({ ...config, revision: 0 })
const parse = <T>(row: Record<string, unknown> | undefined, field = 'json'): T | undefined => row ? JSON.parse(String(row[field])) as T : undefined
const RESOURCE_FIELDS = ['accountId', 'groupId', 'generation', 'installId', 'sceneName', 'sceneUuid', 'parentSceneName',
  'parentSceneUuid', 'parentItemId', 'captionInputName', 'captionInputUuid', 'animationInputs', 'state', 'configHash', 'label',
  'ownedIdentities', 'creationNonce', 'captionSettingsHash', 'sourceRevision', 'error', 'cleanupToken', 'snapshot']

/** The control plane authority. OBS receipts are external; only acknowledged owned identities are recorded here. */
export class EffectGroupStore {
  private readonly db: DatabaseSync
  readonly installId: string
  private closed = false

  constructor(readonly file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    try {
      this.db.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA foreign_keys=ON;
        PRAGMA busy_timeout=5000;
        PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS configs(account_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>=1), json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS groups(
          account_id TEXT NOT NULL, group_id TEXT NOT NULL, audience_rule_id TEXT NOT NULL, action_kind TEXT NOT NULL,
          desired_active INTEGER NOT NULL, json TEXT NOT NULL,
          PRIMARY KEY(account_id,group_id), UNIQUE(account_id,audience_rule_id,action_kind),
          FOREIGN KEY(account_id) REFERENCES configs(account_id));
        CREATE TABLE IF NOT EXISTS requests(
          account_id TEXT NOT NULL, request_id TEXT NOT NULL, content_hash TEXT NOT NULL, base_revision INTEGER NOT NULL,
          response_json TEXT NOT NULL, PRIMARY KEY(account_id,request_id));
        CREATE TABLE IF NOT EXISTS proofs(
          token TEXT PRIMARY KEY, account_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
          consumed_at INTEGER, binding_hash TEXT NOT NULL, json TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS proofs_account ON proofs(account_id,expires_at);
        CREATE TABLE IF NOT EXISTS resources(
          account_id TEXT NOT NULL, group_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>=1),
          install_id TEXT NOT NULL, state TEXT NOT NULL, json TEXT NOT NULL,
          PRIMARY KEY(account_id,group_id,generation),
          FOREIGN KEY(account_id,group_id) REFERENCES groups(account_id,group_id));
        CREATE INDEX IF NOT EXISTS resources_account_state ON resources(account_id,state);
        CREATE TABLE IF NOT EXISTS generations(
          account_id TEXT NOT NULL, group_id TEXT NOT NULL, highwater INTEGER NOT NULL CHECK(highwater>=1),
          PRIMARY KEY(account_id,group_id), FOREIGN KEY(account_id,group_id) REFERENCES groups(account_id,group_id));
        INSERT INTO generations(account_id,group_id,highwater)
          SELECT account_id,group_id,MAX(generation) FROM resources GROUP BY account_id,group_id
          ON CONFLICT(account_id,group_id) DO UPDATE SET highwater=MAX(highwater,excluded.highwater);
        CREATE TABLE IF NOT EXISTS retirements(
          account_id TEXT NOT NULL, group_id TEXT NOT NULL, generation INTEGER NOT NULL, json TEXT NOT NULL,
          PRIMARY KEY(account_id,group_id,generation),
          FOREIGN KEY(account_id,group_id,generation) REFERENCES resources(account_id,group_id,generation) ON DELETE CASCADE);
        CREATE TABLE IF NOT EXISTS operations(
          account_id TEXT NOT NULL, request_id TEXT NOT NULL, content_hash TEXT NOT NULL, json TEXT NOT NULL,
          PRIMARY KEY(account_id,request_id));
        CREATE TABLE IF NOT EXISTS runs(
          run_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, group_id TEXT NOT NULL, event_id TEXT NOT NULL, snapshot_json TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS runs_account_group ON runs(account_id,group_id);
        CREATE TABLE IF NOT EXISTS run_events(
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, account_id TEXT NOT NULL, group_id TEXT NOT NULL,
          at INTEGER NOT NULL, json TEXT NOT NULL, FOREIGN KEY(run_id) REFERENCES runs(run_id));
        CREATE INDEX IF NOT EXISTS run_events_account_group ON run_events(account_id,group_id,sequence);
        CREATE INDEX IF NOT EXISTS run_events_run ON run_events(run_id,sequence);
      `)
      this.db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES('schemaVersion','1')").run()
      if (this.db.prepare("SELECT value FROM metadata WHERE key='schemaVersion'").get()?.value !== '1') throw new EffectGroupError('EFFECT_GROUP_SCHEMA', 'Unsupported effect groups database schema')
      this.db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES('installId',?)").run(randomUUID())
      this.installId = String(this.db.prepare("SELECT value FROM metadata WHERE key='installId'").get()!.value)
    } catch (error) { this.db.close(); throw error }
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = work(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  get(accountId: string): EffectGroupsConfig {
    effectGroupString(accountId, 'accountId')
    return parse<EffectGroupsConfig>(this.db.prepare('SELECT json FROM configs WHERE account_id=?').get(accountId))
      ?? normalizeEffectGroupsConfig({}, accountId)
  }
  accounts(): string[] { return this.db.prepare('SELECT account_id FROM configs ORDER BY account_id').all().map(row => String(row.account_id)) }

  getSavedRequest(accountId: string, requestId: string, config: EffectGroupsConfig, expectedRevision?: number): EffectGroupsConfig | undefined {
    effectGroupString(accountId, 'accountId'); effectGroupString(requestId, 'requestId')
    const desired = normalizeEffectGroupsConfig(config, accountId)
    const prior = this.db.prepare('SELECT content_hash,base_revision,response_json FROM requests WHERE account_id=? AND request_id=?').get(accountId, requestId)
    if (!prior) return undefined
    if (expectedRevision !== undefined) effectGroupInteger(expectedRevision, 'expectedRevision')
    if (prior.content_hash !== digest(configContent(desired)) || (expectedRevision !== undefined && prior.base_revision !== expectedRevision)) throw new EffectGroupError('IDEMPOTENCY_CONFLICT', 'requestId content or revision differs from the original request')
    return parse<EffectGroupsConfig>(prior, 'response_json')
  }

  save(accountId: string, expectedRevision: number, input: EffectGroupsConfig, requestId: string, proof?: EffectGroupSaveProof): EffectGroupsConfig {
    effectGroupString(accountId, 'accountId'); effectGroupString(requestId, 'requestId')
    effectGroupInteger(expectedRevision, 'expectedRevision')
    const desired = normalizeEffectGroupsConfig(input, accountId)
    const contentHash = digest(configContent(desired))
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT * FROM requests WHERE account_id=? AND request_id=?').get(accountId, requestId)
      if (prior) {
        if (prior.content_hash !== contentHash || prior.base_revision !== expectedRevision) throw new EffectGroupError('IDEMPOTENCY_CONFLICT', 'requestId content differs from the original request')
        return parse<EffectGroupsConfig>(prior, 'response_json')!
      }
      const current = this.get(accountId)
      if (current.revision !== expectedRevision) throw new EffectGroupError('REVISION_CONFLICT', 'Effect groups revision changed')
      if (desired.revision !== expectedRevision) throw new EffectGroupError('REVISION_CONFLICT', 'Desired config revision differs from expectedRevision')
      if (proof) this.consumeProofInside(accountId, proof.token, proof.binding, proof.now ?? Date.now())
      const saved = { ...desired, revision: expectedRevision + 1 }
      this.db.prepare('INSERT INTO configs(account_id,revision,json) VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET revision=excluded.revision,json=excluded.json').run(accountId, saved.revision, JSON.stringify(saved))
      this.db.prepare('UPDATE groups SET desired_active=0 WHERE account_id=?').run(accountId)
      for (const group of saved.groups) {
        this.db.prepare('INSERT INTO groups(account_id,group_id,audience_rule_id,action_kind,desired_active,json) VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,group_id) DO UPDATE SET desired_active=excluded.desired_active,json=excluded.json')
          .run(accountId, group.groupId, group.audienceRuleId, group.actionKind, saved.enabled && group.enabled ? 1 : 0, JSON.stringify(group))
      }
      const desiredIds = new Set(saved.groups.filter(group => saved.enabled && group.enabled).map(group => group.groupId))
      for (const resource of this.listResources(accountId)) {
        if (!desiredIds.has(resource.groupId)) {
          const retiring = { ...resource, state: 'retiring' as const }
          this.putResource(retiring)
          const retirement: EffectGroupRetirement = { accountId, groupId: resource.groupId, generation: resource.generation, at: Date.now(), reason: 'CONFIG_REMOVED_OR_DISABLED' }
          this.db.prepare('INSERT OR IGNORE INTO retirements(account_id,group_id,generation,json) VALUES(?,?,?,?)').run(accountId, resource.groupId, resource.generation, JSON.stringify(retirement))
        }
      }
      this.db.prepare('INSERT INTO requests(account_id,request_id,content_hash,base_revision,response_json) VALUES(?,?,?,?,?)').run(accountId, requestId, contentHash, expectedRevision, JSON.stringify(saved))
      return saved
    })
  }

  saveProof(input: EffectGroupProof): EffectGroupProof {
    const proof = this.validateProof(input)
    const bindingHash = digest(this.binding(proof))
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT json FROM proofs WHERE token=?').get(proof.token)
      if (prior) {
        if (canonicalEffectGroupJson(parse(prior)) !== canonicalEffectGroupJson(proof)) throw new EffectGroupError('PROOF_CONFLICT', 'Proof token content changed')
        return parse<EffectGroupProof>(prior)!
      }
      this.db.prepare('INSERT INTO proofs(token,account_id,expires_at,binding_hash,json) VALUES(?,?,?,?,?)').run(proof.token, proof.accountId, proof.expiresAt, bindingHash, JSON.stringify(proof))
      return proof
    })
  }
  private binding(input: EffectGroupProofBinding): EffectGroupProofBinding {
    effectGroupObject(input, ['configHash', 'expectedRevision', 'audienceRevision', 'catalogRevision', 'targetSceneName', 'token', 'accountId', 'expiresAt'], 'proof')
    return { configHash: effectGroupString(input.configHash, 'configHash', 256), expectedRevision: effectGroupInteger(input.expectedRevision, 'expectedRevision'),
      audienceRevision: effectGroupInteger(input.audienceRevision, 'audienceRevision'), catalogRevision: effectGroupString(input.catalogRevision, 'catalogRevision', 256),
      targetSceneName: effectGroupString(input.targetSceneName, 'targetSceneName', 256, true) }
  }
  private validateProof(input: EffectGroupProof): EffectGroupProof {
    return { ...this.binding(input), token: effectGroupString(input.token, 'proof token'),
      accountId: effectGroupString(input.accountId, 'accountId'), expiresAt: effectGroupInteger(input.expiresAt, 'expiresAt') }
  }
  private consumeProofInside(accountId: string, token: string, binding: EffectGroupProofBinding, now: number): EffectGroupProof {
    effectGroupString(accountId, 'accountId'); effectGroupString(token, 'proof token'); effectGroupInteger(now, 'now')
    const validated = this.binding(binding)
    const prior = this.db.prepare('SELECT * FROM proofs WHERE token=? AND account_id=?').get(token, accountId)
    if (!prior || prior.consumed_at !== null || Number(prior.expires_at) <= now || prior.binding_hash !== digest(validated)
      || this.get(accountId).revision !== validated.expectedRevision) throw new EffectGroupError('INVALID_PROOF', 'Proof is expired, consumed or does not match current revisions')
    this.db.prepare('UPDATE proofs SET consumed_at=? WHERE token=?').run(now, token)
    return parse<EffectGroupProof>(prior)!
  }
  consumeProof(accountId: string, token: string, binding: EffectGroupProofBinding, now = Date.now()): EffectGroupProof {
    return this.transaction(() => this.consumeProofInside(accountId, token, binding, now))
  }

  listResources(accountId?: string, groupId?: string): EffectGroupResource[] {
    if (accountId !== undefined) effectGroupString(accountId, 'accountId')
    if (groupId !== undefined) effectGroupString(groupId, 'groupId')
    const rows = this.db.prepare('SELECT json FROM resources WHERE (? IS NULL OR account_id=?) AND (? IS NULL OR group_id=?) ORDER BY account_id,group_id,generation').all(accountId ?? null, accountId ?? null, groupId ?? null, groupId ?? null)
    return rows.map(row => parse<EffectGroupResource>(row)!)
  }
  private validateResource(input: EffectGroupResource): EffectGroupResource {
    effectGroupObject(input, RESOURCE_FIELDS, 'resource')
    for (const field of ['accountId', 'groupId', 'installId', 'sceneName', 'parentSceneName', 'captionInputName', 'configHash', 'label'] as const) effectGroupString(input[field], field, 256)
    effectGroupInteger(input.generation, 'generation', 1)
    if (input.installId !== this.installId) throw new EffectGroupError('RESOURCE_OWNERSHIP', 'Resource belongs to another install owner')
    if (!['ready', 'pending', 'conflict', 'retiring', 'failed'].includes(input.state)) throw new EffectGroupError('INVALID_EFFECT_GROUP', 'Invalid resource state')
    if (!Array.isArray(input.animationInputs) || input.animationInputs.length > 3 || !Array.isArray(input.ownedIdentities) || input.ownedIdentities.length > 32) throw new EffectGroupError('INVALID_EFFECT_GROUP', 'Resource members exceed bound')
    for (const animation of input.animationInputs) {
      effectGroupObject(animation, ['assetId', 'inputName', 'inputUuid', 'kind', 'settingsHash', 'intentId', 'created'], 'animationInput')
      effectGroupString(animation.assetId, 'assetId'); effectGroupString(animation.inputName, 'inputName', 256)
      if (!['html', 'obs-media'].includes(animation.kind)) throw new EffectGroupError('INVALID_EFFECT_GROUP', 'Invalid input kind')
      if (animation.inputUuid !== undefined) effectGroupString(animation.inputUuid, 'inputUuid')
    }
    for (const owned of input.ownedIdentities) {
      effectGroupObject(owned, ['kind', 'name', 'uuid', 'parentUuid', 'itemId', 'settingsHash', 'intentId', 'markerKey', 'created', 'removed', 'transformHash'], 'ownedIdentity')
      if (!['scene', 'input', 'scene-item', 'filter'].includes(owned.kind)) throw new EffectGroupError('INVALID_EFFECT_GROUP', 'Invalid owned identity kind')
      for (const key of ['name', 'uuid', 'parentUuid', 'settingsHash', 'intentId', 'markerKey', 'transformHash'] as const) if (owned[key] !== undefined) effectGroupString(owned[key], key, 256)
      if (owned.itemId !== undefined) effectGroupInteger(owned.itemId, 'itemId')
      if (owned.created !== undefined && typeof owned.created !== 'boolean') throw new EffectGroupError('INVALID_EFFECT_GROUP', 'created must be boolean')
      if (owned.removed !== undefined && typeof owned.removed !== 'boolean') throw new EffectGroupError('INVALID_EFFECT_GROUP', 'removed must be boolean')
    }
    for (const key of ['sceneUuid', 'parentSceneUuid', 'captionInputUuid', 'creationNonce', 'captionSettingsHash', 'sourceRevision', 'error', 'cleanupToken'] as const) if (input[key] !== undefined) effectGroupString(input[key], key, key === 'error' ? 1024 : 256)
    if (input.parentItemId !== undefined) effectGroupInteger(input.parentItemId, 'parentItemId')
    if (input.state === 'ready' && (!input.sceneUuid || !input.parentSceneUuid || input.parentItemId === undefined || !input.captionInputUuid || !input.animationInputs.length || input.animationInputs.some(item => !item.inputUuid))) throw new EffectGroupError('RESOURCE_OWNERSHIP', 'Ready resource requires acknowledged UUID identities')
    const json = boundedJson(input)
    return JSON.parse(json) as EffectGroupResource
  }
  private putResource(resource: EffectGroupResource): void {
    this.db.prepare('INSERT INTO resources(account_id,group_id,generation,install_id,state,json) VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,group_id,generation) DO UPDATE SET state=excluded.state,json=excluded.json').run(resource.accountId, resource.groupId, resource.generation, resource.installId, resource.state, JSON.stringify(resource))
  }
  saveResource(input: EffectGroupResource): EffectGroupResource {
    const resource = this.validateResource(input)
    return this.transaction(() => {
      const previous = parse<EffectGroupResource>(this.db.prepare('SELECT json FROM resources WHERE account_id=? AND group_id=? AND generation=?').get(resource.accountId, resource.groupId, resource.generation))
      if (!previous && resource.generation < this.nextGeneration(resource.accountId, resource.groupId)) throw new EffectGroupError('STALE_GENERATION', 'A removed resource generation cannot be reused')
      if (previous) {
        for (const key of ['sceneUuid', 'parentSceneUuid', 'parentItemId', 'captionInputUuid'] as const) if (previous[key] !== undefined && previous[key] !== resource[key]) throw new EffectGroupError('RESOURCE_OWNERSHIP', `Owned ${key} cannot change within a generation`)
        for (const old of previous.animationInputs) if (old.inputUuid && !resource.animationInputs.some(item => item.inputUuid === old.inputUuid && item.inputName === old.inputName)) throw new EffectGroupError('RESOURCE_OWNERSHIP', 'Owned input identity cannot be replaced')
        const retirement = this.db.prepare('SELECT 1 FROM retirements WHERE account_id=? AND group_id=? AND generation=?').get(resource.accountId, resource.groupId, resource.generation)
        if (retirement && resource.state === 'ready') throw new EffectGroupError('RESOURCE_RETIRING', 'A retiring generation cannot become ready again')
      }
      this.putResource(resource)
      this.db.prepare('INSERT INTO generations(account_id,group_id,highwater) VALUES(?,?,?) ON CONFLICT(account_id,group_id) DO UPDATE SET highwater=MAX(highwater,excluded.highwater)').run(resource.accountId, resource.groupId, resource.generation)
      if (resource.state === 'retiring') {
        const retirement: EffectGroupRetirement = { accountId: resource.accountId, groupId: resource.groupId, generation: resource.generation, at: Date.now(), reason: 'RESOURCE_RETIRING' }
        this.db.prepare('INSERT OR IGNORE INTO retirements(account_id,group_id,generation,json) VALUES(?,?,?,?)').run(resource.accountId, resource.groupId, resource.generation, JSON.stringify(retirement))
      }
      return resource
    })
  }
  nextGeneration(accountId: string, groupId: string): number {
    effectGroupString(accountId, 'accountId'); effectGroupString(groupId, 'groupId')
    const row = this.db.prepare('SELECT highwater FROM generations WHERE account_id=? AND group_id=?').get(accountId, groupId)
    return Number(row?.highwater ?? 0) + 1
  }
  removeResource(accountId: string, groupId: string, generation: number): boolean {
    effectGroupString(accountId, 'accountId'); effectGroupString(groupId, 'groupId'); effectGroupInteger(generation, 'generation', 1)
    return Number(this.db.prepare('DELETE FROM resources WHERE account_id=? AND group_id=? AND generation=? AND install_id=?').run(accountId, groupId, generation, this.installId).changes) > 0
  }
  listRetirements(accountId?: string): EffectGroupRetirement[] {
    if (accountId !== undefined) effectGroupString(accountId, 'accountId')
    return this.db.prepare('SELECT json FROM retirements WHERE (? IS NULL OR account_id=?) ORDER BY account_id,group_id,generation').all(accountId ?? null, accountId ?? null).map(row => parse<EffectGroupRetirement>(row)!)
  }

  saveOperation(input: EffectGroupOperation): EffectGroupOperation {
    effectGroupObject(input, ['accountId', 'requestId', 'kind', 'contentHash', 'state', 'detail', 'response'], 'operation')
    effectGroupString(input.accountId, 'accountId'); effectGroupString(input.requestId, 'requestId'); effectGroupString(input.contentHash, 'contentHash', 256)
    if (!['apply', 'sync', 'preview', 'retire'].includes(input.kind) || !['pending', 'completed', 'failed'].includes(input.state)) throw new EffectGroupError('INVALID_EFFECT_GROUP', 'Unsupported operation kind/state')
    const copy = JSON.parse(boundedJson(input)) as EffectGroupOperation
    return this.transaction(() => {
      const previous = this.getOperation(input.accountId, input.requestId)
      if (previous && (previous.contentHash !== input.contentHash || previous.kind !== input.kind)) throw new EffectGroupError('IDEMPOTENCY_CONFLICT', 'Operation requestId content differs')
      if (previous?.state === 'completed') return previous
      this.db.prepare('INSERT INTO operations(account_id,request_id,content_hash,json) VALUES(?,?,?,?) ON CONFLICT(account_id,request_id) DO UPDATE SET json=excluded.json').run(copy.accountId, copy.requestId, copy.contentHash, JSON.stringify(copy))
      return copy
    })
  }
  getOperation(accountId: string, requestId: string): EffectGroupOperation | undefined {
    effectGroupString(accountId, 'accountId'); effectGroupString(requestId, 'requestId')
    return parse<EffectGroupOperation>(this.db.prepare('SELECT json FROM operations WHERE account_id=? AND request_id=?').get(accountId, requestId))
  }

  appendRunEvent(input: EffectGroupRunEvent): EffectGroupRunEvent {
    effectGroupObject(input, ['runId', 'accountId', 'groupId', 'eventId', 'at', 'status', 'reason', 'detail'], 'runEvent')
    for (const key of ['runId', 'accountId', 'groupId', 'eventId'] as const) effectGroupString(input[key], key)
    effectGroupInteger(input.at, 'at')
    if (!['queued', 'preparing', 'started', 'completed', 'failed', 'skipped', 'interrupted'].includes(input.status)) throw new EffectGroupError('INVALID_EFFECT_GROUP', 'Invalid run status')
    if (input.reason !== undefined) effectGroupString(input.reason, 'reason', 256)
    const json = boundedJson(input), copy = JSON.parse(json) as EffectGroupRunEvent
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT account_id,group_id,event_id FROM runs WHERE run_id=?').get(copy.runId)
      if (previous && (previous.account_id !== copy.accountId || previous.group_id !== copy.groupId || previous.event_id !== copy.eventId)) throw new EffectGroupError('RUN_IDENTITY_CONFLICT', 'Run identity cannot overwrite an original event')
      this.db.prepare('INSERT OR IGNORE INTO runs(run_id,account_id,group_id,event_id,snapshot_json) VALUES(?,?,?,?,?)').run(copy.runId, copy.accountId, copy.groupId, copy.eventId, json)
      this.db.prepare('INSERT INTO run_events(run_id,account_id,group_id,at,json) VALUES(?,?,?,?,?)').run(copy.runId, copy.accountId, copy.groupId, copy.at, json)
      return copy
    })
  }
  /** Hot event admission checks one indexed identity without sorting account history. */
  hasRunEvent(accountId: string, runId: string): boolean {
    effectGroupString(accountId, 'accountId'); effectGroupString(runId, 'runId')
    return this.db.prepare('SELECT 1 FROM run_events WHERE account_id=? AND run_id=? LIMIT 1').get(accountId, runId) !== undefined
  }
  listRunEvents(accountId: string, options: { groupId?: string; runId?: string; limit?: number; afterSequence?: number } = {}): EffectGroupRunEvent[] {
    effectGroupString(accountId, 'accountId')
    effectGroupObject(options, ['groupId', 'runId', 'limit', 'afterSequence'], 'run filter')
    if (options.groupId !== undefined) effectGroupString(options.groupId, 'groupId')
    if (options.runId !== undefined) effectGroupString(options.runId, 'runId')
    const limit = effectGroupInteger(options.limit ?? 1000, 'limit', 1, 1000), after = effectGroupInteger(options.afterSequence ?? 0, 'afterSequence')
    return this.db.prepare('SELECT json FROM run_events WHERE account_id=? AND sequence>? AND (? IS NULL OR group_id=?) AND (? IS NULL OR run_id=?) ORDER BY sequence LIMIT ?').all(accountId, after, options.groupId ?? null, options.groupId ?? null, options.runId ?? null, options.runId ?? null, limit).map(row => parse<EffectGroupRunEvent>(row)!)
  }
  /** Restart reconciliation must inspect each run's final receipt, never a truncated audit prefix. */
  listUnfinishedRuns(accountId?: string): EffectGroupRunEvent[] {
    if (accountId !== undefined) effectGroupString(accountId, 'accountId')
    return this.db.prepare(`
      SELECT event.json FROM run_events AS event
      JOIN (SELECT run_id, MAX(sequence) AS latest_sequence FROM run_events
        WHERE (? IS NULL OR account_id=?) GROUP BY run_id) AS latest
        ON event.sequence=latest.latest_sequence
      WHERE json_extract(event.json,'$.status') IN ('queued','preparing','started')
      ORDER BY event.sequence
    `).all(accountId ?? null, accountId ?? null).map(row => parse<EffectGroupRunEvent>(row)!)
  }
  /** Recent UI history in recorded order; the forward audit reader remains unchanged. */
  listLatestRunEvents(accountId: string, options: { groupId?: string; runId?: string; limit?: number } = {}): EffectGroupRunEvent[] {
    effectGroupString(accountId, 'accountId')
    effectGroupObject(options, ['groupId', 'runId', 'limit'], 'latest run filter')
    if (options.groupId !== undefined) effectGroupString(options.groupId, 'groupId')
    if (options.runId !== undefined) effectGroupString(options.runId, 'runId')
    const limit = effectGroupInteger(options.limit ?? 100, 'limit', 1, 1000)
    return this.db.prepare('SELECT json FROM run_events WHERE account_id=? AND (? IS NULL OR group_id=?) AND (? IS NULL OR run_id=?) ORDER BY sequence DESC LIMIT ?')
      .all(accountId, options.groupId ?? null, options.groupId ?? null, options.runId ?? null, options.runId ?? null, limit)
      .reverse().map(row => parse<EffectGroupRunEvent>(row)!)
  }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true } }
}

function boundedJson(value: unknown): string {
  let nodes = 0
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 2000 || depth > 12) throw new EffectGroupError('INVALID_EFFECT_GROUP', 'Stored detail exceeds depth or node bound')
    if (item === null || item === undefined || typeof item === 'boolean') return
    if (typeof item === 'number') { if (!Number.isFinite(item)) throw new EffectGroupError('INVALID_EFFECT_GROUP', 'Stored number is not finite'); return }
    if (typeof item === 'string') { if (item.length > 8192) throw new EffectGroupError('INVALID_EFFECT_GROUP', 'Stored string exceeds bound'); return }
    if (Array.isArray(item)) { for (const child of item) visit(child, depth + 1); return }
    if (!item || typeof item !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new EffectGroupError('INVALID_EFFECT_GROUP', 'Stored value is not JSON data')
    for (const [key, child] of Object.entries(item)) {
      if (/password|cookie|authorization|api.?key|access.?token|secret/i.test(key)) throw new EffectGroupError('INVALID_EFFECT_GROUP', 'Secret-bearing audit field is not allowed')
      visit(child, depth + 1)
    }
  }
  visit(value, 0)
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json) > 64 * 1024) throw new EffectGroupError('INVALID_EFFECT_GROUP', 'Stored record exceeds byte bound')
  return json
}
