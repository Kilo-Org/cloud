/**
 * Locale-aware matching for the Settings search index. The caller owns the
 * index (the rendered settings and their translated labels/keywords); this
 * module folds that index once per locale and returns the query function, and
 * maps a label match back onto the original string so the screen can highlight
 * the exact UTF-16 range.
 */

export type SettingsSearchText = {
  label: string;
  context?: string;
  keywords?: readonly string[];
};

export type SettingsMatchRange = { start: number; end: number };

type FoldedLabel = {
  text: string;
  starts: number[];
  ends: number[];
};

type FoldMapping = {
  starts: number[];
  ends: number[];
};

type LocaleRules = {
  language: string;
  serbianCyrillic: boolean;
  djDigraph: boolean;
};

type SearchResult<T> = {
  entry: T;
  ranges: readonly SettingsMatchRange[];
};

type PreparedEntry<T> = {
  entry: T;
  label: FoldedLabel;
  context: string | null;
  keywords: readonly string[];
};

/**
 * Marks in these ranges are optional accents or reading aids and are dropped.
 * Kana voicing, Thai tones and Indic vowel signs sit outside these ranges (and
 * `\p{Diacritic}` would drop the first two), so they stay.
 */
const FOLDED_MARK_RANGES = [
  ['\u0300', '\u036F'],
  ['\u0591', '\u05C7'],
  ['\u064B', '\u065F'],
  ['\u0670', '\u0670'],
  ['\u1AB0', '\u1AFF'],
  ['\u1DC0', '\u1DFF'],
  ['\u20D0', '\u20FF'],
  ['\uFE20', '\uFE2F'],
] as const;

const SERBIAN_CYRILLIC = 'абвгдђежзијклљмнњопрстћуфхцчџш';
// Same order as SERBIAN_CYRILLIC; diacritics stay for the fold below to strip.
const SERBIAN_LATIN = 'a b v g d dj e ž z i j k l lj m n nj o p r s t ć u f h c č dž š'.split(' ');

/**
 * Latin letters the shipped catalogs use that carry no canonical
 * decomposition, so NFD leaves them and an accent-free query could not reach
 * the label. The value is the conventional ASCII alias.
 */
const LATIN_ALIAS = {
  ł: 'l',
  ø: 'o',
  æ: 'ae',
  œ: 'oe',
  ð: 'd',
  þ: 'th',
  ħ: 'h',
} as const satisfies Record<string, string>;

/** Whether a letter has a conventional ASCII alias. */
function isAliasedLetter(letter: string): letter is keyof typeof LATIN_ALIAS {
  return Object.hasOwn(LATIN_ALIAS, letter);
}

const MARK = /\p{M}/u;

function primaryLanguage(locale: string): string {
  const primary = locale.toLocaleLowerCase('en').split(/[-_]/u)[0] ?? '';
  return /^[a-z]{2,3}$/u.test(primary) ? primary : '';
}

function localeRules(locale: string): LocaleRules {
  const language = primaryLanguage(locale);
  return {
    language,
    serbianCyrillic: language === 'sr',
    djDigraph: language === 'sr' || language === 'hr' || language === 'bs' || language === 'cnr',
  };
}

function lowercaseForLocale(char: string, language: string): string {
  if (language === 'tr' || language === 'az') {
    if (char === 'I') {
      return 'ı';
    }
    if (char === 'İ') {
      return 'i';
    }
  }
  return language.length > 0 ? char.toLocaleLowerCase(language) : char.toLocaleLowerCase();
}

function transliterateSerbian(char: string): string {
  const index = SERBIAN_CYRILLIC.indexOf(char);
  if (index === -1) {
    return char;
  }
  return SERBIAN_LATIN[index] ?? char;
}

/** Whether a decomposed part is an optional mark this locale folds away. */
function foldedMark(part: string): boolean {
  return (
    MARK.test(part) && FOLDED_MARK_RANGES.some(([first, last]) => part >= first && part <= last)
  );
}

function stripOptionalMarks(value: string): string {
  let kept = '';
  for (const part of value.normalize('NFD')) {
    if (!foldedMark(part)) {
      kept += part;
    }
  }
  return kept;
}

/**
 * Fold one grapheme cluster. Canonically equivalent input composes first, so
 * `I` + U+0307 is the same as `İ` before Turkic lowercasing. The optional
 * marks are dropped before the remainder is composed again, so a voiced kana
 * becomes one letter (`し` + U+3099 is `じ`) instead of leaving its base as a
 * prefix of the voiced form. Every folded code unit of the cluster maps to the
 * whole cluster, which keeps an expanded scalar (`ß`, `đ`, `џ`, `æ`) and its
 * trailing accents on the same original label range.
 */
function fold(value: string, rules: LocaleRules, mapping?: FoldMapping): string {
  let text = '';

  const append = (chunk: string, start: number, end: number) => {
    text += chunk;
    if (mapping === undefined) {
      return;
    }
    let remaining = chunk.length;
    while (remaining > 0) {
      mapping.starts.push(start);
      mapping.ends.push(end);
      remaining -= 1;
    }
  };

  const foldCluster = (cluster: string, start: number, end: number) => {
    for (const char of cluster.normalize('NFC')) {
      for (const lowered of lowercaseForLocale(char, rules.language)) {
        const letters = rules.serbianCyrillic ? transliterateSerbian(lowered) : lowered;
        const kept = stripOptionalMarks(letters);
        for (const letter of kept.normalize('NFC')) {
          if (letter === 'ß') {
            append('ss', start, end);
          } else if (letter === 'đ') {
            append(rules.djDigraph ? 'dj' : 'd', start, end);
          } else if (letter === 'ς') {
            append('σ', start, end);
          } else {
            append(isAliasedLetter(letter) ? LATIN_ALIAS[letter] : letter, start, end);
          }
        }
      }
    }
  };

  const codePoints = value[Symbol.iterator]();
  let next = codePoints.next();
  let offset = 0;

  while (!next.done) {
    const start = offset;
    let cluster = next.value;
    offset += cluster.length;
    next = codePoints.next();

    while (!next.done && MARK.test(next.value)) {
      cluster += next.value;
      offset += next.value.length;
      next = codePoints.next();
    }
    foldCluster(cluster, start, offset);
  }

  return text;
}

function foldLabel(value: string, rules: LocaleRules): FoldedLabel {
  const starts: number[] = [];
  const ends: number[] = [];
  const text = fold(value, rules, { starts, ends });
  return { text, starts, ends };
}

function searchTokens(query: string, rules: LocaleRules): string[] {
  const tokens = new Set(fold(query, rules).trim().split(/\s+/u));
  tokens.delete('');
  return [...tokens];
}

function findLabelRanges(label: FoldedLabel, tokens: readonly string[]): SettingsMatchRange[] {
  const ranges: SettingsMatchRange[] = [];

  for (const token of tokens) {
    let at = label.text.indexOf(token);
    while (at !== -1) {
      const start = label.starts[at];
      const end = label.ends[at + token.length - 1];
      if (start !== undefined && end !== undefined) {
        ranges.push({ start, end });
      }
      // Step one unit so overlapping occurrences of a repeated word are found.
      at = label.text.indexOf(token, at + 1);
    }
  }

  return mergeRanges(ranges);
}

function mergeRanges(ranges: SettingsMatchRange[]): SettingsMatchRange[] {
  ranges.sort((left, right) => left.start - right.start || left.end - right.end);

  const merged: SettingsMatchRange[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }

  return merged;
}

/**
 * Fold the localized index once, then return the query function for it. Case
 * and diacritics are insensitive: every query word must match at least one
 * field, and a word may match the label, the containing screen's breadcrumb or
 * a translated keyword. Only label matches produce highlight ranges. Label
 * matches rank above entries matched only by context or keywords; both groups
 * keep index order. An empty query returns no results, so callers keep the
 * normal Settings list.
 *
 * The folded text depends only on the locale and the entry strings, so it is
 * computed here rather than on every keystroke.
 */
export function prepareSettingsSearch<T extends SettingsSearchText>(
  entries: readonly T[],
  locale: string
) {
  const rules = localeRules(locale);
  const prepared: PreparedEntry<T>[] = entries.map(entry => ({
    entry,
    label: foldLabel(entry.label, rules),
    context: entry.context === undefined ? null : fold(entry.context, rules),
    keywords: (entry.keywords ?? []).map(keyword => fold(keyword, rules)),
  }));

  return (query: string) => {
    const tokens = searchTokens(query, rules);
    if (tokens.length === 0) {
      return [];
    }

    const labelMatches: SearchResult<T>[] = [];
    const otherMatches: SearchResult<T>[] = [];

    for (const { entry, label, context, keywords } of prepared) {
      let allTokensMatched = true;
      let labelMatched = false;

      for (const token of tokens) {
        if (label.text.includes(token)) {
          labelMatched = true;
        } else {
          const otherFieldMatched =
            context?.includes(token) === true || keywords.some(keyword => keyword.includes(token));
          if (!otherFieldMatched) {
            allTokensMatched = false;
            break;
          }
        }
      }

      if (allTokensMatched) {
        if (labelMatched) {
          labelMatches.push({ entry, ranges: findLabelRanges(label, tokens) });
        } else {
          otherMatches.push({ entry, ranges: [] });
        }
      }
    }

    return [...labelMatches, ...otherMatches];
  };
}
