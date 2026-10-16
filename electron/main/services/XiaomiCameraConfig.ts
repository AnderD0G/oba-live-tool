import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_XIAOMI_CAMERA_BASE_URL } from '../../../shared/xiaomiCamera'
import {
  validateXiaomiCameraBaseUrl,
  validateXiaomiCameraToken,
  type XiaomiCameraConfigStore,
  type XiaomiCameraPrivateConfig,
} from './XiaomiCameraService'

export class XiaomiCameraFileConfig implements XiaomiCameraConfigStore {
  constructor(private file: string) {
    if (!path.isAbsolute(file))
      throw new Error('Camera configuration requires an absolute private path')
  }

  load(): XiaomiCameraPrivateConfig {
    let descriptor: number | undefined
    try {
      const info = fs.lstatSync(this.file)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('unsafe file')
      descriptor = fs.openSync(this.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
      const stat = fs.fstatSync(descriptor)
      if (
        !stat.isFile() ||
        stat.size > 16384 ||
        (process.platform !== 'win32' && (stat.mode & 0o077 || stat.uid !== process.getuid?.()))
      )
        throw new Error('unsafe file')
      const value = JSON.parse(fs.readFileSync(descriptor, 'utf8'))
      if (value?.version !== 1) throw new Error('invalid configuration')
      return {
        baseUrl: validateXiaomiCameraBaseUrl(value.baseUrl),
        token: validateXiaomiCameraToken(value.token),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT')
        return { baseUrl: DEFAULT_XIAOMI_CAMERA_BASE_URL, token: '' }
      throw Object.assign(new Error('小米相机私有配置不可读，请核对本机文件权限'), {
        code: 'XIAOMI_CONFIG_UNREADABLE',
      })
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor)
    }
  }

  save(value: XiaomiCameraPrivateConfig): void {
    const config = {
      version: 1,
      baseUrl: validateXiaomiCameraBaseUrl(value.baseUrl),
      token: validateXiaomiCameraToken(value.token),
    }
    const directory = path.dirname(this.file)
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
      const info = fs.lstatSync(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe directory')
      if (process.platform !== 'win32') {
        if (info.uid !== process.getuid?.()) throw new Error('unsafe directory owner')
        fs.chmodSync(directory, 0o700)
      }
      fs.writeFileSync(temporary, JSON.stringify(config), { mode: 0o600, flag: 'wx' })
      fs.renameSync(temporary, this.file)
    } catch {
      throw Object.assign(new Error('小米相机密钥无法安全保存，请检查本机配置目录'), {
        code: 'XIAOMI_CONFIG_UNREADABLE',
      })
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  }
}
