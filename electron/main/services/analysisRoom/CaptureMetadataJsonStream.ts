import {types} from 'node:util'

const DEFAULTS=Object.freeze({maxBytes:16*1024**2,maxDepth:16,maxScalarBytes:128*1024,maxChunkBytes:64*1024})
export type MetadataJsonLimits={maxBytes:number;maxDepth:number;maxScalarBytes:number;maxChunkBytes:number}
export type MetadataJsonToken=Readonly<{kind:'object-start'|'object-end'|'array-start'|'array-end';startOffset:number;nextOffset:number;depth:number}>
 |Readonly<{kind:'key'|'scalar';value:string|number|boolean|null;literal:string;startOffset:number;nextOffset:number;depth:number}>
export class CaptureMetadataJsonError extends Error {
 constructor(readonly code:'METADATA_JSON_INVALID'|'METADATA_JSON_LIMIT'){super(code)}
}
function fail(code:'METADATA_JSON_INVALID'|'METADATA_JSON_LIMIT'='METADATA_JSON_INVALID'):never {throw new CaptureMetadataJsonError(code)}
function limits(input:unknown):Readonly<MetadataJsonLimits> {
 if(input===undefined)return DEFAULTS
 if(!input||typeof input!=='object'||types.isProxy(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))fail()
 const result:MetadataJsonLimits={...DEFAULTS}
 for(const key of Reflect.ownKeys(input)) {
  if(typeof key!=='string'||!Object.hasOwn(DEFAULTS,key))fail()
  const d=Object.getOwnPropertyDescriptor(input,key)!
  if(!d.enumerable||!('value'in d))fail()
  const k=key as keyof MetadataJsonLimits,v=d.value
  if(typeof v!=='number'||!Number.isSafeInteger(v)||v<1||v>DEFAULTS[k])fail('METADATA_JSON_LIMIT')
  result[k]=v
 }
 return Object.freeze(result)
}
const typedArrayPrototype=Object.getPrototypeOf(Uint8Array.prototype)
const nativeByteLength=Object.getOwnPropertyDescriptor(typedArrayPrototype,'byteLength')!.get!
const EMPTY_INPUT=new Uint8Array(0)
const space=(b:number)=>b===32||b===9||b===10||b===13
const delimiter=(b:number)=>space(b)||[34,44,58,91,93,123,125].includes(b)
type Phase='key-or-end'|'key'|'colon'|'value-or-end'|'value'|'comma-or-end'
interface Frame {kind:'object'|'array';phase:Phase}
interface Scalar {kind:'key'|'string'|'primitive';start:number;length:number;escaped:boolean;depth:number}

/** Private bounded grammar/token stream. It authenticates no file, database or source.
 * Consumers must own read-window/work reservations and verify final completion. */
export class CaptureMetadataJsonStream {
 private readonly bounds:Readonly<MetadataJsonLimits>
 private readonly scalarBuffer:Buffer
 private readonly decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true})
 private readonly stack:Frame[]=[]
 private scalar?:Scalar
 private offset=0
 private rootStarted=false
 private failed=false
 private finished=false
 private feeding=false
 private peakDepth=0
 private peakScalarBytes=0
 private peakChunkBytes=0
 private tokenCount=0
 constructor(input?:unknown) {this.bounds=limits(input);this.scalarBuffer=Buffer.allocUnsafe(this.bounds.maxScalarBytes)}
 private usable() {if(this.failed||this.finished||this.feeding)fail()}
 private value() {
  if(this.stack.length>this.bounds.maxDepth)fail('METADATA_JSON_LIMIT')
  this.peakDepth=Math.max(this.peakDepth,this.stack.length)
  const p=this.stack.at(-1)
  if(!p) {if(this.rootStarted)fail();this.rootStarted=true;return}
  if(p.kind==='object'?p.phase!=='value':!['value','value-or-end'].includes(p.phase))fail()
  p.phase='comma-or-end'
 }
 private append(byte:number) {
  const s=this.scalar!
  if(s.length>=this.bounds.maxScalarBytes)fail('METADATA_JSON_LIMIT')
  this.scalarBuffer[s.length++]=byte
  this.peakScalarBytes=Math.max(this.peakScalarBytes,s.length)
 }
 private scalarToken(nextOffset:number):MetadataJsonToken {
  const s=this.scalar!
  let literal:string,value:string|number|boolean|null
  try {
   literal=this.decoder.decode(this.scalarBuffer.subarray(0,s.length))
   value=JSON.parse(literal)
  } catch {return fail()}
  if(s.kind==='primitive'?(value!==null&&!['number','boolean'].includes(typeof value)):typeof value!=='string')fail()
  if(typeof value==='number'&&!Number.isFinite(value))fail()
  if(s.kind==='key') {
   const p=this.stack.at(-1)
   if(!p||p.kind!=='object'||!['key','key-or-end'].includes(p.phase))fail()
   p.phase='colon'
  }
  this.scalar=undefined
  this.tokenCount++
  return Object.freeze({kind:s.kind==='key'?'key':'scalar',value,literal,startOffset:s.start,nextOffset,depth:s.depth})
 }
 private structural(kind:'object-start'|'object-end'|'array-start'|'array-end'):MetadataJsonToken {
  this.tokenCount++
  return Object.freeze({kind,startOffset:this.offset,nextOffset:this.offset+1,depth:this.stack.length})
 }
 private *byte(byte:number):Generator<MetadataJsonToken> {
  const pending=this.scalar
  if(pending) {
   if(pending.kind==='primitive') {
    if(delimiter(byte))yield this.scalarToken(this.offset)
    else {this.append(byte);return}
   } else {
    if(byte<32)fail()
    const escaped=pending.escaped
    this.append(byte)
    if(!escaped&&byte===34)yield this.scalarToken(this.offset+1)
    else pending.escaped=!escaped&&byte===92
    return
   }
  }
  if(space(byte))return
  const p=this.stack.at(-1)
  if(byte===34) {
   const key=!!p&&p.kind==='object'&&['key','key-or-end'].includes(p.phase)
   if(!key)this.value()
   this.scalar={kind:key?'key':'string',start:this.offset,length:0,escaped:false,depth:this.stack.length}
   this.append(byte);return
  }
  if(byte===123||byte===91) {
   this.value()
   yield this.structural(byte===123?'object-start':'array-start')
   this.stack.push({kind:byte===123?'object':'array',phase:byte===123?'key-or-end':'value-or-end'})
   return
  }
  if(byte===125||byte===93) {
   if(!p||p.kind!==(byte===125?'object':'array')||!['comma-or-end',byte===125?'key-or-end':'value-or-end'].includes(p.phase))fail()
   this.stack.pop();yield this.structural(byte===125?'object-end':'array-end');return
  }
  if(byte===58) {if(!p||p.kind!=='object'||p.phase!=='colon')fail();p.phase='value';return}
  if(byte===44) {if(!p||p.phase!=='comma-or-end')fail();p.phase=p.kind==='object'?'key':'value';return}
  if(byte===45||byte>=48&&byte<=57||byte===116||byte===102||byte===110) {
   this.value()
   this.scalar={kind:'primitive',start:this.offset,length:0,escaped:false,depth:this.stack.length}
   this.append(byte);return
  }
  fail()
 }
 /** Exhaust the returned iterator. Closing it early permanently invalidates this parser. */
 feed(input:Uint8Array):Generator<MetadataJsonToken> {
  const inner=this.feedChunk(input),parser=this
  const next=inner.next.bind(inner),close=inner.return.bind(inner),raise=inner.throw.bind(inner)
  let complete=false
  inner.next=(...args)=>{const result=next(...args);complete=result.done===true;return result}
  inner.return=value=>{if(!complete)parser.failed=true;return close(value)}
  inner.throw=error=>{if(!complete)parser.failed=true;return raise(error)}
  return inner
 }
 private *feedChunk(input:Uint8Array):Generator<MetadataJsonToken> {
  this.usable();let complete=false
  try {
   if(!input||typeof input!=='object'||types.isProxy(input)||![Uint8Array.prototype,Buffer.prototype].includes(Object.getPrototypeOf(input)))fail()
   for(const key of ['byteLength','byteOffset','length','buffer'])if(Object.hasOwn(input,key))fail()
   const size=nativeByteLength.call(input) as number
   if(!size){complete=true;return}
   if(size>this.bounds.maxChunkBytes||this.offset+size>this.bounds.maxBytes)fail('METADATA_JSON_LIMIT')
   const copy=Buffer.allocUnsafe(size);Uint8Array.prototype.set.call(copy,input)
   // A tiny caller view may retain a much larger backing buffer. Release it before yielding.
   input=EMPTY_INPUT
   this.peakChunkBytes=Math.max(this.peakChunkBytes,size)
   this.feeding=true
   for(const byte of copy) {yield* this.byte(byte);this.offset++}
   complete=true
  } catch(error) {this.failed=true;if(error instanceof CaptureMetadataJsonError)throw error;fail()}
  finally {this.feeding=false;if(!complete)this.failed=true}
 }
 /** At most one final primitive; chunk boundaries never imply physical EOF. */
 finish():Readonly<{complete:true;bytes:number;tokens:number;finalTokens:readonly MetadataJsonToken[]}> {
  this.usable()
  try {
   const finalTokens:MetadataJsonToken[]=[]
   if(this.scalar) {if(this.scalar.kind!=='primitive')fail();finalTokens.push(this.scalarToken(this.offset))}
   if(!this.rootStarted||this.stack.length)fail()
   this.finished=true
   return Object.freeze({complete:true as const,bytes:this.offset,tokens:this.tokenCount,finalTokens:Object.freeze(finalTokens)})
  } catch(error) {this.failed=true;if(error instanceof CaptureMetadataJsonError)throw error;fail()}
 }
 diagnostics() {return Object.freeze({bytes:this.offset,tokens:this.tokenCount,peakDepth:this.peakDepth,peakScalarBytes:this.peakScalarBytes,peakChunkBytes:this.peakChunkBytes,scalarReservationBytes:this.scalarBuffer.length,failed:this.failed,finished:this.finished})}
}
