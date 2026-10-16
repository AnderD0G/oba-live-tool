import { Check, Copy, Smartphone, Square } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { MobileAssistantAccessStatus } from '../../../shared/mobileAssistantDesk'
import { mobileAccessQr } from './mobileAccessQr'

export function MobileDeskAccess({accountId, accountName}: {accountId: string; accountName: string}) {
  const [status, setStatus] = useState<MobileAssistantAccessStatus>({active:false,accountId,urls:[]})
  const [pending, setPending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState('')
  const [selectedUrl, setSelectedUrl] = useState('')
  const [copied, setCopied] = useState(false)
  const generation = useRef(0)
  const pendingRef = useRef(false)
  useEffect(() => {
    const own = ++generation.current
    setStatus({active:false,accountId,urls:[]})
    setNotice('')
    setSelectedUrl('')
    pendingRef.current = false
    setPending(false)
    setLoading(true)
    void Promise.resolve().then(() => window.ipcRenderer.invoke('assistant-mobile:request', {action:'status',accountId}))
      .then(result => {
        if (generation.current !== own) return
        if (result.ok) setStatus(result.data)
        else setNotice(result.error.message)
      }).catch(() => {
        if (generation.current === own) setNotice('暂时无法读取手机入口')
      }).finally(() => {
        if (generation.current === own) setLoading(false)
      })
    return () => { generation.current++ }
  }, [accountId])
  const run = async (action: 'start'|'stop') => {
    if (pendingRef.current) return
    const own = generation.current
    pendingRef.current = true
    setPending(true)
    setNotice('')
    setCopied(false)
    try {
      const result = await window.ipcRenderer.invoke('assistant-mobile:request', {action,accountId})
      if (generation.current !== own) return
      if (result.ok) {
        setStatus(result.data)
        setSelectedUrl(result.data.urls[0] ?? '')
      } else setNotice(result.error.message)
    } catch {
      if (generation.current === own) setNotice('手机入口操作失败，请重试')
    } finally {
      if (generation.current === own) {
        pendingRef.current = false
        setPending(false)
      }
    }
  }
  const url = status.active
    ? status.urls.includes(selectedUrl) ? selectedUrl : status.urls[0] ?? ''
    : ''
  const qr = useMemo(() => {
    if (!url) return ''
    try { return mobileAccessQr(url) } catch { return '' }
  }, [url])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setNotice('')
    } catch { setNotice('复制失败，可从下方选中地址复制') }
  }
  return <section className="assistant-mobile-access" aria-label="手机助播台入口">
    <div className="assistant-mobile-access-heading">
      <div>
        <h2><Smartphone size={18}/>手机助播台</h2>
        <p>{status.active ? '手机扫码即可查看实时信息和任务' : '直播时用手机查看实时信息和处理任务'}</p>
      </div>
      <Button size="sm" variant={status.active?'outline':'default'} disabled={pending||loading}
        onClick={() => void run(status.active?'stop':'start')}>
        {status.active ? <Square size={14}/> : <Smartphone size={14}/>}
        {pending ? '正在处理…' : status.active ? '关闭手机入口' : '开启手机入口'}
      </Button>
    </div>
    {notice && <p role="alert" className="assistant-mobile-access-notice">{notice}</p>}
    {status.active && <div className="assistant-mobile-access-content">
      {qr && <img className="assistant-mobile-access-qr" src={qr} alt="用手机扫码打开当前账号助播台"/>}
      <div className="assistant-mobile-access-details">
        <strong>{accountName}</strong>
        <p>手机与这台电脑连接同一局域网。关闭入口后，旧二维码和地址立即失效。</p>
        {status.urls.length > 1 && <label>
          选择连接地址
          <select aria-label="手机连接地址" value={url} onChange={event => {setSelectedUrl(event.target.value);setCopied(false)}}>
            {status.urls.map(value => <option key={value} value={value}>{new URL(value).host}</option>)}
          </select>
        </label>}
        <div className="assistant-mobile-access-link">
          <input aria-label="手机访问地址" readOnly value={url} onFocus={event => event.target.select()}/>
          <Button size="sm" variant="outline" onClick={() => void copy()}>
            {copied ? <Check size={14}/> : <Copy size={14}/>} {copied?'已复制':'复制地址'}
          </Button>
        </div>
      </div>
    </div>}
  </section>
}

