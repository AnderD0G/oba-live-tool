/** Match the Windows assistant-desk launcher when a Mac app is opened from Finder. */
export function desktopLandingHash(platform: string, arguments_: readonly string[]): '/assistant-desk' | undefined {
  return platform === 'darwin' || arguments_.includes('--assistant-desk') ? '/assistant-desk' : undefined
}
