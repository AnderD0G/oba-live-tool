export function isTikTokLivePage(value: string): boolean {
  try {
    const url = new URL(value)
    return url.origin === 'https://www.tiktok.com' && !url.username && !url.password &&
      /^\/@[A-Za-z0-9._]{1,100}\/live\/?$/.test(url.pathname)
  } catch { return false }
}

/** Ignore only the explicit presentation lang query; every other part stays strict. */
export function sameTikTokLivePage(left: string, right: string): boolean {
  try {
    if (!isTikTokLivePage(left) || !isTikTokLivePage(right)) return false
    const identity = (value: string) => {
      const url = new URL(value)
      const query = url.search.slice(1).split('&').filter(part => part.split('=', 1)[0] !== 'lang').join('&')
      return `${url.origin}${url.pathname}${query ? `?${query}` : ''}${url.hash}`
    }
    return identity(left) === identity(right)
  } catch { return false }
}
