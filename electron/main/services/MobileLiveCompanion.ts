import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { networkInterfaces } from 'node:os'
import type { HumanLiveCameraStatus, HumanLiveItem } from '../../../shared/deepSeekAuto'

type Dependencies = {
  items: () => HumanLiveItem[]
  activity: () => { user: string; text: string; at: number }[]
  cameraStatus: () => Promise<HumanLiveCameraStatus>
  cameraSwitch: (target: 'android' | 'iphone') => Promise<HumanLiveCameraStatus>
  update: (id: string, operation: 'done' | 'ignore') => void
  reply: (id: string, chinese: string) => Promise<string>
}

const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>直播副屏</title><style>
*{box-sizing:border-box}body{margin:0;background:#10141c;color:#f5f7fb;font:18px system-ui,sans-serif}header{position:sticky;top:0;background:#192230;padding:18px;z-index:2}h1{font-size:23px;margin:0 0 5px}small{color:#aebbd0}main{padding:12px;max-width:700px;margin:auto}.card{background:#202b3b;border:1px solid #34445c;border-radius:14px;margin:12px 0;padding:16px}.demo{border-left:6px solid #f7b955}.review{border-left:6px solid #81b7ff}.answer,.greeting{border-left:6px solid #6ed9b5}.muted{opacity:.58}.name{font-weight:700}.body{font-size:21px;line-height:1.45;margin:10px 0}.original{font-size:14px;color:#b8c6d8;word-break:break-word}button{font:inherit;color:white;background:#34527b;border:0;border-radius:10px;padding:11px 15px;margin:8px 8px 0 0;min-height:44px}.secondary{background:#45505e}.selected{background:#187a56;outline:2px solid #89e6bb}textarea{display:block;width:100%;font:20px system-ui;padding:12px;border-radius:10px;min-height:72px;margin-top:12px}#notice{font-size:15px;color:#ffcf76}.row{display:flex;flex-wrap:wrap;align-items:center}.empty{text-align:center;color:#aebbd0;padding:38px 0}
</style></head><body><header><h1>直播副屏</h1><small>展示请求与人工回复 · 手机和电脑须在同一局域网</small><div id="notice"></div></header><main><section id="camera" class="card"></section><div id="cards"></div><h2 style="padding:12px 0;font-size:19px">最新动态</h2><div id="activity"></div></main><script>
const base=(location.pathname.endsWith('/')?location.pathname.slice(0,-1):location.pathname);const camera=document.getElementById('camera');const cards=document.getElementById('cards');const activity=document.getElementById('activity');const notice=document.getElementById('notice');let editing='';function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n}async function api(method,body){const r=await fetch(base+'/api',{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,cache:'no-store'});const data=await r.json();if(!r.ok)throw Error(data.error||'操作失败');return data}function show(msg){notice.textContent=msg;setTimeout(()=>{if(notice.textContent===msg)notice.textContent=''},6000)}async function act(body){try{const data=await api('POST',body);show(data.message||'已处理');editing='';await refresh()}catch(e){show(e.message)}}async function refresh(){try{const data=await api('GET');camera.replaceChildren();camera.append(el('div','name','OBS 双机位'));if(data.camera&&data.camera.ok){for(const [target,label] of [['android','安卓机位'],['iphone','iPhone 机位']]){const button=el('button',data.camera.selected===target?'selected':'secondary',label+(data.camera.selected===target?' ✓':''));button.onclick=()=>act({action:'camera',target});camera.append(button)}if(data.camera.selected==='both'||data.camera.selected==='none')camera.append(el('div','original','当前两个来源同时显示或同时隐藏，请选择一个机位'));if(data.camera.onProgram===false)camera.append(el('div','original','OBS 当前节目场景为 '+data.camera.programScene+'，请先切到双机位场景'))}else camera.append(el('div','original',(data.camera&&data.camera.error)||'无法读取 OBS 机位'));cards.replaceChildren();activity.replaceChildren();for(const event of data.activity||[]){const row=el('div','card');row.append(el('div','name',event.user));row.append(el('div','original',event.text));activity.append(row)}const items=data.items.filter(x=>x.status==='pending'||x.status==='failed');if(!items.length){cards.append(el('div','empty','目前没有待处理事项'));return}for(const x of items){const card=el('article','card '+x.kind);card.append(el('div','name',(x.kind==='demo'?'🛍️ 展示商品':x.kind==='review'?'💬 需要回复':x.kind==='greeting'?'👋 打招呼':'✓ 自动回复')+' · '+x.user));card.append(el('div','body',x.chinese+(x.product?' · '+x.product:'')));card.append(el('div','original',x.original+' · '+x.language));if(x.reply)card.append(el('div','original','建议回复：'+x.reply));const row=el('div','row');if(x.kind==='demo'||x.kind==='review'){const done=el('button','','完成');done.onclick=()=>act({action:'item',id:x.id,operation:'done'});row.append(done)}const ignore=el('button','secondary','忽略');ignore.onclick=()=>act({action:'item',id:x.id,operation:'ignore'});row.append(ignore);card.append(row);if(x.kind==='review'){const area=el('textarea');area.placeholder='中文回复；也可用手机键盘的语音输入';area.value=x.id===editing?window.draft||'':'';area.oninput=()=>{editing=x.id;window.draft=area.value};card.append(area);const mic=el('button','secondary','🎙️ 语音输入');mic.onclick=()=>{const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;if(!Recognition){show('此浏览器不支持网页语音识别，请使用手机键盘的麦克风');return}const rec=new Recognition();rec.lang='zh-CN';rec.onresult=e=>{area.value+=(e.results[0][0].transcript||'');editing=x.id;window.draft=area.value};rec.onerror=()=>show('语音识别不可用，请使用手机键盘麦克风');rec.start()};card.append(mic);const send=el('button','','翻译并发送 ↵');send.onclick=()=>act({action:'reply',id:x.id,chinese:area.value});area.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send.click()}};card.append(send)}cards.append(card)}}catch(e){show(e.message)}}refresh();setInterval(()=>{if(!document.activeElement||document.activeElement.tagName!=='TEXTAREA')refresh()},2500);
</script></body></html>`

export class MobileLiveCompanion {
  private server?: Server
  private token = randomBytes(24).toString('hex')
  url = ''
  urls: string[] = []
  constructor(private deps: Dependencies) {}

  async start() {
    if (this.server) return this.url
    const server = createServer(async (req, res) => {
      const path = new URL(req.url || '/', 'http://localhost').pathname
      const base = `/${this.token}`
      const response = (status: number, body: unknown) => {
        res.writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        })
        res.end(JSON.stringify(body))
      }
      if (path === base && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
        })
        res.end(page)
        return
      }
      if (path !== `${base}/api`) return response(404, { error: '页面不存在' })
      if (req.method === 'GET')
        return response(200, {
          items: this.deps.items(),
          activity: this.deps.activity(),
          camera: await this.deps.cameraStatus(),
        })
      if (
        req.method !== 'POST' ||
        req.headers['content-type']?.split(';')[0] !== 'application/json'
      )
        return response(405, { error: '请求无效' })
      const origin = req.headers.origin
      if (origin && origin !== `http://${req.headers.host}`)
        return response(403, { error: '来源无效' })
      try {
        let body = ''
        for await (const chunk of req) {
          body += chunk.toString()
          if (body.length > 5000) throw new Error('请求过大')
        }
        const command = JSON.parse(body)
        if (command.action === 'item' && ['done', 'ignore'].includes(command.operation)) {
          this.deps.update(command.id, command.operation)
          return response(200, { message: '已处理' })
        }
        if (command.action === 'reply') {
          const translated = await this.deps.reply(command.id, command.chinese)
          return response(200, { message: `已发送：${translated}` })
        }
        if (command.action === 'camera' && ['android', 'iphone'].includes(command.target)) {
          const status = await this.deps.cameraSwitch(command.target)
          return response(200, {
            message: `已切换至${command.target === 'android' ? '安卓' : 'iPhone'}机位`,
            camera: status,
          })
        }
        return response(400, { error: '操作无效' })
      } catch (error) {
        return response(400, { error: error instanceof Error ? error.message : '操作失败' })
      }
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '0.0.0.0', resolve)
    })
    this.server = server
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const addresses = Object.entries(networkInterfaces())
      .flatMap(([name, values]) => (values || []).map(value => ({ name, ...value })))
      .filter(ip => ip.family === 'IPv4' && !ip.internal)
      .sort((a, b) => Number(/wi-?fi|wlan/i.test(b.name)) - Number(/wi-?fi|wlan/i.test(a.name)))
    this.urls = (addresses.length ? addresses.map(ip => ip.address) : ['127.0.0.1']).map(
      ip => `http://${ip}:${port}/${this.token}`,
    )
    this.url = this.urls[0]
    return this.url
  }

  stop() {
    this.server?.close()
    this.server = undefined
    this.url = ''
    this.urls = []
    this.token = randomBytes(24).toString('hex')
  }
}
