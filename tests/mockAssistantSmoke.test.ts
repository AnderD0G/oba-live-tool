import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { buildSmokeBatch, scanFormalStorage } from '../scripts/smoke-mock-assistant.mjs'

test('packaged Mock smoke batch covers synthetic countries, unknown facts and every event kind', () => {
  const metadata = {
    accountId: 'default',
    metadataRevision: 'a'.repeat(64),
    catalog: { countries: [{ code: 'TH' }, { code: 'JP' }] },
  }
  const batch = buildSmokeBatch(metadata, 'SMOKE_MARKER')
  assert.equal(batch.accountId, 'default')
  assert.equal(batch.metadataRevision, metadata.metadataRevision)
  assert.deepEqual(
    new Set(batch.events.map(event => event.kind)),
    new Set(['comment', 'enter', 'leave', 'follow', 'like', 'gift', 'event']),
  )
  assert.ok(batch.users.some(user => user.payLevel === 25 && user.manualCountry === 'TH'))
  assert.ok(
    batch.users.some(user => user.payLevel === undefined && user.manualCountry === undefined),
  )
  assert.ok(batch.events.some(event => event.text?.includes('SMOKE_MARKER')))
  assert.equal(
    batch.events.every(event => batch.users.some(user => user.id === event.userId)),
    true,
  )
  assert.equal('token' in batch, false)
})

test('formal-storage scan checks canonical SQLite values as well as JSON journals without exposing values', async t => {
  const profile = await mkdtemp(join(tmpdir(), 'oba-mock-smoke-unit-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  await mkdir(join(profile, 'assistant-desk', 'database'), { recursive: true })
  const path = join(profile, 'assistant-desk', 'database', 'assistant-desk.sqlite')
  const database = new DatabaseSync(path)
  database.exec('CREATE TABLE facts(payload TEXT)')
  database.prepare('INSERT INTO facts VALUES(?)').run('safe real configuration')
  database.close()
  assert.equal((await scanFormalStorage(profile, ['unique-marker'])).sqliteFiles, 1)
  await writeFile(join(profile, 'assistant-desk', 'journal.jsonl'), '{"text":"unique-marker"}\n')
  await assert.rejects(
    scanFormalStorage(profile, ['unique-marker']),
    error =>
      error instanceof Error &&
      error.message.includes('formal storage') &&
      !error.message.includes('unique-marker'),
  )
  await rm(join(profile, 'assistant-desk', 'journal.jsonl'))
  const reopened = new DatabaseSync(path)
  reopened.prepare('INSERT INTO facts VALUES(?)').run('prefix unique-marker suffix')
  reopened.close()
  await assert.rejects(scanFormalStorage(profile, ['unique-marker']), /formal storage/)
})
