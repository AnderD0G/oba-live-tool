/**
 * Electron 的 safeStorage 在三个平台上能力不一样：
 * getSelectedStorageBackend（以及 setUsePlainTextEncryption）只存在于 Linux，
 * 在 Windows / macOS 上直接调用会抛 “is not a function”。
 * 所以这里只在它确实是函数时才问后端名字，其余平台靠 isEncryptionAvailable 判断。
 *
 * basic_text 表示 Linux 上没找到 keyring，只能明文存，等同不可用。
 */
export function secretStorageUsable(storage: {
  isEncryptionAvailable: () => boolean
  getSelectedStorageBackend?: () => string
}): boolean {
  if (!storage.isEncryptionAvailable()) return false
  const backend =
    typeof storage.getSelectedStorageBackend === 'function'
      ? storage.getSelectedStorageBackend()
      : ''
  return backend !== 'basic_text'
}
