import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

/**
 * 默认不留备份：弹幕采集、小票、观众记录这类账本是高频写入的，
 * 每次保存都复制一份会白白翻倍 I/O，所以只给真正怕丢的配置文件打开。
 */
export interface JsonLedgerOptions {
  /** 保存前在文件旁保留最近几版；0 或省略表示不留。 */
  backups?: number
}

export class JsonLedger<T> {
  data: T
  private sequence = 0
  constructor(
    private file: string,
    initial: T,
    private options: JsonLedgerOptions = {},
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

  /**
   * 保存前把上一版留在旁边。
   *
   * 界面持的是进入页面时读到的那份旧副本，一保存就整份覆盖，没有备份就再也找不回来。
   * 备份只是保险，任何失败都不能挡住正常保存。
   */
  private backupPrevious() {
    const keep = this.options.backups ?? 0
    if (keep <= 0 || !existsSync(this.file)) return
    try {
      const dir = path.dirname(this.file)
      const base = path.basename(this.file)
      // 同一毫秒内可能连写多次，加一个定宽序号保证名字不撞且仍按时间排序
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      let target = ''
      do {
        target = path.join(
          dir,
          `${base}.${stamp}-${String(this.sequence++).padStart(4, '0')}.bak`,
        )
      } while (existsSync(target))
      copyFileSync(this.file, target)
      const prefix = `${base}.`
      const stale = readdirSync(dir)
        .filter(name => name.startsWith(prefix) && name.endsWith('.bak'))
        .sort()
        .reverse()
        .slice(keep)
      for (const name of stale) rmSync(path.join(dir, name), { force: true })
    } catch {
      // 备份失败不影响保存
    }
  }

  change(fn: (data: T) => void) {
    const next = structuredClone(this.data)
    fn(next)
    mkdirSync(path.dirname(this.file), { recursive: true })
    this.backupPrevious()
    writeFileSync(`${this.file}.tmp`, JSON.stringify(next), 'utf8')
    renameSync(`${this.file}.tmp`, this.file)
    this.data = next
  }
}
