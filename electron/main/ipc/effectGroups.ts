import path from 'node:path'
import {existsSync,readFileSync} from 'node:fs'
import {app} from 'electron'
import type {AssistantAudiencePolicy} from '../../../shared/assistantAudiencePolicy'
import type {AssistantDeskRow} from '../../../shared/assistantDesk'
import type {EffectActionKind,EffectGroupCommand} from '../../../shared/effectGroups'
import {EffectGroupError} from '../../../shared/effectGroups'
import {validateEffectGroupHttp} from '../../../shared/effectGroupsContract.mjs'
import {IPC_CHANNELS} from '../../../shared/ipcChannels'
import {EffectGroupStore} from '../services/effectGroups/EffectGroupStore'
import {EffectGroupService} from '../services/effectGroups/EffectGroupService'
import {ObsEffectGroupPlayer} from '../services/effectGroups/ObsEffectGroupPlayer'
import {ObsWebSocketClient} from '../services/ObsWebSocketClient'
import {typedIpcMainHandle} from '../utils/ipc'
import {getAssistantDesk,registerAudienceEffectSync} from './assistantDesk'
import {getObsEffectLedger} from './obsEffect'
import {registerEffectGroupsBridge} from './hooks'
import {mediaDurationProbe} from '../services/effectGroups/mediaDurationProbe'

let store:EffectGroupStore|undefined,service:EffectGroupService|undefined,client:ObsWebSocketClient|undefined
let sequence=0,registered=false
let closing=false,shutdownPromise:Promise<void>|undefined
export function nextEffectSequence(){return ++sequence}
export function getEffectGroupService(){
  if(closing)throw new EffectGroupError('EFFECT_GROUP_STOPPED','Effect groups are shutting down')
  if(service)return service
  store=new EffectGroupStore(path.join(app.getPath('userData'),'effect-groups.sqlite'))
  client=new ObsWebSocketClient(undefined,false)
  const transport=client,authority=store
  const connection=()=>{
    const saved=path.join(app.getPath('userData'),'obs-enter-effect.json')
    if(existsSync(saved))return getObsEffectLedger().data
    const obsFile=path.join(app.getPath('appData'),'obs-studio/plugin_config/obs-websocket/config.json')
    if(!existsSync(obsFile))return getObsEffectLedger().data
    const observed=JSON.parse(readFileSync(obsFile,'utf8'))
    return {url:`ws://127.0.0.1:${observed.server_port}`,password:observed.auth_required?String(observed.server_password??''):''}
  }
  const probeCandidates=[process.env.OBA_FFPROBE,path.join(app.getPath('home'),'Desktop/voice/runtime/ffmpeg/ffprobe.exe'),'ffprobe'].filter((item):item is string=>!!item)
  const executable=probeCandidates.find(item=>existsSync(item))??'ffprobe'
  const player=new ObsEffectGroupPlayer({client:transport,installId:authority.installId,
    overlayBaseUrl:()=>{
      const endpoint=path.join(app.getPath('userData'),'director-api.json')
      return existsSync(endpoint)?JSON.parse(readFileSync(endpoint,'utf8')).url:'http://127.0.0.1:17892/'
    },
    connect:()=>{const settings=connection();return transport.connect(settings.url,settings.password)},
    durationProbe:mediaDurationProbe(executable),
    onResource:resource=>{
      if(authority.listRetirements(resource.accountId).some(item=>item.groupId===resource.groupId&&item.generation===resource.generation))resource.state='retiring'
      authority.saveResource(resource)
    },
  })
  service=new EffectGroupService({store:authority,player,nextSequence:nextEffectSequence,
    getAudiencePolicy:async accountId=>{
      const result=await getAssistantDesk().execute({action:'policy-get',params:{accountId}})
      if(!result.ok)throw new Error(result.error.message)
      return result.data as AssistantAudiencePolicy
    },onError:error=>console.error('Rule effect group:',error instanceof Error?error.message:String(error)),
  })
  return service
}
export function ownsEffectAction(accountId:string,action:EffectActionKind){
  if(closing)return true
  const config=store?.get(accountId)
  return !!config?.enabled&&config.groups.some(group=>group.enabled&&group.actionKind===action)
}
/** Audience rule edits reconcile only their existing owned tag/action groups. */
export async function syncAudienceEffectGroups(accountId:string){
  const instance=getEffectGroupService()
  const current=await instance.command({action:'get',params:{accountId}}) as {config:{enabled:boolean;revision:number}}
  if(!current.config.enabled)return
  await instance.command({action:'sync',params:{accountId,revision:current.config.revision,requestId:`audience-change-${Date.now()}-${nextEffectSequence()}`}})
}
export async function executeEffectGroupCommand(input:EffectGroupCommand){
  try{return {ok:true as const,data:await getEffectGroupService().command(validateEffectGroupHttp(input) as EffectGroupCommand)}}
  catch(error){return {ok:false as const,error:{code:(error as {code?:string})?.code??'EFFECT_GROUP_FAILED',message:error instanceof Error?error.message:String(error)}}}
}
export async function dispatchPersistedEffect(row:AssistantDeskRow,eventSequence:number){
  if(closing)return {handled:true}
  if(!['enter','like','follow','gift'].includes(row.kind)||!row.userId||!row.triage)return {handled:false}
  if(row.kind==='gift'&&(!row.gift?.final||!row.gift.contributed))return {handled:ownsEffectAction(row.accountId,'gift')}
  return getEffectGroupService().dispatchObserved({accountId:row.accountId,eventId:row.id,actionKind:row.kind as EffectActionKind,
    userId:row.userId,displayName:row.nickname,receivedAt:row.receivedAt,sequence:eventSequence,triage:row.triage,persisted:true,
    facts:{sourceEventId:row.sourceEventId,sessionId:row.sessionId,payLevel:row.payLevel,fansClubLevel:row.fansClubLevel,followerCount:row.followerCount,gift:row.gift},})
}
export function shutdownEffectGroups():Promise<void>{
  if(shutdownPromise)return shutdownPromise
  closing=true
  const instance=service,transport=client,authority=store
  shutdownPromise=(async()=>{
    if(!instance)return
    await instance.stop()
    await transport?.disconnect()
    authority?.close();store=undefined;service=undefined;client=undefined
  })()
  return shutdownPromise
}
export function setupEffectGroupIpc(){
  if(closing||registered)return;registered=true
  typedIpcMainHandle(IPC_CHANNELS.effectGroups.request,(_event,command)=>executeEffectGroupCommand(command))
  registerEffectGroupsBridge({nextSequence:nextEffectSequence,ownsAction:ownsEffectAction,dispatchPersisted:dispatchPersistedEffect})
  registerAudienceEffectSync(syncAudienceEffectGroups)
  // Recovery hides only durable owned resources. It never replays old real events.
  void getEffectGroupService().start().catch(error=>console.error('Effect group recovery:',error instanceof Error?error.message:String(error)))
  // The existing awaited OBS quit barrier calls shutdownEffectGroups; no detached cleanup.
}
