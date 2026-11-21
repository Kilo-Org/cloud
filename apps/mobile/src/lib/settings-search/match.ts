/**
 * Locale-aware matching for the Settings search index. The caller owns the
 * index (the rendered settings and their translated labels/keywords); this
 * module folds the text and maps matches back onto the original label so the
 * screen can highlight the exact UTF-16 range.
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

/**
 * Marks in these ranges are optional accents or reading aids and are folded
 * away. Kana voicing, Thai tones and Indic vowel signs sit outside these
 * ranges (and `\p{Diacritic}` would fold the first two), so they stay.
 */
const FOLDED_MARK_BLOCKS: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f],
  [0x0591, 0x05c7],
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x20d0, 0x20ff],
  [0xfe20, 0xfe2f],
];

const SERBIAN_CYRILLIC = 'абвгдђежзијклљмнњопрстћуфхцчџш';
// Same order as SERBIAN_CYRILLIC; diacritics stay for the fold below to strip.
const SERBIAN_LATIN = 'a b v g d dj e ž z i j k l lj m n nj o p r s t ć u f h c č dž š'.split(' ');

const MARK = /\p{M}/u;

function isFoldedMark(char: string): boolean {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) {
    return false;
  }
  return FOLDED_MARK_BLOCKS.some(([start, end]) => codePoint >= start && codePoint <= end);
}

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

/**
 * Fold one grapheme cluster. Canonically equivalent input composes first, so
 * `I` + U+0307 is the same as `İ` before Turkic lowercasing. Every folded code
 * unit of the cluster maps to the whole cluster, which keeps an expanded
 * scalar (`ß`, `đ`, `џ`) and its trailing accents on the same label range.
 */
function fold(value: string, rules: LocaleRules, mapping?: FoldMapping): string {
  let text = '';

  const append = (chunk: string, start: number, end: number) => {
    text += chunk;
    if (mapping === undefined) {
      return;
    }
    for (let index = 0; index < chunk.length; index += 1) {
      mapping.starts.push(start);
      mapping.ends.push(end);
    }
  };

  const extendLast = (end: number) => {
    if (mapping === undefined) {
      return;
    }
    const last = mapping.ends.at(-1);
    if (last !== undefined) {
      mapping.ends[mapping.ends.length - 1] = Math.max(last, end);
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
    const end = offset;

    for (const char of cluster.normalize('NFC')) {
      const lowered = lowercaseForLocale(char, rules.language);
      for (const loweredChar of lowered) {
        const transliterated = rules.serbianCyrillic
          ? transliterateSerbian(loweredChar)
          : loweredChar;
        for (const part of transliterated.normalize('NFD')) {
          if (MARK.test(part)) {
            if (isFoldedMark(part)) {
              extendLast(end);
            } else {
              append(part, start, end);
            }
          } else if (part === 'ß') {
            append('ss', start, end);
          } else if (part === 'đ') {
            append(rules.djDigraph ? 'dj' : 'd', start, end);
          } else if (part === 'ς') {
            append('σ', start, end);
          } else {
            append(part, start, end);
          }
        }
      }
    }
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
 * Case- and diacritic-insensitive search over the current locale's settings
 * labels, contexts and translated keywords. Every query word must match at
 * least one field; a word may match the label, context or a keyword. Only
 * label matches produce highlight ranges. Label matches rank above entries
 * matched only by context or keywords; both groups keep index order. An empty
 * query returns no results, so callers keep the normal Settings list.
 */
export function searchSettings<T extends SettingsSearchText>(
  entries: readonly T[],
  query: string,
  locale: string
) {
  const rules = localeRules(locale);
  const tokens = searchTokens(query, rules);
  if (tokens.length === 0) {
    return [];
  }

  const labelMatches: SearchResult<T>[] = [];
  const otherMatches: SearchResult<T>[] = [];

  for (const entry of entries) {
    const label = foldLabel(entry.label, rules);
    const context = entry.context === undefined ? null : fold(entry.context, rules);
    const keywords = (entry.keywords ?? []).map(keyword => fold(keyword, rules));

    let allTokensMatched = true;
    let labelMatched = false;

    for (const token of tokens) {
      if (label.text.includes(token)) {
        labelMatched = true;
      } else {
        const otherFieldMatched =
          (context !== null && context.includes(token)) ||
          keywords.some(keyword => keyword.includes(token));
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
}
