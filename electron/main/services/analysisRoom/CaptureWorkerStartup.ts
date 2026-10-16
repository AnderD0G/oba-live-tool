import {types} from 'node:util'
import type {CaptureWorkerStartup} from './CaptureWorkerProtocol'
import {CaptureDatabaseError,preflightCaptureValue,validateCaptureIdentity} from './CaptureWorkerProtocol'
import {validateCaptureStorageLimits} from './CaptureStorage'
import type {TypedStageBinding} from './CaptureTypedStageSchema'
import type {CaptureProtocolContextV2,CaptureWorkerModeV2} from './CaptureWorkerProtocolV2'
export type BridgeStartup=CaptureWorkerStartup|{version:2;file:string;identity:CaptureWorkerStartup['identity'];limits:CaptureWorkerStartup['limits'];mode:'existing';workerMode:CaptureWorkerModeV2;binding?:TypedStageBinding}
export function normalizeBridgeStartup(value:unknown):BridgeStartup{
 const walk=(v:unknown,depth=0):void=>{if(depth>8)throw new CaptureDatabaseError('INVALID_REQUEST');if(v===null||['string','number','boolean','undefined'].includes(typeof v))return;if(!v||typeof v!=='object'||types.isProxy(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v))||Reflect.ownKeys(v).length>64)throw new CaptureDatabaseError('INVALID_REQUEST');for(const key of Reflect.ownKeys(v)){const d=Object.getOwnPropertyDescriptor(v,key)!;if(typeof key!=='string'||!d.enumerable||!('value'in d))throw new CaptureDatabaseError('INVALID_REQUEST');walk(d.value,depth+1)}}
 walk(value);preflightCaptureValue(value,8192);const s=value as BridgeStartup
 if(s.version===1){if(!['create','existing'].includes(s.mode))throw new CaptureDatabaseError('INVALID_REQUEST');return{version:1,file:s.file,identity:validateCaptureIdentity(s.identity),limits:validateCaptureStorageLimits(s.limits),mode:s.mode}}
 if(s.version!==2||s.mode!=='existing'||!['typed-stage','live-control'].includes(s.workerMode))throw new CaptureDatabaseError('INVALID_REQUEST')
 const expected=['version','file','identity','limits','mode','workerMode',...(s.workerMode==='typed-stage'?['binding']:[])];if(Reflect.ownKeys(s).length!==expected.length||Object.keys(s).some(k=>!expected.includes(k)))throw new CaptureDatabaseError('INVALID_REQUEST')
 const identity=validateCaptureIdentity(s.identity),limits=validateCaptureStorageLimits(s.limits)
 if(s.workerMode==='typed-stage'&&(!s.binding||JSON.stringify(validateCaptureIdentity(s.binding.identity))!==JSON.stringify(identity)||JSON.stringify(validateCaptureStorageLimits(s.binding.limits))!==JSON.stringify(limits)))throw new CaptureDatabaseError('INVALID_REQUEST')
 return structuredClone({...s,identity,limits})
}
export function bridgeContext(s:BridgeStartup):CaptureProtocolContextV2{if(s.version!==2)throw new CaptureDatabaseError('INVALID_REQUEST');return s.workerMode==='typed-stage'?{mode:s.workerMode,identity:s.identity,limits:s.limits,runId:s.binding!.runId}:{mode:s.workerMode,identity:s.identity,limits:s.limits}}
