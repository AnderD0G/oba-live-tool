import { execFile } from 'node:child_process'
import { access, readdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
let bundledPath = ''
let detected: Promise<{ path: string; version: string; bundled: boolean }> | undefined
export function configureBundledCodex(executable: string) {
  bundledPath = executable
  detected = undefined
}
export function compatibleCodex(version: string) {
  const match = /^codex-cli (\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  return !!match && (Number(match[1]) > 0 || Number(match[2]) >= 154)
}
export async function codexCandidates(env = process.env, bundle = bundledPath): Promise<string[]> {
  const executable = process.platform === 'win32' ? 'codex.exe' : 'codex'
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const candidates = dirs.map(dir => path.join(dir, executable))
  if (process.platform === 'win32') {
    if (env.LOCALAPPDATA) {
      const root = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin')
      for (const dir of await readdir(root, { withFileTypes: true }).catch(() => []))
        if (dir.isDirectory()) candidates.push(path.join(root, dir.name, executable))
    }
    // npm's .cmd wrapper is not executable with shell:false. Resolve its native dependency.
    const npmRoots = [...dirs, ...(env.APPDATA ? [path.join(env.APPDATA, 'npm')] : [])]
    for (const root of npmRoots) {
      for (const suffix of ['bin/codex.exe', 'codex/codex.exe']) {
        candidates.push(
          path.join(
            root,
            'node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc',
            suffix,
          ),
        )
        candidates.push(
          path.join(root, 'node_modules/@openai/codex/vendor/x86_64-pc-windows-msvc', suffix),
        )
      }
    }
  }
  if (bundle) candidates.push(bundle)
  return [...new Set(candidates)]
}
export async function selectCodex(candidates: string[], bundle: string) {
  for (const executable of candidates) {
    try {
      await access(executable)
      const { stdout } = await run(executable, ['--version'], {
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 16384,
      })
      const version = stdout.trim()
      if (compatibleCodex(version))
        return { path: executable, version, bundled: executable === bundle }
    } catch {
      /* Missing, obsolete or broken installations fall back to the bundled runtime. */
    }
  }
  throw new Error('未找到可运行的 Codex 组件，请重新安装完整安装包。弹幕筛选和打印仍可使用。')
}
export function detectCodex() {
  detected ??= codexCandidates()
    .then(paths => selectCodex(paths, bundledPath))
    .catch(error => {
      detected = undefined
      throw error
    })
  return detected
}
