import { type ReactNode, useEffect, useState } from 'react'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import {
  defaultObsEnterEffectSettings,
  type ObsEffectCommand,
  type ObsEnterEffectSettings,
  type ObsSceneMetadata,
} from 'shared/obsEffect'
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

export function ObsEffectSetting() {
  const [settings, setSettings] = useState<ObsEnterEffectSettings>(defaultObsEnterEffectSettings)
  const [busy, setBusy] = useState<'save' | 'test' | 'trigger' | 'discover' | null>(null)
  const [scenes, setScenes] = useState<ObsSceneMetadata[]>([])
  const { toast } = useToast()

  useEffect(() => {
    void request({ action: 'state' }).then(response => {
      if (response.ok && response.settings) setSettings(response.settings)
      else if (!response.ok) toast.error(response.error)
    })
  }, [toast])

  const update = <K extends keyof ObsEnterEffectSettings>(
    key: K,
    value: ObsEnterEffectSettings[K],
  ) => setSettings(current => ({ ...current, [key]: value }))

  const run = async (action: 'save' | 'test' | 'trigger' | 'discover') => {
    setBusy(action)
    try {
      const command: ObsEffectCommand =
        action === 'trigger'
          ? { action, settings }
          : action === 'discover'
            ? { action, url: settings.url, password: settings.password }
            : { action, settings: { ...settings, enabled: false, effects: [] } }
      const response = await request(command)
      if (!response.ok) throw new Error(response.error)
      toast.success(response.message || '操作成功')
      if (response.settings) setSettings(response.settings)
      if (response.scenes) {
        setScenes(response.scenes)
        const selectedScene =
          response.scenes.find(scene => scene.name === settings.sceneName) || response.scenes[0]
        const selectedSource =
          selectedScene?.sources.find(
            source =>
              source.name === settings.sourceName &&
              source.containerName === (settings.sourceContainerName || settings.sceneName),
          ) || selectedScene?.sources[0]
        setSettings(current => ({
          ...current,
          sceneName: selectedScene?.name || '',
          sourceName: selectedSource?.name || '',
          sourceContainerName: selectedSource?.containerName,
        }))
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'OBS 操作失败')
    } finally {
      setBusy(null)
    }
  }

  const selectedScene = scenes.find(scene => scene.name === settings.sceneName)
  const selectedSourceKey = settings.sourceName
    ? JSON.stringify([settings.sourceContainerName || settings.sceneName, settings.sourceName])
    : ''

  return (
    <Card id="obs-enter-effect">
      <CardHeader>
        <CardTitle>OBS 设置</CardTitle>
        <CardDescription>
          配置 OBS WebSocket 连接并读取场景和来源；自动触发规则请在“钩子设置”中管理
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">
          需要先在 OBS 的“工具 → WebSocket 服务器设置”中启用服务器
        </p>

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="WebSocket 地址">
            <Input
              value={settings.url}
              onChange={event => update('url', event.target.value)}
              placeholder="ws://127.0.0.1:4455"
            />
          </Field>
          <Field label="WebSocket 密码">
            <Input
              type="password"
              value={settings.password}
              onChange={event => update('password', event.target.value)}
              placeholder="未设置密码可留空"
            />
          </Field>
          <Field label="场景">
            <Select
              value={settings.sceneName}
              onValueChange={sceneName => {
                const firstSource = scenes.find(scene => scene.name === sceneName)?.sources[0]
                setSettings(current => ({
                  ...current,
                  sceneName,
                  sourceName: firstSource?.name || '',
                  sourceContainerName: firstSource?.containerName,
                }))
              }}
              disabled={!scenes.length}
            >
              <SelectTrigger>
                <SelectValue placeholder="请先连接并读取 OBS" />
              </SelectTrigger>
              <SelectContent>
                {scenes.map(scene => (
                  <SelectItem key={scene.name} value={scene.name}>
                    {scene.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="来源">
            <Select
              value={selectedSourceKey}
              onValueChange={value => {
                const [containerName, sourceName] = JSON.parse(value) as [string, string]
                setSettings(current => ({
                  ...current,
                  sourceName,
                  sourceContainerName: containerName,
                }))
              }}
              disabled={!selectedScene?.sources.length}
            >
              <SelectTrigger>
                <SelectValue placeholder="请选择来源" />
              </SelectTrigger>
              <SelectContent>
                {selectedScene?.sources.map(source => (
                  <SelectItem
                    key={`${source.containerName}:${source.name}`}
                    value={JSON.stringify([source.containerName, source.name])}
                  >
                    {source.path}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="显示时长（毫秒）">
            <Input
              type="number"
              min={100}
              max={600000}
              step={100}
              value={settings.durationMs}
              onChange={event => update('durationMs', Number(event.target.value))}
            />
          </Field>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void run('discover')} disabled={busy !== null}>
            {busy === 'discover' ? '读取中...' : '连接并读取 OBS'}
          </Button>
          <Button onClick={() => void run('save')} disabled={busy !== null}>
            {busy === 'save' ? '保存中...' : '保存 OBS 连接'}
          </Button>
          <Button variant="outline" onClick={() => void run('trigger')} disabled={busy !== null}>
            {busy === 'trigger' ? '试播中...' : '手动试播'}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          这里选择的场景和来源仅用于手动试播。TikTok 等级和 Webhook 自动规则统一在钩子设置中配置。
        </p>
      </CardContent>
    </Card>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  )
}

function request(command: ObsEffectCommand) {
  return window.ipcRenderer.invoke(IPC_CHANNELS.obsEffect.request, command)
}
