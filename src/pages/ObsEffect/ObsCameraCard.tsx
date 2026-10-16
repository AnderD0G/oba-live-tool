import { useEffect, useState } from 'react'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import {
  defaultObsCameraConfig,
  type ObsCameraAction,
  type ObsCameraConfig,
  type ObsCameraStatus,
  validateObsCameraConfig,
} from 'shared/obsCamera'
import type { ObsEffectCommand, ObsEffectResponse } from 'shared/obsEffect'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/hooks/useToast'

function request(command: ObsEffectCommand): Promise<ObsEffectResponse> {
  return window.ipcRenderer.invoke(IPC_CHANNELS.obsEffect.request, command)
}

function selectedLabel(status?: ObsCameraStatus) {
  if (!status?.ok) return status?.error || '尚未检查 OBS 机位'
  return status.selected === 'android'
    ? '安卓'
    : status.selected === 'iphone'
      ? 'iPhone'
      : status.selected === 'both'
        ? '两个来源同时显示'
        : '当前节目未选中机位'
}

export function ObsCameraCard() {
  const [config, setConfig] = useState<ObsCameraConfig>(defaultObsCameraConfig)
  const [saved, setSaved] = useState(JSON.stringify(defaultObsCameraConfig))
  const [status, setStatus] = useState<ObsCameraStatus>()
  const [lastAction, setLastAction] = useState<ObsCameraAction>()
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const { toast } = useToast()

  useEffect(() => {
    let mounted = true
    void request({ action: 'camera-state' })
      .then(response => {
        if (!mounted) return
        if (!response.ok) {
          setError(response.error)
          return
        }
        if (response.cameraConfig) {
          setConfig(response.cameraConfig)
          setSaved(JSON.stringify(response.cameraConfig))
        }
        setStatus(response.cameraStatus)
        setLastAction(response.cameraAction)
      })
      .catch(cause => {
        if (mounted) setError(cause instanceof Error ? cause.message : '读取机位配置失败')
      })
      .finally(() => {
        if (mounted) setLoaded(true)
      })
    return () => {
      mounted = false
    }
  }, [])

  let configError = ''
  try {
    validateObsCameraConfig(config)
  } catch (cause) {
    configError = cause instanceof Error ? cause.message : '机位配置无效'
  }
  const dirty = JSON.stringify(config) !== saved
  const update = (patch: Partial<ObsCameraConfig>) =>
    setConfig(current => ({ ...current, ...patch }))

  const run = async (command: ObsEffectCommand) => {
    setBusy(true)
    setError('')
    try {
      const response = await request(command)
      if (!response.ok) throw new Error(response.error)
      if (response.cameraConfig && command.action === 'camera-save') {
        setConfig(response.cameraConfig)
        setSaved(JSON.stringify(response.cameraConfig))
      }
      if (response.cameraStatus) setStatus(response.cameraStatus)
      if (response.cameraAction) setLastAction(response.cameraAction)
      if (command.action === 'camera-switch') {
        window.dispatchEvent(new CustomEvent('oba:obs-camera-changed'))
      }
      if (command.action === 'camera-save') {
        const checked = await request({ action: 'camera-status' })
        if (checked.ok) setStatus(checked.cameraStatus)
        else setError(checked.error)
      }
      if (response.message) toast.success(response.message)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'OBS 机位操作失败'
      setError(message)
      toast.error(message)
      if (command.action === 'camera-switch') {
        const checked = await request({ action: 'camera-status' }).catch(() => undefined)
        if (checked?.ok) {
          setStatus(checked.cameraStatus)
          setLastAction(checked.cameraAction)
        }
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card id="obs-camera">
      <CardHeader>
        <CardTitle>双机位切换</CardTitle>
        <CardDescription>
          沿用下方保存的 OBS 连接，切换节目机位并核对实际结果。可直接使用，无需开启 AI。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="obs-camera-mode">机位布局</Label>
          <Select
            value={config.switchMode ?? 'source-visibility'}
            disabled={busy || !loaded}
            onValueChange={value => update({ switchMode: value as ObsCameraConfig['switchMode'] })}
          >
            <SelectTrigger id="obs-camera-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="source-visibility">同一场景内的两个来源</SelectItem>
              <SelectItem value="scene">两个独立的机位场景</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {config.switchMode === 'scene' ? (
          <div className="grid gap-4 md:grid-cols-2">
            {(['androidSceneName', 'iphoneSceneName'] as const).map((field, index) => (
              <div key={field} className="space-y-2">
                <Label htmlFor={`obs-camera-${field}`}>
                  {index === 0 ? '小米 / Android 场景' : 'iPhone 场景'}
                </Label>
                <Input
                  id={`obs-camera-${field}`}
                  value={config[field] ?? ''}
                  disabled={busy || !loaded}
                  placeholder={index === 0 ? '小米4K机位' : 'iPhone机位'}
                  onChange={event => update({ [field]: event.target.value })}
                />
              </div>
            ))}
            <p className="text-sm text-muted-foreground md:col-span-2">
              使用 OBS 当前设置的场景转场；不会更改来源、裁剪或停止相机。
            </p>
          </div>
        ) : (
          <>
            <div className="grid gap-4 md:grid-cols-3">
              {(['sceneName', 'androidSource', 'iphoneSource'] as const).map((field, index) => (
                <div key={field} className="space-y-2">
                  <Label htmlFor={`obs-camera-${field}`}>
                    {['场景名称', '安卓来源', 'iPhone 来源'][index]}
                  </Label>
                  <Input
                    id={`obs-camera-${field}`}
                    value={config[field]}
                    disabled={busy || !loaded}
                    onChange={event => update({ [field]: event.target.value })}
                  />
                </div>
              ))}
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="obs-camera-transition">切换方式</Label>
                <Select
                  value={config.transitionMethod ?? 'cut'}
                  disabled={busy || !loaded}
                  onValueChange={value =>
                    update({ transitionMethod: value as ObsCameraConfig['transitionMethod'] })
                  }
                >
                  <SelectTrigger id="obs-camera-transition">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="opacity-filter">淡入淡出</SelectItem>
                    <SelectItem value="cut">直接切换</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="obs-camera-duration">淡入淡出时长（毫秒）</Label>
                <Input
                  id="obs-camera-duration"
                  type="number"
                  min={250}
                  max={1500}
                  step={50}
                  value={config.transitionMs ?? 450}
                  disabled={busy || !loaded || (config.transitionMethod ?? 'cut') === 'cut'}
                  onChange={event => update({ transitionMs: Number(event.target.value) })}
                />
              </div>
            </div>
          </>
        )}
        <p className="text-sm">当前机位：{selectedLabel(status)}</p>
        {status?.onProgram === false && (
          <p className="text-sm text-amber-600">
            当前节目场景为「{status.programScene}」。
            {config.switchMode === 'scene'
              ? '请选择要输出的机位场景。'
              : `这里控制「${config.sceneName}」里的来源。`}
          </p>
        )}
        {(error || configError) && (
          <p role="alert" className="text-sm text-red-600">
            {error || configError}
          </p>
        )}
        {dirty && <p className="text-sm text-muted-foreground">机位配置有修改，保存后再切换。</p>}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy || !loaded || Boolean(configError)}
            onClick={() => void run({ action: 'camera-save', config })}
          >
            保存机位配置
          </Button>
          <Button
            variant="outline"
            disabled={busy || !loaded}
            onClick={() => void run({ action: 'camera-status' })}
          >
            {busy ? '处理中…' : '检查当前机位'}
          </Button>
          <Button
            disabled={busy || !loaded || dirty || !status?.ok}
            onClick={() => void run({ action: 'camera-switch', target: 'android' })}
          >
            切到小米 / Android
          </Button>
          <Button
            disabled={busy || !loaded || dirty || !status?.ok}
            onClick={() => void run({ action: 'camera-switch', target: 'iphone' })}
          >
            切到 iPhone
          </Button>
        </div>
        {lastAction && (
          <p className="text-xs text-muted-foreground">
            上次切换：{lastAction.target === 'android' ? '安卓' : 'iPhone'} ·{' '}
            {lastAction.ok ? 'OBS 已确认' : lastAction.error}。详细记录见互动审查日志。
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {config.switchMode === 'scene'
            ? '独立场景切换沿用 OBS 当前转场设置。'
            : '淡入淡出适用于该场景独立使用的机位来源，时长 250～1500 毫秒。'}
        </p>
      </CardContent>
    </Card>
  )
}
