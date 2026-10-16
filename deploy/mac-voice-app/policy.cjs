const { X509Certificate } = require('node:crypto')

const ORIGIN = 'https://127.0.0.1:13443'
const START_URL = `${ORIGIN}/`

function localUrl(value, websocket = false) {
  try {
    const url = new URL(value)
    return !url.username && !url.password && url.hostname === '127.0.0.1' && url.port === '13443' &&
      (url.protocol === 'https:' || websocket && url.protocol === 'wss:') ? url : null
  } catch { return null }
}

function isAllowedNavigation(value) {
  const url = localUrl(value)
  return !!url && url.pathname === '/' && !url.search
}

function isAllowedRequest(value) {
  if (typeof value !== 'string') return false
  if (value.startsWith('blob:')) return !!localUrl(value.slice(5))
  return !!localUrl(value, true)
}

function canAccessAudio({ permission, requestingOrigin, topLevelUrl, details = {} }) {
  if (permission !== 'media' || !localUrl(requestingOrigin) || !isAllowedNavigation(topLevelUrl) ||
    !localUrl(details.requestingUrl) || details.isMainFrame !== true || details.embeddingOrigin) return false
  if (Array.isArray(details.mediaTypes)) return details.mediaTypes.length === 1 && details.mediaTypes[0] === 'audio'
  return details.mediaType === 'audio'
}

function normalizeFingerprint(value) {
  if (typeof value !== 'string') return null
  const normalized = value.replaceAll(':', '').toLowerCase()
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null
}

function isPinnedCertificate({ url, fingerprint, expectedFingerprint }) {
  const actual = normalizeFingerprint(fingerprint)
  return !!localUrl(url, true) && actual !== null && actual === normalizeFingerprint(expectedFingerprint)
}

function isAllowedWindowAction(action) { return action === 'minimize' || action === 'hide' }

function canControlWindow({ action, topLevelUrl, isMainFrame, isCurrentContents }) {
  return isAllowedWindowAction(action) && isAllowedNavigation(topLevelUrl) && isMainFrame === true && isCurrentContents === true
}

function certificateVerificationResult(request, expectedFingerprint) {
  if (request.hostname !== '127.0.0.1') return -2
  try {
    const actual = normalizeFingerprint(new X509Certificate(request.certificate.data).fingerprint256)
    return actual !== null && actual === normalizeFingerprint(expectedFingerprint) ? 0 : -2
  } catch { return -2 }
}

module.exports = { ORIGIN, START_URL, isAllowedNavigation, isAllowedRequest, canAccessAudio,
  normalizeFingerprint, isPinnedCertificate, isAllowedWindowAction, canControlWindow, certificateVerificationResult }
