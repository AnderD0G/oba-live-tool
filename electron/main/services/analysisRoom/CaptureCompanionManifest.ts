import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { types } from 'node:util'
import { readLegacySource, type LegacyReadEvent, type LegacySourceEntry, type LegacySourceIdentity } from './CaptureLegacyReader'

const PRIMARY='interaction-routing.json'
const DEFAULTS=Object.freeze({maxFamilyFiles:1000,maxFamilyBytes:5*1024**3,maxFileBytes:16*1024**2,maxChunkBytes:65536})
type Limits=typeof DEFAULTS
type Code='COMPANION_INPUT_INVALID'|'COMPANION_HANDLE_INVALID'|'COMPANION_UNSAFE_SOURCE'|'COMPANION_CHANGED'|'COMPANION_LIMIT'|'COMPANION_ABORTED'
export class CaptureCompanionError extends Error {
  constructor(readonly code:Code) { super(code) }
}
export interface RoutingCompanionOptions {
  maxFamilyFiles?:number;maxFamilyBytes?:number;maxFileBytes?:number;maxChunkBytes?:number;signal?:AbortSignal
}
export interface RoutingCompanionEntry extends LegacySourceEntry {
  rootKind:'interaction-routing-family';role:'primary'|'tmp'|'backup'|'unknown'
}
export interface RoutingCompanionManifest {
  kind:'interaction-routing-family';version:1;primaryStatus:'present'|'absent'|'missing-with-alternates'
  rootIdentity:{dev:string;ino:string};entries:RoutingCompanionEntry[];familyBytes:number;digest:string;peakBufferedBytes:number
}
/** Opaque, process-local inventory capability; serialized manifests confer no file access. */
export interface RoutingCompanionSnapshot { readonly kind:'routing-companion-snapshot' }
interface Owned { root:string;physical:string;manifest:RoutingCompanionManifest;limits:Limits }
const snapshots=new WeakMap<object,Owned>()
function fail(code:Code):never {throw new CaptureCompanionError(code)}
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex')
const nativeAbortGetter=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted')!.get!
const abort=(signal?:AbortSignal)=>{if(signal!==undefined&&nativeAbortGetter.call(signal))fail('COMPANION_ABORTED')}
const fold=(value:string)=>process.platform==='win32'?value.toLowerCase():value
const family=(name:string)=>fold(name)===PRIMARY||fold(name).startsWith(PRIMARY+'.')
const identity=(s:BigIntStats):LegacySourceIdentity=>({dev:String(s.dev),ino:String(s.ino),nlink:String(s.nlink),size:String(s.size),mtimeNs:String(s.mtimeNs),ctimeNs:String(s.ctimeNs),birthtimeNs:String(s.birthtimeNs)})
const same=(a:LegacySourceIdentity,b:LegacySourceIdentity)=>JSON.stringify(a)===JSON.stringify(b)
function regular(s:BigIntStats) {
  if(s.isSymbolicLink()||!s.isFile()||s.nlink!==1n)fail('COMPANION_UNSAFE_SOURCE')
}
function options(input:unknown):{limits:Limits;signal?:AbortSignal} {
  if(input===undefined)return {limits:{...DEFAULTS}}
  if(!input||typeof input!=='object'||types.isProxy(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))fail('COMPANION_INPUT_INVALID')
  const result:{limits:Limits;signal?:AbortSignal}={limits:{...DEFAULTS}}
  for(const key of Reflect.ownKeys(input)) {
    if(typeof key!=='string'||!['signal',...Object.keys(DEFAULTS)].includes(key))fail('COMPANION_INPUT_INVALID')
    const d=Object.getOwnPropertyDescriptor(input,key)!
    if(!d.enumerable||!('value'in d))fail('COMPANION_INPUT_INVALID')
    if(key==='signal') {
      if(d.value!==undefined&&(types.isProxy(d.value)||!(d.value instanceof AbortSignal)))fail('COMPANION_INPUT_INVALID')
      if(d.value!==undefined)try{nativeAbortGetter.call(d.value)}catch{fail('COMPANION_INPUT_INVALID')}
      result.signal=d.value
    } else {
      const k=key as keyof Limits,v=d.value
      if(typeof v!=='number'||!Number.isSafeInteger(v)||v<1||v>DEFAULTS[k])fail('COMPANION_LIMIT')
      ;(result.limits as Record<keyof Limits,number>)[k]=v
    }
  }
  return result
}
async function root(input:string) {
  if(typeof input!=='string'||!isAbsolute(input)||input.includes('\0')||Buffer.byteLength(input)>4096)fail('COMPANION_INPUT_INVALID')
  const lexical=resolve(input),base=parse(lexical).root
  let current=base
  for(const part of ['',...relative(base,lexical).split(sep).filter(Boolean)]) {
    if(part)current=join(current,part)
    const s=await lstat(current,{bigint:true})
    if(s.isSymbolicLink()||!s.isDirectory())fail('COMPANION_UNSAFE_SOURCE')
  }
  const physical=await realpath(lexical),s=await lstat(physical,{bigint:true})
  if(s.isSymbolicLink()||!s.isDirectory())fail('COMPANION_UNSAFE_SOURCE')
  return {lexical,physical,rootIdentity:{dev:String(s.dev),ino:String(s.ino)}}
}
function convert(error:unknown):never {
  if(error instanceof CaptureCompanionError)throw error
  const code=(error as {code?:unknown})?.code
  if(code==='ABORTED')fail('COMPANION_ABORTED')
  if(code==='UNSAFE_PATH'||code==='LINK_REJECTED'||code==='SOURCE_TYPE')fail('COMPANION_UNSAFE_SOURCE')
  if(code==='READ_LIMIT')fail('COMPANION_LIMIT')
  fail('COMPANION_CHANGED')
}
async function members(physical:string,limits:Limits,signal?:AbortSignal):Promise<Map<string,LegacySourceIdentity>> {
  const result=new Map<string,LegacySourceIdentity>(),dir=await opendir(physical,{bufferSize:32})
  let bytes=0
  try {
    while(true) {
      abort(signal);const entry=await dir.read();if(!entry)break
      // Only inspect same-family files. Other appData trees and file bytes are excluded.
      if(!family(entry.name))continue
      if(Buffer.byteLength(entry.name)>4096||entry.name.includes('\0'))fail('COMPANION_UNSAFE_SOURCE')
      const s=await lstat(join(physical,entry.name),{bigint:true});regular(s)
      const size=Number(s.size)
      if(!Number.isSafeInteger(size)||size<0||size>limits.maxFileBytes)fail('COMPANION_LIMIT')
      bytes+=size
      if(result.size>=limits.maxFamilyFiles||!Number.isSafeInteger(bytes)||bytes>limits.maxFamilyBytes)fail('COMPANION_LIMIT')
      result.set(entry.name,identity(s))
    }
  } finally {await dir.close()}
  return result
}
const sortedMembers=(m:Map<string,LegacySourceIdentity>)=>[...m.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0)
async function fileHash(physical:string,name:string,expected:LegacySourceIdentity,limits:Limits,signal?:AbortSignal) {
  const path=join(physical,name),s=await lstat(path,{bigint:true});regular(s)
  if(!same(identity(s),expected))fail('COMPANION_CHANGED')
  const handle=await open(path,'r')
  try {
    const opened=await handle.stat({bigint:true});regular(opened)
    if(!same(identity(opened),expected))fail('COMPANION_CHANGED')
    const hash=createHash('sha256'),buffer=Buffer.alloc(limits.maxChunkBytes)
    let offset=0
    while(offset<Number(expected.size)) {
      abort(signal)
      const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,Number(expected.size)-offset),offset)
      if(!bytesRead)fail('COMPANION_CHANGED')
      hash.update(buffer.subarray(0,bytesRead));offset+=bytesRead
    }
    const after=await handle.stat({bigint:true}),named=await lstat(path,{bigint:true});regular(after);regular(named)
    if(!same(identity(after),expected)||!same(identity(named),expected))fail('COMPANION_CHANGED')
    return hash.digest('hex')
  } finally {await handle.close()}
}
/** Verified per-file snapshot, bounded fixed family inventory; not an atomic application snapshot. */
export async function snapshotRoutingCompanion(trustedAppData:string,input?:RoutingCompanionOptions):Promise<RoutingCompanionSnapshot> {
  try {
    const {limits,signal}=options(input);abort(signal)
    const checked=await root(trustedAppData),before=await members(checked.physical,limits,signal),entries:RoutingCompanionEntry[]=[]
    let familyBytes=0
    for(const [name,expected]of sortedMembers(before)) {
      const hash=await fileHash(checked.physical,name,expected,limits,signal),n=fold(name)
      entries.push({rootKind:'interaction-routing-family',relativePath:name,size:Number(expected.size),sha256:hash,identity:{...expected},rootIdentity:{...checked.rootIdentity},role:n===PRIMARY?'primary':n===PRIMARY+'.tmp'?'tmp':n.endsWith('.bak')?'backup':'unknown',inventoryMetrics:{directoryBufferSize:32,peakOpenDirectories:1,peakOpenFiles:1}})
      familyBytes+=Number(expected.size)
    }
    const after=await members(checked.physical,limits,signal),end=await root(trustedAppData)
    if(JSON.stringify(sortedMembers(before))!==JSON.stringify(sortedMembers(after))||JSON.stringify(end.rootIdentity)!==JSON.stringify(checked.rootIdentity)||fold(end.physical)!==fold(checked.physical))fail('COMPANION_CHANGED')
    abort(signal)
    const primaryStatus=entries.some(x=>x.role==='primary')?'present':entries.length?'missing-with-alternates':'absent'
    const content={kind:'interaction-routing-family' as const,version:1 as const,primaryStatus,rootIdentity:{...checked.rootIdentity},entries,familyBytes}
    const manifest:RoutingCompanionManifest={...content,primaryStatus,digest:sha(JSON.stringify(content)),peakBufferedBytes:entries.length?limits.maxChunkBytes:0}
    const token=Object.freeze({kind:'routing-companion-snapshot' as const})
    snapshots.set(token,{root:checked.lexical,physical:checked.physical,manifest,limits})
    return token
  } catch(error) {return convert(error)}
}
function owned(snapshot:unknown,inputRoot?:string):Owned {
  if(!snapshot||typeof snapshot!=='object'||types.isProxy(snapshot))fail('COMPANION_HANDLE_INVALID')
  const o=snapshots.get(snapshot)
  if(!o||inputRoot!==undefined&&(typeof inputRoot!=='string'||fold(resolve(inputRoot))!==fold(o.root)))fail('COMPANION_HANDLE_INVALID')
  return o
}
export function routingCompanionManifest(snapshot:unknown):RoutingCompanionManifest {
  return structuredClone(owned(snapshot).manifest)
}
/** Rehashes every fixed-family member and checks membership, including alternate evidence. */
export async function verifyRoutingCompanionSnapshot(trustedAppData:string,snapshot:unknown):Promise<void> {
  const previous=owned(snapshot,trustedAppData),fresh=await snapshotRoutingCompanion(trustedAppData,previous.limits)
  if(owned(fresh).manifest.digest!==previous.manifest.digest)fail('COMPANION_CHANGED')
}
/** Private literal byte stream from exactly one previously checked companion source. */
export async function* readRoutingCompanionSource(trustedAppData:string,snapshot:unknown,name:string):AsyncGenerator<LegacyReadEvent> {
  const o=owned(snapshot,trustedAppData)
  if(typeof name!=='string'||!family(name)||name.includes('/')||name.includes('\\')||name.includes('\0')||name.includes(':'))fail('COMPANION_INPUT_INVALID')
  const entry=o.manifest.entries.find(x=>x.relativePath===name)
  if(!entry)fail('COMPANION_INPUT_INVALID')
  try {
    yield* readLegacySource(o.root,entry,{chunkBytes:o.limits.maxChunkBytes})
  } catch(error) {convert(error)}
}
