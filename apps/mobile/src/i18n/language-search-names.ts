import { type SupportedLanguage } from '@/i18n/languages';

/* eslint-disable typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- Metro needs static require calls to bundle the generated name tables lazily. */

/**
 * Each language's name in one UI language, as `scripts/
 * generate-language-search-names.mjs` reported them and
 * `scripts/assert-language-search-names.mjs` keeps in sync. The table is
 * generated, not a runtime `Intl.DisplayNames` call: the answer must be the
 * same on every platform and OS version, and Hermes ships no
 * `Intl.DisplayNames` at all. The names are search-only — the picker never
 * renders them — so the table stays out of the startup path: one `require`
 * runs, like `@/lib/relative-time-locales`.
 */
export type LanguageSearchNames = Readonly<Partial<Record<SupportedLanguage, string>>>;

/**
 * One generated module's record. `require` answers `any`, and reading the
 * export off it at the call site would be an unsafe member access; the cast
 * happens here once, on the value the generated module actually exports.
 */
type GeneratedNamesModule = Readonly<{ names: LanguageSearchNames }>;

function namesOf(module: unknown): LanguageSearchNames {
  return (module as GeneratedNamesModule).names;
}

// Metro includes each table in the bundle but evaluates only the active UI
// language's. Keep this map complete with SUPPORTED_LANGUAGES.
const LANGUAGE_SEARCH_NAME_LOADERS = {
  af: () => namesOf(require('./language-search-name-tables/af.ts')),
  sq: () => namesOf(require('./language-search-name-tables/sq.ts')),
  am: () => namesOf(require('./language-search-name-tables/am.ts')),
  ar: () => namesOf(require('./language-search-name-tables/ar.ts')),
  hy: () => namesOf(require('./language-search-name-tables/hy.ts')),
  az: () => namesOf(require('./language-search-name-tables/az.ts')),
  eu: () => namesOf(require('./language-search-name-tables/eu.ts')),
  be: () => namesOf(require('./language-search-name-tables/be.ts')),
  bn: () => namesOf(require('./language-search-name-tables/bn.ts')),
  bs: () => namesOf(require('./language-search-name-tables/bs.ts')),
  bg: () => namesOf(require('./language-search-name-tables/bg.ts')),
  my: () => namesOf(require('./language-search-name-tables/my.ts')),
  ca: () => namesOf(require('./language-search-name-tables/ca.ts')),
  'zh-Hans': () => namesOf(require('./language-search-name-tables/zh-hans.ts')),
  'zh-Hant': () => namesOf(require('./language-search-name-tables/zh-hant.ts')),
  hr: () => namesOf(require('./language-search-name-tables/hr.ts')),
  cs: () => namesOf(require('./language-search-name-tables/cs.ts')),
  da: () => namesOf(require('./language-search-name-tables/da.ts')),
  nl: () => namesOf(require('./language-search-name-tables/nl.ts')),
  en: () => namesOf(require('./language-search-name-tables/en.ts')),
  et: () => namesOf(require('./language-search-name-tables/et.ts')),
  fil: () => namesOf(require('./language-search-name-tables/fil.ts')),
  fi: () => namesOf(require('./language-search-name-tables/fi.ts')),
  fr: () => namesOf(require('./language-search-name-tables/fr.ts')),
  gl: () => namesOf(require('./language-search-name-tables/gl.ts')),
  ka: () => namesOf(require('./language-search-name-tables/ka.ts')),
  de: () => namesOf(require('./language-search-name-tables/de.ts')),
  el: () => namesOf(require('./language-search-name-tables/el.ts')),
  gu: () => namesOf(require('./language-search-name-tables/gu.ts')),
  ht: () => namesOf(require('./language-search-name-tables/ht.ts')),
  ha: () => namesOf(require('./language-search-name-tables/ha.ts')),
  he: () => namesOf(require('./language-search-name-tables/he.ts')),
  hi: () => namesOf(require('./language-search-name-tables/hi.ts')),
  hu: () => namesOf(require('./language-search-name-tables/hu.ts')),
  is: () => namesOf(require('./language-search-name-tables/is.ts')),
  ig: () => namesOf(require('./language-search-name-tables/ig.ts')),
  id: () => namesOf(require('./language-search-name-tables/id.ts')),
  ga: () => namesOf(require('./language-search-name-tables/ga.ts')),
  it: () => namesOf(require('./language-search-name-tables/it.ts')),
  ja: () => namesOf(require('./language-search-name-tables/ja.ts')),
  kn: () => namesOf(require('./language-search-name-tables/kn.ts')),
  kk: () => namesOf(require('./language-search-name-tables/kk.ts')),
  km: () => namesOf(require('./language-search-name-tables/km.ts')),
  ko: () => namesOf(require('./language-search-name-tables/ko.ts')),
  ckb: () => namesOf(require('./language-search-name-tables/ckb.ts')),
  lo: () => namesOf(require('./language-search-name-tables/lo.ts')),
  lv: () => namesOf(require('./language-search-name-tables/lv.ts')),
  lt: () => namesOf(require('./language-search-name-tables/lt.ts')),
  mk: () => namesOf(require('./language-search-name-tables/mk.ts')),
  mg: () => namesOf(require('./language-search-name-tables/mg.ts')),
  ms: () => namesOf(require('./language-search-name-tables/ms.ts')),
  ml: () => namesOf(require('./language-search-name-tables/ml.ts')),
  mt: () => namesOf(require('./language-search-name-tables/mt.ts')),
  mi: () => namesOf(require('./language-search-name-tables/mi.ts')),
  mr: () => namesOf(require('./language-search-name-tables/mr.ts')),
  mn: () => namesOf(require('./language-search-name-tables/mn.ts')),
  ne: () => namesOf(require('./language-search-name-tables/ne.ts')),
  nb: () => namesOf(require('./language-search-name-tables/nb.ts')),
  or: () => namesOf(require('./language-search-name-tables/or.ts')),
  om: () => namesOf(require('./language-search-name-tables/om.ts')),
  ps: () => namesOf(require('./language-search-name-tables/ps.ts')),
  fa: () => namesOf(require('./language-search-name-tables/fa.ts')),
  pl: () => namesOf(require('./language-search-name-tables/pl.ts')),
  pt: () => namesOf(require('./language-search-name-tables/pt.ts')),
  'pt-BR': () => namesOf(require('./language-search-name-tables/pt-br.ts')),
  pa: () => namesOf(require('./language-search-name-tables/pa.ts')),
  ro: () => namesOf(require('./language-search-name-tables/ro.ts')),
  ru: () => namesOf(require('./language-search-name-tables/ru.ts')),
  sr: () => namesOf(require('./language-search-name-tables/sr.ts')),
  si: () => namesOf(require('./language-search-name-tables/si.ts')),
  sk: () => namesOf(require('./language-search-name-tables/sk.ts')),
  sl: () => namesOf(require('./language-search-name-tables/sl.ts')),
  so: () => namesOf(require('./language-search-name-tables/so.ts')),
  es: () => namesOf(require('./language-search-name-tables/es.ts')),
  sw: () => namesOf(require('./language-search-name-tables/sw.ts')),
  sv: () => namesOf(require('./language-search-name-tables/sv.ts')),
  ta: () => namesOf(require('./language-search-name-tables/ta.ts')),
  te: () => namesOf(require('./language-search-name-tables/te.ts')),
  th: () => namesOf(require('./language-search-name-tables/th.ts')),
  tr: () => namesOf(require('./language-search-name-tables/tr.ts')),
  uk: () => namesOf(require('./language-search-name-tables/uk.ts')),
  ur: () => namesOf(require('./language-search-name-tables/ur.ts')),
  uz: () => namesOf(require('./language-search-name-tables/uz.ts')),
  vi: () => namesOf(require('./language-search-name-tables/vi.ts')),
  cy: () => namesOf(require('./language-search-name-tables/cy.ts')),
  yo: () => namesOf(require('./language-search-name-tables/yo.ts')),
  zu: () => namesOf(require('./language-search-name-tables/zu.ts')),
} satisfies Record<SupportedLanguage, () => LanguageSearchNames>;

/** The generated names of every supported language in the `ui` language. */
export function languageSearchNames(ui: SupportedLanguage): LanguageSearchNames {
  return LANGUAGE_SEARCH_NAME_LOADERS[ui]();
}
