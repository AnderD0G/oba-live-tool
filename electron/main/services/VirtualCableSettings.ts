import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 虚拟声卡配置（`userData/virtual-cable.json`）。
 *
 * 这是「走虚拟声卡播报」这条路的**唯一开关**。文件由 `scripts/setup-obs-cable.ts`
 * 探测设备后落盘，之后由界面上的开关改 `enabled`。
 *
 * 为什么是单独一个文件而不是跟着账号设置走：虚拟声卡是**机器级**的音频路由，
 * 跟账号、跟商品都无关 —— 换一个账号播，声卡还是同一块。
 */
export type VirtualCableConfig = {
  /** OBS 认的设备 id，形如 `{0.0.1.00000000}.{...}`。 */
  deviceId: string
  /** 给人看的设备名，落盘时写进来，界面直接显示。 */
  deviceName: string
  /** 用户显式打开的开关。没写或不是 true 都算关 —— 不出声比慢半秒严重得多。 */
  enabled: boolean
}

function cablePath(userData: string) {
  return join(userData, 'virtual-cable.json')
}

/** 读配置。文件不存在、读不动、或者没有设备 id，都返回 undefined（= 这条路不可用）。 */
export function readVirtualCable(userData: string): VirtualCableConfig | undefined {
  try {
    const file = cablePath(userData)
    if (!existsSync(file)) return undefined
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<VirtualCableConfig>
    if (typeof parsed.deviceId !== 'string' || !parsed.deviceId) return undefined
    return {
      deviceId: parsed.deviceId,
      deviceName: typeof parsed.deviceName === 'string' ? parsed.deviceName : '',
      enabled: parsed.enabled === true,
    }
  } catch {
    return undefined
  }
}

/**
 * 探测脚本用：更新设备信息，**保留** `enabled`。
 *
 * 不能整份覆盖写 `{deviceId, deviceName}` —— 那样重跑一次探测脚本就会把用户打开的
 * 开关冲成「没有」，虚拟声卡被静默关掉，而脚本还打印 PASS。
 */
export function mergeVirtualCableDevice(
  userData: string,
  deviceId: string,
  deviceName: string,
): VirtualCableConfig {
  const next: VirtualCableConfig = {
    deviceId,
    deviceName,
    enabled: readVirtualCable(userData)?.enabled === true,
  }
  writeFileSync(cablePath(userData), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

/**
 * 打开/关闭虚拟声卡。
 *
 * **合并写**：只改 `enabled`，保留 `deviceId`/`deviceName`。没有任何可用设备时
 * 返回 undefined 且**不写文件** —— 免得写出一份没有 deviceId 的配置，
 * 让下一次读取以为「设备配好了」。
 */
export function setVirtualCableEnabled(
  userData: string,
  enabled: boolean,
): VirtualCableConfig | undefined {
  const current = readVirtualCable(userData)
  if (!current) return undefined
  const next: VirtualCableConfig = { ...current, enabled }
  writeFileSync(cablePath(userData), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}
