/** Labels for recorded detection metadata; no language/country inference from names. */
export const UNIDENTIFIED_MESSAGE_LANGUAGE = 'unknown'
export const ASSISTANT_MESSAGE_LANGUAGES = [
 ['vi','越南语'],['th','泰语'],['en','英语'],['zh','中文'],['id','印尼语'],['ms','马来语'],['tl','他加禄语'],['fil','菲律宾语'],['km','高棉语'],['lo','老挝语'],['my','缅甸语'],['ta','泰米尔语'],['ar','阿拉伯语'],['ja','日语'],['ko','韩语'],['ru','俄语'],['fr','法语'],['es','西班牙语'],['de','德语'],['pt','葡萄牙语'],['hi','印地语'],['bn','孟加拉语'],['hu','匈牙利语'],['bg','保加利亚语'],['cs','捷克语'],['da','丹麦语'],['el','希腊语'],['fi','芬兰语'],['he','希伯来语'],['hr','克罗地亚语'],['it','意大利语'],['kn','卡纳达语'],['lt','立陶宛语'],['mr','马拉地语'],['nl','荷兰语'],['no','挪威语'],['pl','波兰语'],['ro','罗马尼亚语'],['sk','斯洛伐克语'],['sl','斯洛文尼亚语'],['sv','瑞典语'],['te','泰卢固语'],['tr','土耳其语'],['uk','乌克兰语'],
].map(([code,label])=>({code,label}))
const known=new Set(ASSISTANT_MESSAGE_LANGUAGES.map(v=>v.code))
const aliases:Record<string,string>={vietnamese:'vi','tiếng việt':'vi',thai:'th',english:'en',chinese:'zh',indonesian:'id',malay:'ms',tagalog:'tl',filipino:'fil',arabic:'ar',japanese:'ja',korean:'ko',russian:'ru'}
export function normalizeMessageLanguage(value:unknown):string|undefined {
 if(typeof value!=='string')return undefined
 const input=value.trim().toLowerCase()
 const named=aliases[input]??ASSISTANT_MESSAGE_LANGUAGES.find(v=>v.label===input)?.code
 if(named)return named
 if(!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(input))return undefined
 const base=input.split('-')[0]
 return known.has(base)?base:undefined
}
