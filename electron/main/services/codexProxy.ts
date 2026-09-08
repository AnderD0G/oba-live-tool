// Electron resolves the existing OS/PAC proxy; pass it only to this child process.
export function codexProxyEnvironment(proxy: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base }
  if (env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy) return env
  const first = proxy.split(';')[0]?.trim() ?? ''
  const match = /^(PROXY|HTTPS|SOCKS5|SOCKS) ([^\s/]+:\d+)$/.exec(first)
  if (!match) return env
  const scheme = match[1] === 'PROXY' ? 'http' : match[1] === 'HTTPS' ? 'https' : 'socks5h'
  const url = `${scheme}://${match[2]}`
  env.HTTPS_PROXY = url
  env.HTTP_PROXY = env.HTTP_PROXY ?? env.http_proxy ?? url
  return env
}
