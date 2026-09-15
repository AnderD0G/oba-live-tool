import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  codexCandidates,
  compatibleCodex,
  selectCodex,
} from '../electron/main/services/CodexRuntime'

test('rejects obsolete/non-Codex executables and accepts supported stable/desktop builds', () => {
  for (const version of ['node 22.0.0', 'codex-cli 0.80.0', 'unknown', ''])
    assert.equal(compatibleCodex(version), false)
  for (const version of ['codex-cli 0.154.0', 'codex-cli 0.154.0-alpha.6.2', 'codex-cli 1.0.0'])
    assert.equal(compatibleCodex(version), true)
})
test('a clean PC has the fallback as its last candidate, without requiring npm', async () => {
  const bundle = path.resolve('bundled/codex.exe')
  const paths = await codexCandidates({ PATH: '' }, bundle)
  assert.deepEqual(paths, [bundle])
})
test('broken installed executable does not prevent fallback; missing bundle fails clearly', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oba-runtime-test-'))
  try {
    const broken = path.join(dir, 'codex.exe')
    await writeFile(broken, 'not an executable')
    await assert.rejects(
      selectCodex([broken, path.join(dir, 'missing.exe')], ''),
      /重新安装完整安装包/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
