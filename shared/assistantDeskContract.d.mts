export const DESK_TOOLS: Array<{name:string;description:string;inputSchema:unknown}>
export function deskToolRoute(name:string):{path:string;action:string;tool:unknown}|undefined
export function validateDeskTool(name:string,args:unknown):{path:string;command:unknown}
export function validateDeskHttp(path:string,body:unknown):unknown
export function validateBrowserAttachEndpoint(input:unknown):string
export function isTikTokUsername(input:unknown):input is string
export function parseTikTokAttachPage(input:unknown):{username:string;url:string}
