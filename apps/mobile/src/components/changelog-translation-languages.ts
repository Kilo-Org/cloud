/**
 * The languages a changelog subject names, for the notes that correct copy.
 *
 * `CHANGELOG.md` is a commit log, so a catalog fix reaches it as its own bullet
 * per language — `Correct Igbo code reviewer copy`, `Use one Estonian term for
 * pull request`. A reader wants one line for that work, which means the screen
 * has to know which languages a bullet is about.
 */

import { LANGUAGE_ENGLISH_NAMES, type SupportedLanguage } from '@/i18n/languages';

/**
 * The names a subject writes a language with, where it does not write the
 * picker's own English name: the script variant is spelled out, a locale tag
 * appears as its code, and a commit writes the older English alias for Persian.
 */
const ALIASES = {
  chinese: 'zh-Hans',
  'simplified chinese': 'zh-Hans',
  'traditional chinese': 'zh-Hant',
  'brazilian portuguese': 'pt-BR',
  'pt-br': 'pt-BR',
  farsi: 'fa',
} satisfies Record<string, SupportedLanguage>;

/** A name and the language it stands for, longest name first. */
type Candidate = readonly [name: string, tag: SupportedLanguage];

/** Every name a subject can use, so `Simplified Chinese` wins over `Chinese`. */
const CANDIDATES: readonly Candidate[] = namesLongestFirst();

function namesLongestFirst(): readonly Candidate[] {
  const candidates: Candidate[] = [];
  for (const [tag, name] of Object.entries(LANGUAGE_ENGLISH_NAMES)) {
    // English is the source language of these notes, never a language they fixed.
    if (tag !== 'en') {
      // The table is English, so the fold is too: a Turkish device would
      // otherwise read `I` as `ı` and stop matching `Icelandic`.
      candidates.push([name.toLocaleLowerCase('en'), tag as SupportedLanguage]);
    }
  }
  for (const [alias, tag] of Object.entries(ALIASES)) {
    candidates.push([alias, tag]);
  }
  return candidates.sort((left, right) => right[0].length - left[0].length);
}

/** `name` as a pattern that matches whole words in any script. */
function wordsOf(name: string): RegExp {
  const escaped = name.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  return new RegExp(`(^|[^\\p{L}])(${escaped})(?![\\p{L}])`, 'giu');
}

type Range = Readonly<{ start: number; end: number }>;

/**
 * The languages `subject` names, in the order it names them, as the picker's
 * English name: `Translation fixes for Igbo, Estonian and Armenian` is built
 * from these.
 */
export function translationLanguagesIn(subject: string): string[] {
  const found: { start: number; label: string }[] = [];
  const consumed: Range[] = [];
  for (const [name, tag] of CANDIDATES) {
    for (const match of subject.matchAll(wordsOf(name))) {
      const start = match.index + (match[1] ?? '').length;
      const end = start + (match[2] ?? '').length;
      // `Simplified Chinese` also contains `Chinese`, so the longer name owns
      // the characters it already claimed.
      const claimed = consumed.some(range => start < range.end && end > range.start);
      if (!claimed) {
        consumed.push({ start, end });
        found.push({ start, label: LANGUAGE_ENGLISH_NAMES[tag] });
      }
    }
  }
  const inOrder = found.sort((left, right) => left.start - right.start).map(entry => entry.label);
  return inOrder.filter((label, index) => inOrder.indexOf(label) === index);
}
