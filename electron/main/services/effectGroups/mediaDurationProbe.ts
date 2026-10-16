import {execFile} from 'node:child_process'
import {stat} from 'node:fs/promises'
/** Read-only probe, argument array and bounded output; never changes the original asset. */
export function mediaDurationProbe(executable:string){
  const cache=new Map<string,number>()
  return async(file:string)=>{
    const metadata=await stat(file);const key=JSON.stringify([file,metadata.size,metadata.mtimeMs])
    if(cache.has(key))return cache.get(key)!
    const duration=await new Promise<number>((resolve,reject)=>execFile(executable,['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',file],{windowsHide:true,timeout:1800,maxBuffer:4096},(error,output)=>{
      if(error)return reject(new Error('无法在时限内确认素材时长'))
      const milliseconds=Math.ceil(Number(output.trim())*1000)
      if(!Number.isFinite(milliseconds)||milliseconds<=0)return reject(new Error('素材时长无效'))
      resolve(milliseconds)
    }))
    if(cache.size>=128)cache.delete(cache.keys().next().value!)
    cache.set(key,duration);return duration
  }
}
