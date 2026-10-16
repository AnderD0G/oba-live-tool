import { existsSync, lstatSync, mkdirSync, openSync, closeSync, fstatSync, readSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { types } from 'node:util';
import { defaultInteractionRoutingConfig, validateInteractionRoutingConfig, type InteractionRoutingConfig } from '../../../shared/interactionRouting';
import { validateAudienceGroups } from './analysisRoom/AudienceGroupEvaluator';
export type InteractionRoutingSaved = {
    revision: number;
    config: InteractionRoutingConfig;
};
const MAX_BYTES = 4 * 1024 * 1024, MAX_ACCOUNTS = 1000;
const SCHEMA = `CREATE TABLE interaction_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL CHECK(version=1),seed_status TEXT NOT NULL CHECK(seed_status IN('absent','imported','ignored-invalid','ignored-oversize')),seeded_accounts INTEGER NOT NULL CHECK(seeded_accounts BETWEEN 0 AND 1000)) STRICT;
CREATE TABLE interaction_configs(account_key TEXT PRIMARY KEY CHECK(json_valid(account_key) AND json_type(account_key)='text'),revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991),config_json BLOB NOT NULL CHECK(length(config_json) BETWEEN 1 AND 4194304)) STRICT;`;
const definitions = SCHEMA.split(';').filter(s => s.trim()).map(s => s.trim().replace(/\s+/g, ' '));
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function accountKey(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value.length > 200 || ['__proto__', 'constructor', 'prototype'].includes(value))
    fail('INTERACTION_ACCOUNT_INVALID'); return JSON.stringify(value); }
function revision(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    fail('INTERACTION_REVISION_INVALID'); return value; }
/** Validated JSON representation preserves UTF16 scalars and negative zero. */
function json(value: any): string { if (value === null || typeof value !== 'object')
    return Object.is(value, -0) ? '-0' : JSON.stringify(value); if (Array.isArray(value))
    return '[' + value.map(json).join(',') + ']'; return '{' + Object.keys(value).filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + json(value[k])).join(',') + '}'; }
function checkedConfig(input: unknown): {
    config: InteractionRoutingConfig;
    bytes: Buffer;
} { const stack = [{ value: input, depth: 0 }], seen = new Set<object>(); let nodes = 0, bytes = 0; while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (++nodes > 100000 || depth > 16)
        fail('INTERACTION_CONFIG_INVALID');
    if (value === undefined)
        continue;
    if (value === null || typeof value === 'boolean') {
        bytes += 5;
        continue;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            fail('INTERACTION_CONFIG_INVALID');
        bytes += 24;
        continue;
    }
    if (typeof value === 'string') {
        bytes += value.length * 3 + 2;
        if (bytes > MAX_BYTES)
            fail('INTERACTION_CONFIG_INVALID');
        continue;
    }
    if (!value || typeof value !== 'object' || types.isProxy(value) || seen.has(value) || ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(value)))
        fail('INTERACTION_CONFIG_INVALID');
    seen.add(value);
    if (Array.isArray(value) && value.length > 100000)
        fail('INTERACTION_CONFIG_INVALID');
    const keys = Reflect.ownKeys(value);
    if (nodes + stack.length + keys.length > 100000 || (Array.isArray(value) && keys.length !== value.length + 1))
        fail('INTERACTION_CONFIG_INVALID');
    for (const key of keys) {
        if (Array.isArray(value) && key === 'length')
            continue;
        const d = Object.getOwnPropertyDescriptor(value, key)!;
        if (typeof key !== 'string' || !d.enumerable || !('value' in d))
            fail('INTERACTION_CONFIG_INVALID');
        if (Array.isArray(value) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length || d.value === undefined))
            fail('INTERACTION_CONFIG_INVALID');
        bytes += key.length * 3 + 4;
        stack.push({ value: d.value, depth: depth + 1 });
    }
    if (bytes > MAX_BYTES)
        fail('INTERACTION_CONFIG_INVALID');
} const config = structuredClone(input) as InteractionRoutingConfig; try {
    validateInteractionRoutingConfig(config);
    if (config.groups !== undefined)
        validateAudienceGroups(config.groups, { allowStale: true });
}
catch {
    fail('INTERACTION_CONFIG_INVALID');
} const encoded = Buffer.from(json(config), 'utf8'); if (encoded.length < 1 || encoded.length > MAX_BYTES)
    fail('INTERACTION_CONFIG_INVALID'); return { config, bytes: encoded }; }
/** Current configuration authority only; never reads history or JSON backups. */
export class InteractionRoutingDatabase {
    private db: DatabaseSync;
    private closed = false;
    private directory: string;
    private directoryIdentity: {
        dev: number;
        ino: number;
    };
    private fileIdentity: {
        dev: number;
        ino: number;
    };
    readonly file: string;
    constructor(file: string) { this.file = resolve(file); this.directory = dirname(this.file); mkdirSync(this.directory, { recursive: true }); const parent = lstatSync(this.directory); if (!parent.isDirectory() || parent.isSymbolicLink())
        fail('INTERACTION_STORAGE_UNSAFE'); this.directoryIdentity = { dev: parent.dev, ino: parent.ino }; this.directory = realpathSync(this.directory); const existed = existsSync(this.file); if (existed) {
        const stat = lstatSync(this.file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size === 0)
            fail('INTERACTION_STORAGE_UNSAFE');
    } this.db = new DatabaseSync(this.file); const stat = lstatSync(this.file); this.fileIdentity = { dev: stat.dev, ino: stat.ino }; try {
        if (existed)
            this.checkSchema();
        else {
            if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' LIMIT 1").get())
                fail('INTERACTION_SCHEMA_INVALID');
            this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000');
            const seed = this.currentSeed();
            this.db.exec('BEGIN IMMEDIATE');
            try {
                this.db.exec(SCHEMA);
                for (const [key, saved] of seed.rows) {
                    this.db.prepare('INSERT INTO interaction_configs(account_key,revision,config_json) VALUES(?,?,?)').run(key, saved.revision, checkedConfig(saved.config).bytes);
                }
                this.db.prepare('INSERT INTO interaction_meta VALUES(1,1,?,?)').run(seed.status, seed.rows.length);
                this.assertOwned();
                this.db.exec('COMMIT');
            }
            catch (e) {
                if (this.db.isTransaction)
                    this.db.exec('ROLLBACK');
                throw e;
            }
        }
        this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000');
        this.checkSchema();
        this.assertOwned();
    }
    catch (e) {
        this.db.close();
        this.closed = true;
        throw e;
    } }
    private assertOwned() { if (this.closed)
        fail('INTERACTION_DATABASE_CLOSED'); const parent = lstatSync(dirname(this.file)); if (!parent.isDirectory() || parent.isSymbolicLink() || parent.dev !== this.directoryIdentity.dev || parent.ino !== this.directoryIdentity.ino || realpathSync(dirname(this.file)) !== this.directory)
        fail('INTERACTION_STORAGE_UNSAFE'); const file = lstatSync(this.file); if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.dev !== this.fileIdentity.dev || file.ino !== this.fileIdentity.ino)
        fail('INTERACTION_STORAGE_UNSAFE'); for (const suffix of ['-wal', '-shm'])
        if (existsSync(this.file + suffix)) {
            const s = lstatSync(this.file + suffix);
            if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1)
                fail('INTERACTION_STORAGE_UNSAFE');
        } }
    private checkSchema() { const rows = this.db.prepare("SELECT substr(sql,1,8193) sql,length(CAST(sql AS BLOB)) n FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name LIMIT 3").all(); if (rows.length !== 2 || rows.some(r => Number(r.n) > 8192) || rows.map(r => String(r.sql).replace(/\s+/g, ' ').trim()).sort().join('\n') !== [...definitions].sort().join('\n'))
        fail('INTERACTION_SCHEMA_INVALID'); const m = this.db.prepare('SELECT * FROM interaction_meta WHERE singleton=1').get(); if (!m || m.version !== 1 || typeof m.seeded_accounts !== 'number' || m.seeded_accounts < 0 || m.seeded_accounts > MAX_ACCOUNTS)
        fail('INTERACTION_SCHEMA_INVALID'); }
    private currentSeed(): {
        status: string;
        rows: [
            string,
            InteractionRoutingSaved
        ][];
    } { const file = join(dirname(this.file), 'interaction-routing.json'); if (!existsSync(file))
        return { status: 'absent', rows: [] }; let fd: number | undefined; try {
        const s = lstatSync(file);
        if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1)
            return { status: 'ignored-invalid', rows: [] };
        if (s.size > MAX_BYTES)
            return { status: 'ignored-oversize', rows: [] };
        fd = openSync(file, 'r');
        const before = fstatSync(fd);
        if (before.dev !== s.dev || before.ino !== s.ino || before.size !== s.size)
            throw Error('changed');
        const buffer = Buffer.alloc(Math.min(MAX_BYTES + 1, s.size + 1));
        let used = 0;
        while (used < buffer.length) {
            const count = readSync(fd, buffer, used, buffer.length - used, null);
            if (!count)
                break;
            used += count;
        }
        if (used !== s.size)
            throw Error('changed');
        const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, used)));
        const after = fstatSync(fd);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || !parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length > MAX_ACCOUNTS)
            throw Error('invalid');
        const rows: [
            string,
            InteractionRoutingSaved
        ][] = [];
        for (const [id, value] of Object.entries(parsed)) {
            const raw = value as InteractionRoutingSaved, key = accountKey(id), rev = revision(raw?.revision), config = checkedConfig(raw?.config).config;
            rows.push([key, { revision: rev, config }]);
        }
        return { status: 'imported', rows };
    }
    catch {
        return { status: 'ignored-invalid', rows: [] };
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    } }
    read(account: string): InteractionRoutingSaved { this.assertOwned(); const row = this.db.prepare('SELECT revision,length(config_json) n FROM interaction_configs WHERE account_key=?').get(accountKey(account)); if (!row)
        return { revision: 0, config: defaultInteractionRoutingConfig() }; if (typeof row.n !== 'number' || row.n < 1 || row.n > MAX_BYTES)
        fail('INTERACTION_CONFIG_INVALID'); const bytes = this.db.prepare('SELECT config_json FROM interaction_configs WHERE account_key=?').get(accountKey(account))?.config_json; if (!(bytes instanceof Uint8Array))
        fail('INTERACTION_CONFIG_INVALID'); let config: unknown; try {
        config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    }
    catch {
        return fail('INTERACTION_CONFIG_INVALID');
    } ; return { revision: revision(row.revision), config: checkedConfig(config).config }; }
    accountIds(): string[] { this.assertOwned(); const rows = this.db.prepare('SELECT account_key FROM interaction_configs ORDER BY account_key LIMIT 1001').all(); if (rows.length > MAX_ACCOUNTS)
        fail('INTERACTION_ACCOUNT_LIMIT'); return rows.map(r => { const value = JSON.parse(String(r.account_key)); accountKey(value); return value as string; }); }
    all(): Record<string, InteractionRoutingSaved> { return Object.fromEntries(this.accountIds().map(account => [account, this.read(account)])); }
    write(account: string, expected: number, input: unknown): InteractionRoutingSaved { const key = accountKey(account), rev = revision(expected); if (rev === Number.MAX_SAFE_INTEGER)
        fail('INTERACTION_REVISION_INVALID'); const next = checkedConfig(input); this.assertOwned(); if (this.db.isTransaction)
        fail('INTERACTION_TRANSACTION_ACTIVE'); let attempted = false; try {
        this.db.exec('BEGIN IMMEDIATE');
        const row = this.db.prepare('SELECT revision FROM interaction_configs WHERE account_key=?').get(key);
        if ((row?.revision ?? 0) !== rev)
            fail('INTERACTION_REVISION_CONFLICT');
        if (!row && Number(this.db.prepare('SELECT COUNT(*) n FROM (SELECT 1 FROM interaction_configs LIMIT 1000)').get()!.n) >= MAX_ACCOUNTS)
            fail('INTERACTION_ACCOUNT_LIMIT');
        this.db.prepare('INSERT INTO interaction_configs(account_key,revision,config_json) VALUES(?,?,?) ON CONFLICT(account_key) DO UPDATE SET revision=excluded.revision,config_json=excluded.config_json WHERE interaction_configs.revision=?').run(key, rev + 1, next.bytes, rev);
        this.assertOwned();
        attempted = true;
        this.db.exec('COMMIT');
        return { revision: rev + 1, config: next.config };
    }
    catch (e) {
        try {
            if (this.db.isTransaction)
                this.db.exec('ROLLBACK');
        }
        catch { }
        if (attempted)
            fail('INTERACTION_COMMIT_UNCERTAIN');
        throw e;
    } }
    reset(account: string, expected: number) { return this.write(account, expected, defaultInteractionRoutingConfig()); }
    close() { if (!this.closed) {
        this.db.close();
        this.closed = true;
    } }
    status() { this.assertOwned(); const row = this.db.prepare('SELECT seed_status,seeded_accounts FROM interaction_meta WHERE singleton=1').get()!; return { seedStatus: String(row.seed_status), seededAccounts: Number(row.seeded_accounts) }; }
}
