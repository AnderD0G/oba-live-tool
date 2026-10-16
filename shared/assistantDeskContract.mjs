const id = { type: 'string', minLength: 1, maxLength: 256, pattern: '^[^\\s\\x00-\\x1f\\x7f]+$' }
const text = maxLength => ({ type: 'string', maxLength })
const integer = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => ({ type: 'integer', minimum, maximum })
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false })
const account = { accountId: id }
const filter = { ...account, sessionId: id, userId: id, audienceUuid: id,
  // i+dot is the exact lowercase representation of one source İ unit.
  mentionHandle: { type: 'string', minLength: 1, maxLength: 201, pattern: '^@?(?:[iI]\\u0307|[^@\\s\\x00-\\x1f\\x7f\\u0307]){1,100}$' },
  nickname: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[^\\x00-\\x1f\\x7f]+$' },
  from: integer(), to: integer(), minPayLevel: integer(1, 100), cursor: text(2048), limit: integer(1, 200) }
const editable = {
  knowledge: text(20000), instructions: text(20000), replyMode: { enum: ['off','review','auto'] },
  translationEnabled: { type: 'boolean' }, aiRequestLimit: integer(0,1000), goldLevel: integer(1,100),
  translationMode: { enum: ['ai','browser','local'] },
  priorityGold: { type: 'boolean' }, aiPaused: { type: 'boolean' }, localEffectsEnabled:{type:'boolean'}, revision: integer(),
  attentionMaxAgeSeconds: integer(30,86400),
}
const context = object(editable, Object.keys(editable).filter(key => !['revision','attentionMaxAgeSeconds','translationMode'].includes(key)))
const policyFields = ['payLevel','fansClubLevel','followerCount','followingCount','followStatus','subscriptionActive','comments','enters','follows','finalGiftGroups','knownGiftCoins','manualCountry','inferredCountry','regionEvidenceScore','textScript','textEvidenceScore','messageCategory','messageLanguage']
const array = (items, maxItems, minItems = 0) => ({ type: 'array', items, minItems, maxItems })
const policyValue = { anyOf: [integer(), text(100), {type:'boolean'}, array(text(100),20,1)] }
const policyCondition = object({field:{enum:policyFields},operator:{enum:['eq','gte','lte','in']},value:policyValue})
const policyRule = object({
  id:{type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$',minLength:1,maxLength:64}, label:{...text(60),minLength:1}, enabled:{type:'boolean'}, priority:integer(0,10000),
  conditions:array(policyCondition,10,1),
  result:object({tier:{enum:['gold','silver','neutral']},label:{...text(60),minLength:1},autoAttention:{type:'boolean'},welcomePresetId:{...text(100),minLength:1,pattern:'^[a-z0-9][a-z0-9-]*$'},cardColor:{type:'string',pattern:'^#[0-9a-fA-F]{6}$'}},['tier','label','autoAttention']),
})
const policy = object({revision:integer(),enabled:{type:'boolean'},rules:array(policyRule,20),attentionWindowSeconds:integer(30,3600)},['enabled','rules'])
const replyRule = object({id:{type:'string',pattern:'^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$',minLength:1,maxLength:64},enabled:{type:'boolean'},action:{enum:['comment','enter','follow','gift','like']},mode:{enum:['off','manual','review','auto']},priority:integer(0,10000),audienceRuleId:{...text(64),minLength:1},tier:{enum:['gold','silver','neutral']},knowledge:text(20000),instructions:text(20000)},['id','enabled','action','mode','priority','knowledge','instructions'])
const replyPolicy = object({revision:integer(1),enabled:{type:'boolean'},rules:array(replyRule,100)},['enabled','rules'])
const batchFilter = { ...account, batchId:id, cursor:text(2048), limit:integer(1,200), kinds:array({enum:['comment','enter','leave','follow','gift','like','event']},7), tier:{enum:['gold','silver','neutral']}, minPayLevel:integer(0,10000), minFansClubLevel:integer(0,10000), minFollowerCount:integer() }

/** Public TikTok usernames may begin with a period, but cannot end with one or contain adjacent periods. */
export function isTikTokUsername(input) {
  return typeof input === 'string' && input.length >= 1 && input.length <= 24 &&
    !/[^A-Za-z0-9_.]/.test(input) && !input.endsWith('.') && !input.includes('..')
}

/** CDP is a local browser connection, never an arbitrary network or credential URL. */
export function validateBrowserAttachEndpoint(input) {
  const invalid = () => { throw new Error('CDP endpoint 必须是带端口的本机 loopback HTTP 或 browser WebSocket 地址') }
  if (typeof input !== 'string' || input.length === 0 || input.length > 512 || /\s/.test(input)) return invalid()
  // Inspect the raw authority/path before URL() can normalize short IPv4, ports or dot segments.
  const match = /^(http|ws):\/\/(127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})(.*)$/i.exec(input)
  if (!match || Number(match[3]) < 1 || Number(match[3]) > 65535) return invalid()
  if (match[1].toLowerCase() === 'http') {
    if (match[4] !== '' && match[4] !== '/') return invalid()
  } else if (!/^\/devtools\/browser\/[A-Za-z0-9_-]{1,256}$/.test(match[4])) return invalid()
  let url
  try { url = new URL(input) } catch { return invalid() }
  if (url.username || url.password || url.search || url.hash || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return invalid()
  return input
}

/** Attachment selects an existing exact LIVE tab; handles and profile/login URLs are not navigated. */
export function parseTikTokAttachPage(input) {
  const invalid = () => { throw new Error('pageUrl 必须是当前已打开的 https://www.tiktok.com/@账号/live 直播页面') }
  if (typeof input !== 'string' || input.length === 0 || input.length > 512 || /\s/.test(input)) return invalid()
  const match = /^https:\/\/www\.tiktok\.com\/@([^/]+)\/live\/?$/.exec(input)
  if (!match || !isTikTokUsername(match[1])) return invalid()
  let url
  try { url = new URL(input) } catch { return invalid() }
  if (url.protocol !== 'https:' || url.hostname !== 'www.tiktok.com' || url.port || url.username || url.password || url.search || url.hash) return invalid()
  return { username: match[1], url: `https://www.tiktok.com/@${match[1]}/live` }
}

const assistantSchemas = {
  state: object(account), 'context-get': object(account),
  'storage-status': object(account), 'storage-backup': object(account),
  'policy-fields': object(account), 'policy-get': object(account),
  'reply-policy-get':object(account),
  'reply-policy-save':object({...account,expectedRevision:integer(1),policy:replyPolicy,requestId:id,requireStopped:{type:'boolean'}},['accountId','expectedRevision','policy']),
  'reply-generate':object({...account,rowId:id,requestId:id}),
  'policy-save': object({...account,expectedRevision:integer(),policy,requireStopped:{type:'boolean'}},['accountId','expectedRevision','policy']),
  'policy-simulate': object({...account,rowId:id,policy},['accountId','rowId']),
  'audience-tag': object({...account,audienceUuid:id,expectedRevision:integer(),countryCode:{anyOf:[{type:'string',pattern:'^[A-Z]{2}$'},{type:'null'}]},note:text(300)},['accountId','audienceUuid','expectedRevision','countryCode']),
  'attention-defer': object({...account,rowId:id,requestId:id}),
  'attention-window': object({...account,windowId:id,cursor:text(2048),limit:integer(1,200)},['accountId','windowId']),
  'attention-countdown': object({...account,windowId:id,paused:{type:'boolean'}}),
  'message-batches': object({...account,sessionId:id,sliceSeconds:integer(60,3600),cursor:text(2048),limit:integer(1,200)},['accountId']),
  'message-batch': object(batchFilter,['accountId','batchId']),
  'message-batch-read': object({...account,batchId:id,read:{type:'boolean'}}),
  'context-save': object({...account, expectedRevision: integer(), context,requireStopped:{type:'boolean'}},['accountId','expectedRevision','context']),
  start: object({...account, platform: id, requestId: id}, ['accountId']), stop: object(account),
  timeline: object(filter,['accountId']), audience: object(filter,['accountId']), sessions: object(filter,['accountId']), segments: object(filter,['accountId']),
  'segment-toggle': object({...account,requestId:id,runId:id,label:text(100),sessionId:id,expectedOpenSegmentId:{anyOf:[id,{type:'null'}]}},['accountId']),
  'segment-rename': object({...account,segmentId:id,name:{...text(100),minLength:1}}),
  'segment-summary': object({...account,segmentId:id}),
  'reply-update': object({...account,rowId:id,text:{...text(1000),minLength:1}}),
  'reply-translate': object({...account,rowId:id,chinese:{...text(1000),minLength:1},targetLanguage:{...text(100),minLength:1},requestId:id},['accountId','rowId','chinese','requestId']),
  'reply-approve': object({...account,rowId:id,expectedText:{...text(1000),minLength:1},requestId:id}),
  'reply-dismiss': object({...account,rowId:id}), 'translate-retry': object({...account,rowId:id}),
  'attention-pin': object({...account,rowId:id,pinned:{type:'boolean'},expectedPinRevision:integer(1)},['accountId','rowId','pinned']),
  'attention-clear': object({...account,scope:{enum:['all','expired']},requestId:id},['accountId','requestId']),
  'identity-link': object({...account,audienceUuid:id,targetUuid:id}), 'identity-unlink': object({...account,audienceUuid:id}),
  'test-send': object({...account,requestId:id,text:{...text(100),minLength:1}},['accountId','requestId']),
  recording: object({...account,recordingAction:{enum:['status','start','stop']}}),
}
const platformSchemas = {
  state: object(account), 'open-login': object(account),
  'set-target': object({...account,sessionId:id,target:{...text(512),minLength:1}}),
  'qr-preview': object({...account,sessionId:id}),
  'attach-browser': object({...account,endpoint:{...text(512),minLength:1},pageUrl:{...text(512),minLength:1}}),
  'attach-existing-browser': object({...account,pageUrl:{...text(512),minLength:1}}),
}
const summaries = {
  state:'助播状态与最多200条最近记录', 'context-get':'读取知识与三档回复配置', 'context-save':'按revision保存知识与回复配置，不启动采集',
  'policy-fields':'列出实际已支持的观众筛选字段、来源、未知值语义和范围；textScript的可用文字代码与中文名称来自scripts目录，textEvidenceScore是10/25/50规则强度；个人IP、性别、年龄当前不可得',
  'policy-get':'读取账号观众优先级规则和revision；先读再修改，同一规则全部条件满足才命中',
  'policy-save':'凭expectedRevision保存观众筛选规则与30..3600秒归档窗口；只改变本地分层/队列及选定欢迎，不开启AI或公开回复；建议先simulate',
  'policy-simulate':'对已有真实rowId预演规则，返回每条条件及缺失原因；不保存、不调用模型、不发送。文字线索强度不是概率，不能确定国家、国籍或居住地',
  'audience-tag':'对稳定audienceUuid人工设置或清除地区标签，countryCode为ISO两字码或null，需当前tagRevision；新标签revision0。不能按昵称猜性别或自动确认国籍',
  'attention-defer':'将当前未处理观众动作或评论暂缓120秒，必须requestId；保留记录和图钉，不生成或发送',
  'attention-window':'分页查看一个已归档待处理时间窗；windowId由assistant_state.attention.window返回。保留原始事实、不删除、不触发AI',
  'attention-countdown':'暂停或恢复本场当前待处理批次倒计时；须传state返回的当前windowId和paused布尔值。暂停期间继续采集及原有AI，当前普通待处理和新消息不会因时间自动归档；恢复继续剩余时间，保留真实消息时间与队列。重复同状态幂等，停止后不可修改',
  'message-batches':'分页查询全事件存档：sliceSeconds=60..3600 按时间切片，省略时读取原1000条批次。筛选不改变全量事实，采集继续；批次ID来自返回items',
  'message-batch':'在整个归档批次按事件、规则优先级、消费等级、粉丝团等级或粉丝数筛选并分页阅读，每页最多200条；未知属性不满足门槛。不生成、发送或修改待回复记录',
  'message-batch-read':'将归档批次显式标记已读或未读，仅追加本地审计记录，不删除消息、不清空待回复、不停止采集。重复相同状态幂等',
  start:'开始助播及原始数据采集，沿用已登录浏览器与已选直播间', stop:'停止助播并排空持久记录',
  timeline:'SQL分页查询原文、中文、回复与发送审计；支持完整用户名mentionHandle（可带@，忽略大小写）和完整昵称nickname精确匹配；同名不代表同一人', audience:'按已知等级与稳定身份查询观众资料；支持完整用户名与昵称，匹配记录不自动关联身份', sessions:'查询助播场次',
  'storage-status':'读取正式助播SQLite数据库和每日备份状态；不读取JSON恢复，不触发新备份',
  'storage-backup':'在固定本机目录生成并校验SQLite一致备份；不接受外部路径，不停止采集或发送消息',
  segments:'查询已有片段历史', 'segment-toggle':'给当前实际 OBS 节目机位的独立录像添加一个章节，已替换旧片段起止；须先开始双路录像，不要求采集。建议传 runId 和 requestId 防串批次与重复，label 可写补货或观众问题；不会同时写另一机位',
  'segment-rename':'事后给片段命名', 'segment-summary':'统计片段关注、礼物和人数快照',
  'reply-update':'编辑审核中的回复草稿', 'reply-approve':'确认当前草稿并发送，必须expectedText和requestId',
  'reply-policy-get':'读取待处理工作区动作回复策略。五种动作，按观众规则标签或优先级筛选。',
  'reply-policy-save':'CAS保存可编辑的动作知识与引导；关闭/手动/逐条确认/自动四档。仅工作区准入事件生成回复，自动模式会公开发送，未知事实仍须确认。',
  'reply-generate':'对当前采集的选中动作手动生成AI回复并保留到待处理工作区，支持评论/进入/关注/礼物/点赞，requestId幂等；生成后须确认发送。',
  'reply-translate':'将人工中文回复翻译为当前观众语言，只保存待审核草稿并消耗AI额度；必须requestId，绝不直接发送',
  'reply-dismiss':'完成处理此条观众动作或放弃评论回复；仅保存处理状态，不发送', 'translate-retry':'手动请求AI翻译，消耗本场额度；网页译文或 Chrome 本地翻译模式下先留待处理，只翻译，不生成或发送回复',
  'attention-pin':'将本场未处理的任意观众动作或评论钉住，保留直到取消、处理或场次结束；取消可传expectedPinRevision保护后来的人工决定。不生成或发送回复',
  'attention-clear':'清空待处理回复或仅清理过期记录，保留原始历史与审计；取消相关AI任务，跳过已开始发送的回复，必须requestId',
  'identity-link':'用户明确确认同一人后人工关联UUID，不按昵称自动关联', 'identity-unlink':'解除人工身份关联，保留历史来源',
  'test-send':'明确发送一条有界测试弹幕，公开动作，必须requestId；不要循环调用',
  recording:'OBS录像status/start/stop，保存到本机场次，不开始直播',
}
const platformNames = {state:'platform_session_status','open-login':'platform_login_open','set-target':'platform_room_set','qr-preview':'platform_login_qr','attach-browser':'platform_browser_attach','attach-existing-browser':'platform_existing_browser_attach'}
const platformDescriptions = {
  state:'读取已有账号浏览器的登录和房间状态，不返回 cookie',
  'open-login':'打开 OBA 独立登录窗口；账号已连接浏览器时复用，未连接时新建窗口，人工完成登录',
  'set-target':'登录后应用 TikTok 直播间，复用同一账号浏览器；监听中拒绝切换',
  'qr-preview':'读取登录页当前实际可见的二维码，人工扫码；不操作凭据',
  'attach-browser':'通过指定本机 CDP endpoint 接入已登录 Chrome 的直播页；不导航、不复制凭据、不关闭用户浏览器',
  'attach-existing-browser':'读取本机 Chrome 调试描述，接入指定的已登录 TikTok LIVE 标签页；无需手填 endpoint，同一已连接房间直接复用，不新建浏览器、不导航、不返回凭据。Chrome 首次可能需要人工允许连接',
}
export const DESK_TOOLS = [
  ...Object.entries(assistantSchemas).map(([action,inputSchema])=>({name:`assistant_${action.replaceAll('-','_')}`,description:`${summaries[action]}。回复off/review/auto；默认off。AI测试默认30次，达到上限暂停AI但继续记录；未知等级/金币保持未知。所有接口由应用主进程统一处理。`,inputSchema})),
  ...Object.entries(platformSchemas).map(([action,inputSchema])=>({name:platformNames[action],description:platformDescriptions[action],inputSchema})),
]
export function deskToolRoute(name) {
  const tool = DESK_TOOLS.find(tool=>tool.name===name)
  if(!tool)return undefined
  const platform = Object.entries(platformNames).find(([,value])=>value===name)
  return {path:platform?'/platform/session/command':'/assistant/command',action:platform?.[0]??name.slice(10).replaceAll('_','-'),tool}
}
function matches(value,schema) {
  if(schema.anyOf)return schema.anyOf.some(choice=>matches(value,choice))
  if(schema.enum && !schema.enum.includes(value))return false
  if(schema.type==='object'){
    if(!value||typeof value!=='object'||Array.isArray(value)||(schema.required??[]).some(key=>!Object.hasOwn(value,key)))return false
    return Object.keys(value).every(key=>Object.hasOwn(schema.properties,key)&&matches(value[key],schema.properties[key]))
  }
  if(schema.type==='string')return typeof value==='string'&&value.length>=(schema.minLength??0)&&value.length<=(schema.maxLength??Infinity)&&(!schema.pattern||new RegExp(schema.pattern).test(value))&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
  if(schema.type==='array')return Array.isArray(value)&&value.length>=(schema.minItems??0)&&value.length<=(schema.maxItems??Infinity)&&value.every(item=>matches(item,schema.items))
  if(schema.type==='null')return value===null
  if(schema.type==='integer')return Number.isSafeInteger(value)&&value>=schema.minimum&&value<=schema.maximum
  if(schema.type==='boolean')return typeof value==='boolean'
  return true
}
function bounded(value) {
  const stack=[{value,depth:0}];let nodes=0
  while(stack.length){const item=stack.pop();if(++nodes>10000||item.depth>10)throw new Error('请求超过结构上限')
    if(item.value&&typeof item.value==='object')for(const key of Object.keys(item.value)){
      if(['__proto__','prototype','constructor'].includes(key))throw new Error('请求包含不安全字段')
      stack.push({value:item.value[key],depth:item.depth+1})
    }
  }
  if(new TextEncoder().encode(JSON.stringify(value)).byteLength>128*1024)throw new Error('请求超过128KiB')
}
export function validateDeskTool(name,args) {
  const route=deskToolRoute(name);if(!route)throw new Error('助播工具不存在')
  bounded(args);if(!matches(args,route.tool.inputSchema))throw new Error('助播参数不符合schema，请检查类型、范围与必填字段')
  if(route.action==='attention-pin'&&args.expectedPinRevision!==undefined&&args.pinned!==false)throw new Error('expectedPinRevision仅用于取消已有钉住')
  if(route.action==='segment-toggle'&&(Object.hasOwn(args,'sessionId')||Object.hasOwn(args,'expectedOpenSegmentId')))throw new Error('打点入口已改为录像章节，不再接受旧片段起止参数；请刷新界面')
  if(route.action==='attach-browser'||route.action==='attach-existing-browser') {
    if(route.action==='attach-browser')validateBrowserAttachEndpoint(args.endpoint)
    parseTikTokAttachPage(args.pageUrl)
  }
  return {path:route.path,command:route.path.startsWith('/platform/')?{action:route.action,...args}:{action:route.action,params:args}}
}
export function validateDeskHttp(path,body) {
  bounded(body)
  if(!body||typeof body!=='object'||Array.isArray(body)||typeof body.action!=='string')throw new Error('助播命令无效')
  if(path==='/assistant/command'){
    if(Object.keys(body).some(key=>!['action','params'].includes(key)))throw new Error('助播命令包含额外字段')
    return validateDeskTool(`assistant_${body.action.replaceAll('-','_')}`,body.params).command
  }
  const {action,...args}=body
  const name=platformNames[action];if(!name)throw new Error('账号会话命令无效')
  return validateDeskTool(name,args).command
}
