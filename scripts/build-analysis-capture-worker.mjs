import { build } from 'esbuild'
import { isBuiltin } from 'node:module'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== '--outdir')) throw new Error('INVALID_OUTPUT_ARGUMENT')
const output = args.length ? args[1] : join(root, 'dist-electron/main')
if (!isAbsolute(output) || output.length > 1024 || resolve(output) === parse(output).root) throw new Error('INVALID_OUTPUT_DIRECTORY')
await mkdir(output, { recursive: true })
const info = await lstat(output)
if (!info.isDirectory() || info.isSymbolicLink() || resolve(await realpath(output)) !== resolve(output)) throw new Error('INVALID_OUTPUT_DIRECTORY')
for (const [asset, entry] of [
  ['analysis-capture-worker.cjs', 'CaptureWorkerEntry.ts'],
  ['fresh-analysis-worker.cjs', 'FreshAnalysisDatabaseWorker.ts'],
]) {
  const outfile = join(output, asset)
  try { const old = await lstat(outfile); if (!old.isFile() || old.isSymbolicLink() || old.nlink !== 1) throw new Error('INVALID_OUTPUT_FILE') } catch (error) { if (error.code !== 'ENOENT') throw error }
  const result = await build({ entryPoints: [join(root, 'electron/main/services/analysisRoom', entry)], outfile,
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', sourcemap: false, metafile: true, logLevel: 'silent' })
  const entries = Object.values(result.metafile.outputs)
  if (entries.length !== 1 || entries[0].bytes > 4 * 1024 * 1024 || entries[0].imports.some(entry => entry.external && !isBuiltin(entry.path))) throw new Error('INVALID_WORKER_BUNDLE')
  console.log(JSON.stringify({ asset, bytes: entries[0].bytes, target: 'node22' }))
}
