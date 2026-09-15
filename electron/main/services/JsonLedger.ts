import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
export class JsonLedger<T> {
  data: T
  constructor(
    private file: string,
    initial: T,
  ) {
    this.data = initial
    if (existsSync(file)) {
      try {
        this.data = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        throw new Error(`数据文件无法读取，请保留文件并修复：${file}`)
      }
    }
  }
  change(fn: (data: T) => void) {
    const next = structuredClone(this.data)
    fn(next)
    mkdirSync(path.dirname(this.file), { recursive: true })
    writeFileSync(`${this.file}.tmp`, JSON.stringify(next), 'utf8')
    renameSync(`${this.file}.tmp`, this.file)
    this.data = next
  }
}
