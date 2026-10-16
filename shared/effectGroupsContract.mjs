const string = maxLength => ({type:'string',minLength:1,maxLength,pattern:'^[^\\x00-\\x1f\\x7f]+$'})
const integer = (minimum,maximum=Number.MAX_SAFE_INTEGER) => ({type:'integer',minimum,maximum})
const object = (properties,required=Object.keys(properties)) => ({type:'object',properties,required,additionalProperties:false})
const array = (items,maxItems,minItems=0) => ({type:'array',items,minItems,maxItems})
const enumValue = values => ({type:'string',enum:values})
const id=string(128), uuid={...id,pattern:'^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'}
const actions=['enter','follow','like','gift'],slots=['main-stage','corner-left','corner-right']
const assets=['pearl','gold','fireworks','petals','orchid','camellia','hearts','ribbon','starlight','halo','google-flower','volcengine-flower','google-zanhua','google-moonlight','ordinary-03','ordinary-09']
const animation=object({assetId:enumValue(assets),placement:enumValue(['border','lower-edge','lower-center','center','corner-left','corner-right','full-screen']),shortAssetEnd:{const:'hold-last-frame'}})
const fields={enabled:{type:'boolean'},slot:enumValue(slots),concurrency:enumValue(['auto','parallel','serialize']),priority:integer(-1000,1000),durationMs:integer(1000,10000),animations:array(animation,3,1),caption:object({template:string(500),style:enumValue(['brief','rainbow'])}),coalesce:enumValue(['same-user-group-latest','none'])}
const group=object({groupId:uuid,audienceRuleId:id,actionKind:enumValue(actions),...fields},['audienceRuleId','actionKind',...Object.keys(fields)])
const ttl=object(Object.fromEntries(actions.map(action=>[action,integer(1000,60000)])),[])
const patch=object({enabled:{type:'boolean'},targetSceneName:string(200),scheduler:object({queueCapacity:integer(1,32),perSlotCapacity:integer(1,16),eventOrder:array(enumValue(actions),4,4),ttlMs:ttl,preemptActive:{const:false}},[]),operations:array({anyOf:[object({op:{const:'upsert'},group}),object({op:{const:'update'},groupId:uuid,changes:object(fields,[])}),object({op:{const:'delete'},groupId:uuid})]},80)},[])
const account={accountId:id}
const schemas={
  get:object(account),catalog:object({...account,targetSceneName:string(200)},['accountId']),
  status:object({...account,groupId:uuid},['accountId']),
  simulate:object({...account,expectedRevision:integer(0),patch,samples:array(object({fixture:{const:true},actionKind:enumValue(actions),matchedRuleId:id,userId:id,displayName:string(140)},['fixture','actionKind','userId','displayName']),30)},['accountId','expectedRevision','patch']),
  apply:object({...account,expectedRevision:integer(0),patch,proof:id,requestId:id}),
  sync:object({...account,revision:integer(0),requestId:id}),
  preview:object({...account,revision:integer(0),groupId:uuid,viewer:object({userId:id,displayName:string(140)}),requestId:id}),
}
const descriptions={get:'读取规则效果组及版本。配置与资源状态分开。',catalog:'读取可用观众规则、动画资源、位置和同步能力，不播放。',simulate:'推演精确 patch，返回15分钟 proof；不播放、不调用模型或公屏发送。',apply:'以原版本和相同 proof/patch 保存。OBS 后台同步，未 ready 不能播放。',sync:'幂等对账已保存资源，只管理本安装的副本，不切节目或开播。',status:'读取活动、排队、清理冲突与有界执行审计。',preview:'在本地 OBS 受控试播保存的组，标记 preview，不发弹幕。'}
export const EFFECT_GROUP_TOOLS=Object.entries(schemas).map(([action,inputSchema])=>({name:`effect_groups_${action}`,description:descriptions[action],inputSchema}))
export function effectGroupToolRoute(name){const action=name?.startsWith('effect_groups_')?name.slice(14):null;return schemas[action]?{action,path:'/effect-groups/command'}:undefined}
function matches(value,schema){
  if(schema.anyOf)return schema.anyOf.some(item=>matches(value,item))
  if(Object.hasOwn(schema,'const')&&value!==schema.const)return false
  if(schema.enum&&!schema.enum.includes(value))return false
  if(schema.type==='object')return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>Object.hasOwn(schema.properties,key)&&matches(value[key],schema.properties[key]))&&schema.required.every(key=>Object.hasOwn(value,key))
  if(schema.type==='array')return Array.isArray(value)&&value.length>=schema.minItems&&value.length<=schema.maxItems&&value.every(item=>matches(item,schema.items))
  if(schema.type==='string')return typeof value==='string'&&value.length>=(schema.minLength??0)&&value.length<=(schema.maxLength??Infinity)&&(!schema.pattern||new RegExp(schema.pattern,'u').test(value))&&value.trim()===value
  if(schema.type==='integer')return Number.isSafeInteger(value)&&value>=schema.minimum&&value<=schema.maximum
  if(schema.type==='boolean')return typeof value==='boolean'
  return true
}
function bounded(value){let count=0;const queue=[{value,depth:0}];while(queue.length){const item=queue.pop();if(++count>10000||item.depth>16)throw new Error('效果组请求过大');if(item.value&&typeof item.value==='object')for(const [key,v]of Object.entries(item.value)){if(['__proto__','constructor','prototype'].includes(key))throw new Error('效果组字段无效');queue.push({value:v,depth:item.depth+1})}}if(new TextEncoder().encode(JSON.stringify(value)).length>128*1024)throw new Error('效果组请求超过128KiB')}
export function validateEffectGroupTool(name,args){const route=effectGroupToolRoute(name);if(!route)throw new Error('未知效果组工具');bounded(args);if(!matches(args,schemas[route.action]))throw new Error('效果组参数不符合类型、范围或必填字段');return {path:route.path,command:{action:route.action,params:args}}}
export function validateEffectGroupHttp(body){if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['action','params'].includes(key)))throw new Error('无效效果组命令');return validateEffectGroupTool(`effect_groups_${body.action}`,body.params).command}
