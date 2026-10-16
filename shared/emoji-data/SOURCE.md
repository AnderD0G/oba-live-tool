# Emoji name source

Chinese short names extracted from official Unicode CLDR 46, commit `e1d37acce5dae468c414172be53b666d58d45be8` (release-46). The generated dictionary includes tts names only; variation selectors are normalized for lookup while displayed original graphemes remain untouched. There is no viewer-data request at runtime.

- Guidance: https://cldr.unicode.org/translation/characters/short-names-and-keywords
- https://raw.githubusercontent.com/unicode-org/cldr/e1d37acce5dae468c414172be53b666d58d45be8/common/annotations/zh.xml — SHA-256 `487e16c5e64b6ac1cb38a91b5f2dc25349ded224bcd78ec1f14a92bba3ef3147`
- https://raw.githubusercontent.com/unicode-org/cldr/e1d37acce5dae468c414172be53b666d58d45be8/common/annotationsDerived/zh.xml — SHA-256 `01d48d98a8612f779c17707db51f2ba2c55292d6c690f8a0828dd748c042206a`
- https://raw.githubusercontent.com/unicode-org/cldr/e1d37acce5dae468c414172be53b666d58d45be8/LICENSE — SHA-256 `743308f92225393665b0722b73418b4d4061fd2163e8e9c38b3368904acf19d6`

License: adjacent LICENSE-UNICODE (Unicode License V3). Regenerate with `node QA/generate-assistant-emoji-cldr.mjs`. Names describe emoji glyphs; they are not claims about a viewer's identity, intent, nationality, residence, gender or purchase interest. Curated Chinese usage suggestions in assistantEmojiMeaning.ts are project text, context-sensitive, and separate from CLDR names. No English meaning is serialized or displayed.
