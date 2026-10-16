import { useState } from 'react'
import flagAssets from '../../../shared/emoji-data/flag-assets.json'
import emojiNames from '../../../shared/emoji-data/cldr-46-zh.json'

const assets = flagAssets as Readonly<Record<string, string>>
const names = emojiNames as Readonly<Record<string, string>>
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const possibleFlag = /\p{Regional_Indicator}|\u{E0067}/u

function FlagGraphic({ emoji, id }: { emoji: string; id: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return emoji
  const name = names[emoji.replace(/[\uFE0E\uFE0F]/g, '')] ?? emoji
  return (
    <span className="assistant-flag" role="img" aria-label={name} title={name}>
      {/* Retain the actual Unicode text for selection/copy and evidence checks. */}
      <span className="assistant-flag-codepoints">{emoji}</span>
      <img src={`./emoji-flags/${id}.svg`} data-flag={id} alt="" aria-hidden="true" draggable={false} onError={() => setFailed(true)} />
    </span>
  )
}

/** Display-only replacement: stored messages, names and outgoing text stay raw. */
export function FlagText({ text }: { text: string }) {
  if (!possibleFlag.test(text)) return text
  return Array.from(segmenter.segment(text), ({ segment, index }) => {
    const lookup = segment.replace(/[\uFE0E\uFE0F]/g, '')
    const id = assets[lookup]
    return id ? <FlagGraphic key={`${index}-${segment}`} emoji={segment} id={id} /> : segment
  })
}
