import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

// Pinned official public npm artifact. Never package the developer's CLI/login files.
const version = '0.154.0-win32-x64'
const integrity =
  'Stg2KEJPIKVqPPR1wCverGOR4ey3RR3cvakR07w7FNKQUMzmHaOZomRsP2bR1qOT/67yHsks9rB+MCMfIWXcRA=='
const root = path.resolve('vendor-build/codex')
await mkdir(root, { recursive: true })
const archive = path.join(root, 'codex.tgz')
let bytes = await readFile(archive).catch(() => null)
if (!bytes) {
  const response = await fetch(`https://registry.npmjs.org/@openai/codex/-/codex-${version}.tgz`)
  if (!response.ok) throw new Error(`Download failed: ${response.status}`)
  bytes = Buffer.from(await response.arrayBuffer())
}
if (createHash('sha512').update(bytes).digest('base64') !== integrity)
  throw new Error('Official CLI archive integrity mismatch')
await writeFile(archive, bytes)
const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/)
if (entries.some(entry => !entry.startsWith('package/') || entry.split('/').includes('..')))
  throw new Error('Unsafe archive path')
execFileSync('tar', ['-xzf', archive, '-C', root])
await writeFile(
  path.join(root, 'package', 'BUNDLE-NOTICE.txt'),
  `Official @openai/codex ${version}\nSource: https://github.com/openai/codex\nLicense: Apache-2.0\nSHA512: ${integrity}\nNo account credentials are included.\n`,
)
await copyFile('LICENSE', path.join(root, 'package', 'OBA-LICENSE.txt'))
for (const [name, sha256] of Object.entries({
  LICENSE: 'd17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc',
  NOTICE: '9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915',
})) {
  const file = path.join(root, 'package', name)
  let contents = await readFile(file).catch(() => null)
  if (!contents || createHash('sha256').update(contents).digest('hex') !== sha256) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(
          `https://raw.githubusercontent.com/openai/codex/rust-v0.154.0/${name}`,
          { signal: AbortSignal.timeout(20000) },
        )
        if (!response.ok) throw new Error(`Missing official Codex ${name}: ${response.status}`)
        contents = Buffer.from(await response.arrayBuffer())
        break
      } catch (error) {
        if (attempt === 2) throw error
      }
    }
  }
  if (!contents || createHash('sha256').update(contents).digest('hex') !== sha256)
    throw new Error(`${name} integrity mismatch`)
  await writeFile(file, contents)
}
console.log(`Verified and extracted official Codex ${version}: ${entries.length} entries`)
