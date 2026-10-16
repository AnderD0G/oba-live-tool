/** Weak, local drafting hints. Never use this result as viewer language or country evidence. */
export function nicknameReplyLanguage(nickname: string): string | undefined {
  const name = nickname.slice(0, 300).normalize('NFC')
  const letters = name.match(/\p{L}/gu) ?? []
  const nonLatin = letters.filter(letter => !/\p{Script=Latin}/u.test(letter))
  if (nonLatin.length) {
    for (const [language, script] of [['th', /\p{Script=Thai}/u], ['ar', /\p{Script=Arabic}/u]] as const) {
      const count = nonLatin.filter(letter => script.test(letter)).length
      // English decorations are harmless, but conflicting non-Latin scripts need a clear majority.
      if (count >= 2 && count / nonLatin.length >= 0.8) return language
    }
    return undefined
  }
  // These letters/tones are more specific than accents also common in French or Spanish.
  if (/[đăơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/iu.test(name)) return 'vi'
  return undefined
}
