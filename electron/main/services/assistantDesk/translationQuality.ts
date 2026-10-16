import type { AssistantDeskRow } from '../../../../shared/assistantDesk'

export const LANGUAGE_LABEL_TRANSLATION_ERROR = 'AI把语言名称当作译文，未翻译这条评论；请重试。'

const languageLabels: Record<string, string[]> = {
  en: ['英语', '英文', 'english'],
  zh: ['中文', '汉语', '漢語', 'chinese'],
  ja: ['日语', '日文', 'japanese', '日本語'],
  ko: ['韩语', '韩文', 'korean', '한국어'],
  es: ['西班牙语', 'spanish', 'español'],
  fr: ['法语', 'french', 'français'],
  de: ['德语', 'german', 'deutsch'],
  tl: ['他加禄语', '菲律宾语', 'tagalog', 'filipino'],
  fil: ['他加禄语', '菲律宾语', 'tagalog', 'filipino'],
  th: ['泰语', 'thai', 'ภาษาไทย'],
  vi: ['越南语', 'vietnamese', 'tiếng việt'],
  id: ['印尼语', '印度尼西亚语', 'indonesian', 'bahasa indonesia'],
  ms: ['马来语', 'malay', 'bahasa melayu'],
  // Language metadata validation includes Chrome's documented Translator languages.
  // Actual on-device availability remains a runtime capability check, never this label table.
  ar: ['阿拉伯语', 'arabic', 'العربية'],
  bg: ['保加利亚语', 'bulgarian'],
  bn: ['孟加拉语', 'bengali', 'বাংলা'],
  cs: ['捷克语', 'czech', 'čeština'],
  da: ['丹麦语', 'danish', 'dansk'],
  el: ['希腊语', 'greek', 'ελληνικά'],
  fi: ['芬兰语', 'finnish', 'suomi'],
  he: ['希伯来语', 'hebrew', 'עברית'],
  hi: ['印地语', 'hindi', 'हिन्दी'],
  hr: ['克罗地亚语', 'croatian'],
  hu: ['匈牙利语', 'hungarian', 'magyar'],
  it: ['意大利语', 'italian', 'italiano'],
  kn: ['卡纳达语', 'kannada', 'ಕನ್ನಡ'],
  lt: ['立陶宛语', 'lithuanian'],
  mr: ['马拉地语', 'marathi', 'मराठी'],
  nl: ['荷兰语', 'dutch', 'nederlands'],
  no: ['挪威语', 'norwegian', 'norsk'],
  pl: ['波兰语', 'polish', 'polski'],
  pt: ['葡萄牙语', 'portuguese', 'português'],
  ro: ['罗马尼亚语', 'romanian', 'română'],
  ru: ['俄语', '俄文', 'russian', 'русский'],
  sk: ['斯洛伐克语', 'slovak'],
  sl: ['斯洛文尼亚语', 'slovenian'],
  sv: ['瑞典语', 'swedish', 'svenska'],
  ta: ['泰米尔语', 'tamil', 'தமிழ்'],
  te: ['泰卢固语', 'telugu', 'తెలుగు'],
  tr: ['土耳其语', 'turkish', 'türkçe'],
  uk: ['乌克兰语', 'ukrainian', 'українська'],
}

/** Resolve only languages supported by the desk; never infer a language from a comment. */
export function normalizeTranslationLanguage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const key = value.trim().toLowerCase()
  if (key === 'filipino' || key === '菲律宾语') return 'fil'
  const alias = Object.entries(languageLabels).find(([, labels]) => labels.includes(key))
  if (alias) return alias[0]
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(key) || !languageLabels[key.split('-')[0]]) return undefined
  try { return Intl.getCanonicalLocales(key)[0] } catch { return undefined }
}

function normalizeLabel(text: string) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[。.!！?？]+$/, '')
    .trim()
}

function namesLanguage(text: string, labels: string[]) {
  // One observed descriptor only; do not recursively discard arbitrary prose.
  if (text.endsWith('口语')) text = text.slice(0, -2).trim()
  if (labels.includes(text)) return true
  // Recognize an alias annotation, never discard arbitrary parenthetical prose.
  const annotation = /^(.+?)[（(]([^（）()]+)[）)]$/.exec(text)
  return (
    !!annotation && labels.includes(annotation[1].trim()) && labels.includes(annotation[2].trim())
  )
}

function languageLabelOrStatement(text: string, labels: string[]) {
  if (namesLanguage(text, labels)) return true
  const statement = /^(?:this is\s+|这是\s*)(.+)$/.exec(text)
  return !!statement && namesLanguage(statement[1], labels)
}

export function isLanguageLabelTranslation(
  original: string,
  language: unknown,
  translated: unknown,
) {
  if (typeof language !== 'string' || typeof translated !== 'string') return false
  const languageKey = language.trim().toLowerCase()
  // Older rows store names such as Tagalog instead of a language code.
  const labels = languageLabels[languageKey.split('-')[0]] ??
    Object.values(languageLabels).find(aliases => aliases.includes(languageKey)) ?? []
  // This detects exact language labels, not semantic translation accuracy.
  return (
    languageLabelOrStatement(normalizeLabel(translated), labels) &&
    !languageLabelOrStatement(normalizeLabel(original), labels)
  )
}

/** Project invalid old results as retryable; keep the append-only journal untouched. */
export function validateStoredTranslation(row: AssistantDeskRow): AssistantDeskRow {
  if (
    row.translation.status !== 'ready' ||
    !isLanguageLabelTranslation(row.original, row.translation.language, row.translation.chinese)
  )
    return row
  return {
    ...row,
    translation: {
      status: 'failed',
      language: row.translation.language,
      error: LANGUAGE_LABEL_TRANSLATION_ERROR,
    },
  }
}
