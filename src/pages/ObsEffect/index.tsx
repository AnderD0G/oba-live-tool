import { useEffect, useRef, useState } from 'react'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import {
  defaultObsInstantPresentation,
  type ObsEffectCommand,
  type ObsEffectResponse,
  type ObsInstantPresentation,
} from 'shared/obsEffect'
import { Title } from '@/components/common/Title'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ObsEffectSetting } from '@/pages/SettingsPage/components/ObsEffectSetting'
import { ObsCameraCard } from './ObsCameraCard'

export default function ObsEffect() {
  return (
    <div className="container py-8 space-y-5">
      <div className="mb-6">
        <Title title="OBS 控制" description="切换双机位，配置 OBS 连接并试播已有进场特效" />
      </div>
      <ObsCameraCard />
      <InstantPresentationCard />
      <ObsEffectSetting />
    </div>
  )
}

function InstantPresentationCard() {
  const [presentation, setPresentation] = useState<ObsInstantPresentation>(defaultObsInstantPresentation)
  const [savedPresentation, setSavedPresentation] = useState<ObsInstantPresentation>(defaultObsInstantPresentation)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const dirty = presentation.mode !== savedPresentation.mode
    || presentation.followCamera !== savedPresentation.followCamera
  const refreshBlocked = useRef(false)
  refreshBlocked.current = busy || dirty

  useEffect(() => {
    let mounted = true
    const refresh = async () => {
      if (refreshBlocked.current) return
      try {
        const response = await request({ action: 'instant-presentation-state' })
        if (!response.ok) throw new Error(response.error)
        if (!response.instantPresentation) throw new Error('未能读取显示设置')
        if (mounted && !refreshBlocked.current) {
          setPresentation(response.instantPresentation)
          setSavedPresentation(response.instantPresentation)
          setLoaded(true)
          setError('')
          setMessage('')
        }
      } catch (cause) {
        if (mounted) setError(cause instanceof Error ? cause.message : '读取显示设置失败')
      }
    }
    const onCameraChanged = () => void refresh()
    void refresh()
    window.addEventListener('oba:obs-camera-changed', onCameraChanged)
    return () => {
      mounted = false
      window.removeEventListener('oba:obs-camera-changed', onCameraChanged)
    }
  }, [])

  const save = async () => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const response = await request({ action: 'instant-presentation-save', ...presentation })
      if (!response.ok) throw new Error(response.error)
      if (!response.instantPresentation) throw new Error('未能确认显示设置已保存')
      setPresentation(response.instantPresentation)
      setSavedPresentation(response.instantPresentation)
      setMessage(response.message || '显示设置已保存')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存显示设置失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card id="obs-instant-presentation">
      <CardHeader>
        <CardTitle>即时特效显示</CardTitle>
        <CardDescription>远景适合热闹画面；聚焦把文字和花弧留在角落。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="obs-instant-mode">显示模式</Label>
            <Select value={presentation.mode} disabled={busy || !loaded}
              onValueChange={(mode: 'wide' | 'focus') => {
                setPresentation(current => ({ ...current, mode }))
                setMessage('')
              }}>
              <SelectTrigger id="obs-instant-mode"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="wide">远景（热闹）</SelectItem>
                <SelectItem value="focus">聚焦（角落花弧）</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="obs-instant-follow-camera">跟随机位</Label>
              <Switch id="obs-instant-follow-camera" checked={presentation.followCamera}
                disabled={busy || !loaded}
                onCheckedChange={followCamera => {
                  setPresentation(current => ({ ...current, followCamera }))
                  setMessage('')
                }} />
            </div>
            <p className="text-sm text-muted-foreground">切换机位时，Android 用远景，iPhone 用聚焦。</p>
          </div>
        </div>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
        {dirty && <p className="text-sm text-muted-foreground">显示设置有修改，请保存。</p>}
        <Button variant="outline" disabled={busy || !loaded} onClick={() => void save()}>
          {busy ? '保存中...' : '保存显示设置'}
        </Button>
      </CardContent>
    </Card>
  )
}

function request(command: ObsEffectCommand): Promise<ObsEffectResponse> {
  return window.ipcRenderer.invoke(IPC_CHANNELS.obsEffect.request, command)
}
