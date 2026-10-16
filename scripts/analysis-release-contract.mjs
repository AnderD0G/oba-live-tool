import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, lstat, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export const mcpFiles = [
  'scripts/mcp-director-server.mjs',
  'scripts/oba-user-data-candidates.mjs',
  'scripts/oba-director-mcp.cmd',
  'scripts/tk-capture-api.mjs',
  'scripts/tk-attach-existing-chrome.mjs',
  'shared/analysisRoomContract.mjs',
  'shared/assistantDeskContract.mjs',
  'shared/effectGroupsContract.mjs',
]
export const productFiles = [
  'app/resources/app.asar',
  'app/OBA-Codex.exe',
  'automation/node.exe',
  ...mcpFiles.map(file => `automation/${file}`),
]
export async function verifyProductFiles(manifest, product) {
  for (const name of productFiles) {
    if(name==='automation/shared/assistantDeskContract.mjs'&&manifest.apiContractVersion!==2&&!manifest.fileHashes?.[name])continue
    if(name==='automation/shared/effectGroupsContract.mjs'&&manifest.effectGroupContractVersion!==1&&!manifest.fileHashes?.[name])continue
    if(name==='automation/scripts/tk-attach-existing-chrome.mjs'&&manifest.browserAttachVersion!==1&&!manifest.fileHashes?.[name])continue
    if(name==='automation/scripts/oba-user-data-candidates.mjs'&&manifest.mcpDiscoveryVersion!==1&&!manifest.fileHashes?.[name])continue
    assert.match(manifest.fileHashes?.[name] ?? '', /^[a-f0-9]{64}$/, 'PRODUCT_HASH_REQUIRED')
    assert.equal(
      await fileHash(path.join(product, name)),
      manifest.fileHashes[name],
      'PRODUCT_CHANGED_AFTER_QA',
    )
  }
  return true
}
export async function fileHash(file) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(file)) digest.update(chunk)
  return digest.digest('hex')
}
export async function copyReleaseTree(source, target) {
  try {
    await lstat(target)
    throw new Error('DESTINATION_EXISTS')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await cp(source, target, { recursive: true, force: false, errorOnExist: true })
}
export function parseSuite(log) {
  const count = name => {
    const match = log.match(new RegExp(`(?:ℹ |# )${name} (\\d+)`))
    assert.ok(match, 'SUITE_COUNTS_MISSING')
    return Number(match[1])
  }
  const skipNames = log.split(/\r?\n/).filter(line => /^\s*﹣ /.test(line))
  const skipped = count('skipped')
  assert.equal(skipNames.length, skipped, 'SUITE_SKIP_NAMES_MISSING')
  return {
    pass: count('pass'),
    fail: count('fail'),
    cancelled: count('cancelled'),
    skipped,
    skipNames,
  }
}
export async function sourceDigest(root) {
  const files = []
  const walk = async directory => {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const name = `${directory}/${entry.name}`
      if (entry.isSymbolicLink()) throw new Error('SOURCE_LINK_REJECTED')
      if (entry.isDirectory()) await walk(name)
      else if (entry.isFile()) files.push(name)
    }
  }
  for (const directory of ['src', 'electron', 'shared', 'public']) await walk(directory)
  for (const name of [
    ...mcpFiles.filter(file => file.startsWith('scripts/')),
    'scripts/analysis-room-console.mjs',
    'scripts/deepseek-interaction-console.mjs',
    'scripts/build-analysis-room.mjs',
    'scripts/build-analysis-room.ps1',
    'scripts/build-analysis-capture-worker.mjs',
    'scripts/analysis-release-contract.mjs',
    'package.json',
    'pnpm-lock.yaml',
    'electron-builder.json',
    'vite.config.ts',
  ]) {
    try {
      const info = await lstat(path.join(root, name))
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('SOURCE_LINK_REJECTED')
      files.push(name)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  const digest = createHash('sha256')
  for (const name of files.sort()) {
    digest
      .update(name)
      .update('\0')
      .update(await readFile(path.join(root, name)))
      .update('\0')
  }
  return digest.digest('hex')
}
export async function compiledDigest(root) {
  const files = []
  const walk = async directory => {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const name = `${directory}/${entry.name}`
      if (entry.isSymbolicLink()) throw new Error('BUNDLE_LINK_REJECTED')
      if (entry.isDirectory()) await walk(name)
      else if (entry.isFile()) files.push(name)
    }
  }
  for (const directory of ['dist', 'dist-electron']) {
    const count = files.length
    await walk(directory)
    assert.ok(files.length > count, 'BUNDLE_INPUTS_EMPTY')
  }
  const digest = createHash('sha256')
  for (const name of files.sort())
    digest
      .update(name)
      .update('\0')
      .update(await fileHash(path.join(root, name)))
      .update('\0')
  return digest.digest('hex')
}
export async function verifyCompiledInputs(evidence, root) {
  assert.match(evidence.bundleDigest ?? '', /^[a-f0-9]{64}$/, 'BUNDLE_EVIDENCE_REQUIRED')
  assert.equal(
    await compiledDigest(root),
    evidence.bundleDigest,
    'BUNDLE_CHANGED_AFTER_VERIFICATION',
  )
  return true
}
export function verifyReleaseEvidence(evidence, currentDigest) {
  assert.equal(evidence?.sourceDigest, currentDigest, 'SOURCE_EVIDENCE_STALE')
  assert.equal(evidence.typecheck, true, 'TYPECHECK_UNVERIFIED')
  assert.ok(
    Number.isSafeInteger(evidence.suite?.pass) && evidence.suite.pass > 0,
    'SUITE_UNVERIFIED',
  )
  assert.equal(evidence.suite.fail, 0, 'SUITE_FAILED')
  assert.equal(evidence.suite.cancelled, 0, 'SUITE_CANCELLED')
  for (const key of ['ui', 'e2e', 'load']) {
    assert.equal(evidence[key]?.passed, true, `${key.toUpperCase()}_UNVERIFIED`)
    assert.equal(evidence[key].sourceDigest, currentDigest, 'SOURCE_EVIDENCE_STALE')
  }
  assert.equal(evidence.load.rate, 100)
  assert.equal(evidence.load.durationSeconds, 600)
  assert.equal(evidence.load.received, 60000)
  assert.equal(evidence.load.saved, 60000)
  assert.equal(evidence.load.dropped, 0)
  assert.equal(evidence.load.pending, 0)
  assert.equal(evidence.load.bytesAgree, true)
  return true
}
export function verifyArtifactResult(result, version) {
  assert.equal(result?.version, version, 'ARTIFACT_VERSION_MISMATCH')
  for (const key of ['route', 'api', 'mcp', 'groupsDisabled', 'noProductionWrites'])
    assert.equal(result[key], true, `ARTIFACT_${key.toUpperCase()}_FAILED`)
  return true
}
