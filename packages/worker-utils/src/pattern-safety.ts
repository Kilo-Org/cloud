/**
 * Grammar check for the `pattern` keyword of a webhook body schema.
 *
 * The accepted subset is literals, classes, groups, alternation, lookarounds, quantifiers, and
 * established escapes. Backreferences, quantifiers whose combined repetition exceeds the budget,
 * and a repeated alternation whose branches are not disjoint are outside it and are refused with a
 * message that names the rule.
 */

/** Combined repetitions of quantifiers, above which the pattern is outside the subset. */
const MAX_NESTED_REPEAT = 64;
/** Characters a class may expand to before its content is treated as unconstrained. */
const MAX_CLASS_EXPANSION = 128;

export const PATTERN_ISSUE_MESSAGES = {
  backreference: 'Pattern must not use backreferences',
  nested: 'Pattern must not combine quantifiers that exceed 64 combined repetitions',
  ambiguous: 'Pattern must not repeat alternatives that can match the same characters',
  unsupported: 'Pattern must use supported regular expression syntax',
} as const;

type CharSet = ReadonlySet<string> | 'any';

type PatternNode =
  | { kind: 'zero' }
  | { kind: 'atom'; first: CharSet }
  | { kind: 'reference' }
  | { kind: 'lookaround'; body: PatternNode }
  | { kind: 'sequence'; items: PatternNode[] }
  | { kind: 'alternation'; branches: PatternNode[] }
  | { kind: 'repeat'; min: number; max: number; body: PatternNode };

function charsInRange(from: string, to: string): string[] {
  const chars: string[] = [];
  const start = from.codePointAt(0) ?? 0;
  const end = to.codePointAt(0) ?? 0;
  for (let code = start; code <= end; code++) {
    chars.push(String.fromCodePoint(code));
  }
  return chars;
}

const DIGITS = new Set(charsInRange('0', '9'));
const WORD = new Set([...charsInRange('a', 'z'), ...charsInRange('A', 'Z'), ...DIGITS, '_']);
const SPACES = new Set([
  '\t',
  '\n',
  '\v',
  '\f',
  '\r',
  ' ',
  '\u00a0',
  '\u1680',
  ...charsInRange('\u2000', '\u200a'),
  '\u2028',
  '\u2029',
  '\u202f',
  '\u205f',
  '\u3000',
  '\ufeff',
]);

function union(sets: readonly CharSet[]): CharSet {
  const merged = new Set<string>();
  for (const set of sets) {
    if (set === 'any') return 'any';
    for (const char of set) merged.add(char);
  }
  return merged;
}

function overlaps(left: CharSet, right: CharSet): boolean {
  if (left === 'any' || right === 'any') return true;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const char of small) {
    if (large.has(char)) return true;
  }
  return false;
}

class PatternParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): PatternNode {
    const node = this.alternation();
    if (this.index !== this.source.length) throw new Error('Unexpected pattern syntax');
    return node;
  }

  private alternation(): PatternNode {
    const first = this.sequence();
    const branches: PatternNode[] = [first];
    while (this.source[this.index] === '|') {
      this.index++;
      branches.push(this.sequence());
    }
    return branches.length === 1 ? first : { kind: 'alternation', branches };
  }

  private sequence(): PatternNode {
    const items: PatternNode[] = [];
    while (this.index < this.source.length) {
      const char = this.source[this.index];
      if (char === '|' || char === ')') break;
      items.push(this.term());
    }
    return { kind: 'sequence', items };
  }

  private term(): PatternNode {
    const atom = this.atom();
    const quantifier = this.quantifier();
    if (!quantifier) return atom;
    if (this.source[this.index] === '?') this.index++;
    return { kind: 'repeat', min: quantifier.min, max: quantifier.max, body: atom };
  }

  private quantifier(): { min: number; max: number } | null {
    const char = this.source[this.index];
    if (char === '?') {
      this.index++;
      return { min: 0, max: 1 };
    }
    if (char === '*') {
      this.index++;
      return { min: 0, max: Infinity };
    }
    if (char === '+') {
      this.index++;
      return { min: 1, max: Infinity };
    }
    if (char !== '{') return null;
    const close = this.source.indexOf('}', this.index);
    if (close < 0) throw new Error('Unterminated quantifier');
    const bounds = /^(\d+)(?:,(\d*))?$/.exec(this.source.slice(this.index + 1, close));
    if (!bounds) throw new Error('Invalid quantifier');
    this.index = close + 1;
    const min = Number(bounds[1]);
    const max = bounds[2] === undefined ? min : bounds[2] === '' ? Infinity : Number(bounds[2]);
    return { min, max };
  }

  private atom(): PatternNode {
    const char = this.source[this.index];
    if (char === undefined) throw new Error('Unexpected end of pattern');
    this.index++;
    switch (char) {
      case '(':
        return this.group();
      case '[':
        return this.characterClass();
      case '.':
        return { kind: 'atom', first: 'any' };
      case '^':
      case '$':
        return { kind: 'zero' };
      case '\\':
        return this.escape(false);
      default: {
        if ('*+?{}]|)'.includes(char)) throw new Error('Unexpected quantifier or bracket');
        const literal = this.codePointAt(this.index - 1);
        this.index = this.index - 1 + literal.length;
        return { kind: 'atom', first: new Set([literal.char]) };
      }
    }
  }

  /** The code point starting at `index`, so astral characters stay one atom. */
  private codePointAt(index: number): { char: string; length: number } {
    const code = this.source.codePointAt(index);
    if (code === undefined) throw new Error('Unexpected end of pattern');
    const char = String.fromCodePoint(code);
    return { char, length: char.length };
  }

  private group(): PatternNode {
    let lookaround = false;
    if (this.source[this.index] === '?') {
      this.index++;
      const marker = this.source[this.index];
      if (marker === ':') {
        this.index++;
      } else if (marker === '=' || marker === '!') {
        lookaround = true;
        this.index++;
      } else if (marker === '<') {
        const next = this.source[this.index + 1];
        if (next === '=' || next === '!') {
          lookaround = true;
          this.index += 2;
        } else {
          const close = this.source.indexOf('>', this.index);
          if (close < 0) throw new Error('Unterminated group name');
          this.index = close + 1;
        }
      } else {
        throw new Error('Unsupported group');
      }
    }
    const body = this.alternation();
    if (this.source[this.index] !== ')') throw new Error('Unterminated group');
    this.index++;
    return lookaround ? { kind: 'lookaround', body } : body;
  }

  private classEscape(): CharSet {
    const char = this.source[this.index];
    if (char === undefined) throw new Error('Unterminated escape');
    this.index++;
    switch (char) {
      case 'd':
        return DIGITS;
      case 'w':
        return WORD;
      case 's':
        return SPACES;
      case 'D':
      case 'W':
      case 'S':
      case 'p':
      case 'P':
        if ((char === 'p' || char === 'P') && this.source[this.index] === '{') {
          const close = this.source.indexOf('}', this.index);
          if (close < 0) throw new Error('Unterminated property escape');
          this.index = close + 1;
        }
        return 'any';
      case 'b':
        return new Set(['\b']);
      default: {
        const literal = this.escapedChar(char);
        return literal === null ? 'any' : new Set([literal]);
      }
    }
  }

  /** Decodes the escape body after the backslash; null means "cannot be narrowed". */
  private escapedChar(char: string): string | null {
    const hex = (length: number): string => {
      const digits = this.source.slice(this.index, this.index + length);
      if (!/^[0-9a-fA-F]+$/.test(digits) || digits.length !== length) {
        throw new Error('Invalid escape');
      }
      this.index += length;
      return String.fromCharCode(Number.parseInt(digits, 16));
    };
    switch (char) {
      case 'x':
        return hex(2);
      case 'u': {
        if (this.source[this.index] !== '{') return hex(4);
        const close = this.source.indexOf('}', this.index);
        if (close < 0) throw new Error('Unterminated escape');
        const digits = this.source.slice(this.index + 1, close);
        this.index = close + 1;
        return String.fromCodePoint(Number.parseInt(digits, 16));
      }
      case 'c': {
        const letter = this.source[this.index];
        if (letter === undefined || !/[a-zA-Z]/.test(letter)) throw new Error('Invalid escape');
        this.index++;
        return String.fromCharCode(letter.toUpperCase().charCodeAt(0) - 64);
      }
      case 'f':
        return '\f';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'v':
        return '\v';
      case '0':
        return '\0';
      default:
        return char;
    }
  }

  private escape(inClass: boolean): PatternNode {
    const char = this.source[this.index];
    if (char === undefined) throw new Error('Unterminated escape');
    this.index++;
    if (char >= '1' && char <= '9') {
      while (/[0-9]/.test(this.source[this.index] ?? '')) this.index++;
      return inClass ? { kind: 'atom', first: 'any' } : { kind: 'reference' };
    }
    if (char === 'k') {
      if (this.source[this.index] !== '<') throw new Error('Unsupported reference');
      const close = this.source.indexOf('>', this.index);
      if (close < 0) throw new Error('Unterminated reference');
      this.index = close + 1;
      return inClass ? { kind: 'atom', first: 'any' } : { kind: 'reference' };
    }
    if (char === 'p' || char === 'P') {
      if (this.source[this.index] === '{') {
        const close = this.source.indexOf('}', this.index);
        if (close < 0) throw new Error('Unterminated property escape');
        this.index = close + 1;
      }
      return { kind: 'atom', first: 'any' };
    }
    if (char === 'b' || char === 'B') {
      return inClass ? { kind: 'atom', first: new Set(['\b']) } : { kind: 'zero' };
    }
    if (char === 'd') return { kind: 'atom', first: DIGITS };
    if (char === 'w') return { kind: 'atom', first: WORD };
    if (char === 's') return { kind: 'atom', first: SPACES };
    if (char === 'D' || char === 'W' || char === 'S') return { kind: 'atom', first: 'any' };
    const literal = this.escapedChar(char);
    return { kind: 'atom', first: literal === null ? 'any' : new Set([literal]) };
  }

  private characterClass(): PatternNode {
    const negated = this.source[this.index] === '^';
    if (negated) this.index++;
    let chars: Set<string> | 'any' = new Set();
    const add = (value: CharSet) => {
      if (chars === 'any') return;
      if (value === 'any') {
        chars = 'any';
        return;
      }
      for (const char of value) chars.add(char);
      if (chars.size > MAX_CLASS_EXPANSION) chars = 'any';
    };
    for (;;) {
      const unit = this.source[this.index];
      if (unit === undefined) throw new Error('Unterminated class');
      if (unit === ']') {
        this.index++;
        return { kind: 'atom', first: negated ? 'any' : chars };
      }
      if (unit === '\\') {
        this.index++;
        add(this.classEscape());
        continue;
      }
      const start = this.codePointAt(this.index);
      this.index += start.length;
      const rangeEnd = this.source[this.index + 1];
      if (
        start.char !== '-' &&
        this.source[this.index] === '-' &&
        rangeEnd !== undefined &&
        rangeEnd !== ']' &&
        rangeEnd !== '\\'
      ) {
        const end = this.codePointAt(this.index + 1);
        this.index += 1 + end.length;
        const from = start.char.codePointAt(0) ?? 0;
        const to = end.char.codePointAt(0) ?? 0;
        if (to < from) throw new Error('Invalid range');
        if (to - from > MAX_CLASS_EXPANSION) {
          chars = 'any';
          continue;
        }
        add(new Set(charsInRange(start.char, end.char)));
        continue;
      }
      add(new Set([start.char]));
    }
  }
}

const emptiness = new WeakMap<PatternNode, boolean>();
const firstSets = new WeakMap<PatternNode, CharSet>();
const lastSets = new WeakMap<PatternNode, CharSet>();
const consumers = new WeakMap<PatternNode, boolean>();

function canBeEmpty(node: PatternNode): boolean {
  const cached = emptiness.get(node);
  if (cached !== undefined) return cached;
  const empty = computeCanBeEmpty(node);
  emptiness.set(node, empty);
  return empty;
}

function computeCanBeEmpty(node: PatternNode): boolean {
  switch (node.kind) {
    case 'zero':
    case 'lookaround':
    case 'reference':
      return true;
    case 'atom':
      return false;
    case 'repeat':
      return node.min === 0 || canBeEmpty(node.body);
    case 'alternation':
      return node.branches.some(canBeEmpty);
    case 'sequence':
      return node.items.every(canBeEmpty);
  }
}

function firstSet(node: PatternNode): CharSet {
  const cached = firstSets.get(node);
  if (cached !== undefined) return cached;
  const first = computeFirstSet(node);
  firstSets.set(node, first);
  return first;
}

function computeFirstSet(node: PatternNode): CharSet {
  switch (node.kind) {
    case 'zero':
    case 'lookaround':
      return new Set<string>();
    case 'atom':
      return node.first;
    case 'reference':
      return 'any';
    case 'repeat':
      return firstSet(node.body);
    case 'alternation':
      return union(node.branches.map(firstSet));
    case 'sequence': {
      let first: CharSet = new Set<string>();
      for (const item of node.items) {
        first = union([first, firstSet(item)]);
        if (!canBeEmpty(item)) break;
      }
      return first;
    }
  }
}

/** Characters a node can consume last, mirroring `firstSet`. */
function lastSet(node: PatternNode): CharSet {
  const cached = lastSets.get(node);
  if (cached !== undefined) return cached;
  const last = computeLastSet(node);
  lastSets.set(node, last);
  return last;
}

function computeLastSet(node: PatternNode): CharSet {
  switch (node.kind) {
    case 'zero':
    case 'lookaround':
      return new Set<string>();
    case 'atom':
      return node.first;
    case 'reference':
      return 'any';
    case 'repeat':
      return lastSet(node.body);
    case 'alternation':
      return union(node.branches.map(lastSet));
    case 'sequence': {
      let last: CharSet = new Set<string>();
      for (let index = node.items.length - 1; index >= 0; index--) {
        const item = node.items[index];
        if (item === undefined) continue;
        last = union([last, lastSet(item)]);
        if (!canBeEmpty(item)) break;
      }
      return last;
    }
  }
}

/** Whether the node consumes characters. */
function consumesChars(node: PatternNode): boolean {
  const cached = consumers.get(node);
  if (cached !== undefined) return cached;
  const consumes = computeConsumesChars(node);
  consumers.set(node, consumes);
  return consumes;
}

function computeConsumesChars(node: PatternNode): boolean {
  switch (node.kind) {
    case 'zero':
    case 'lookaround':
      return false;
    case 'atom':
    case 'reference':
      return true;
    case 'repeat':
      return consumesChars(node.body);
    case 'alternation':
      return node.branches.some(consumesChars);
    case 'sequence':
      return node.items.some(consumesChars);
  }
}

/** Product of two repetition counts, saturated at Infinity. */
function product(left: number, right: number): number {
  if (left === Infinity || right === Infinity) return Infinity;
  return Math.min(left * right, Number.MAX_SAFE_INTEGER);
}

const repeatFactors = new WeakMap<PatternNode, number>();
const concatenatedRepeatFactors = new WeakMap<PatternNode, number>();

/** Combined repetition count within the node, saturated at Infinity. */
function repeatFactor(node: PatternNode): number {
  const cached = repeatFactors.get(node);
  if (cached !== undefined) return cached;
  const factor = computeRepeatFactor(node);
  repeatFactors.set(node, factor);
  return factor;
}

function computeRepeatFactor(node: PatternNode): number {
  switch (node.kind) {
    case 'zero':
    case 'atom':
    case 'reference':
      return 1;
    case 'lookaround':
      return repeatFactor(node.body);
    case 'sequence':
      return node.items.reduce(
        (factor, item) => Math.max(factor, repeatFactor(item)),
        concatenatedRepeatFactor(node)
      );
    case 'alternation':
      return node.branches.reduce((factor, branch) => Math.max(factor, repeatFactor(branch)), 1);
    case 'repeat':
      return product(node.max, repeatFactor(node.body));
  }
}

function concatenatedRepeatFactor(node: PatternNode): number {
  if (node.kind !== 'sequence') return 1;
  const cached = concatenatedRepeatFactors.get(node);
  if (cached !== undefined) return cached;
  let combined = 1;
  let multiplied = 0;
  let run = 1;
  let boundary: CharSet | undefined;
  const closeRun = () => {
    if (multiplied > 1) combined = Math.max(combined, run);
  };
  for (const item of node.items) {
    if (!consumesChars(item)) continue;
    const factor = repeatFactor(item);
    if (boundary !== undefined && overlaps(boundary, firstSet(item))) {
      run = product(run, factor);
    } else {
      closeRun();
      run = factor;
      multiplied = 0;
    }
    if (factor > 1) multiplied++;
    boundary = canBeEmpty(item)
      ? union([boundary ?? new Set<string>(), lastSet(item)])
      : lastSet(item);
  }
  closeRun();
  concatenatedRepeatFactors.set(node, combined);
  return combined;
}

/**
 * The first two characters a branch must consume, or null when that cannot be stated simply.
 * Two branches whose first characters match can still be told apart when both need a second
 * character and those second characters are disjoint.
 */
function literalPrefix(node: PatternNode): CharSet[] | null {
  switch (node.kind) {
    case 'zero':
    case 'lookaround':
      return [];
    case 'atom':
      return [node.first];
    case 'reference':
    case 'repeat':
    case 'alternation':
      return null;
    case 'sequence': {
      const chars: CharSet[] = [];
      for (const item of node.items) {
        const prefix = literalPrefix(item);
        if (prefix === null) return null;
        chars.push(...prefix);
        if (chars.length >= 2) return chars.slice(0, 2);
      }
      return chars;
    }
  }
}

function ambiguityIssue(node: PatternNode): string | null {
  switch (node.kind) {
    case 'alternation': {
      if (node.branches.some(canBeEmpty)) return PATTERN_ISSUE_MESSAGES.ambiguous;
      const sets = node.branches.map(firstSet);
      const prefixes = node.branches.map(literalPrefix);
      for (let left = 0; left + 1 < sets.length; left++) {
        const current = sets[left];
        if (current === undefined) continue;
        for (let right = left + 1; right < sets.length; right++) {
          const other = sets[right];
          if (other === undefined || !overlaps(current, other)) continue;
          const second = prefixes[left]?.[1];
          const otherSecond = prefixes[right]?.[1];
          if (second !== undefined && otherSecond !== undefined && !overlaps(second, otherSecond)) {
            continue;
          }
          return PATTERN_ISSUE_MESSAGES.ambiguous;
        }
      }
      for (const branch of node.branches) {
        const issue = ambiguityIssue(branch);
        if (issue) return issue;
      }
      return null;
    }
    case 'sequence': {
      for (const item of node.items) {
        const issue = ambiguityIssue(item);
        if (issue) return issue;
      }
      return null;
    }
    case 'repeat':
      return ambiguityIssue(node.body);
    case 'lookaround':
      return ambiguityIssue(node.body);
    default:
      return null;
  }
}

function firstIssue(node: PatternNode): string | null {
  switch (node.kind) {
    case 'reference':
      return PATTERN_ISSUE_MESSAGES.backreference;
    case 'repeat': {
      const inner = repeatFactor(node.body);
      if (
        node.max > 1 &&
        inner > 1 &&
        (node.max === Infinity || node.max * inner > MAX_NESTED_REPEAT)
      ) {
        return PATTERN_ISSUE_MESSAGES.nested;
      }
      const ambiguity = node.max > 1 ? ambiguityIssue(node.body) : null;
      return ambiguity ?? firstIssue(node.body);
    }
    case 'sequence': {
      for (const item of node.items) {
        const issue = firstIssue(item);
        if (issue) return issue;
      }
      if (concatenatedRepeatFactor(node) > MAX_NESTED_REPEAT) {
        return PATTERN_ISSUE_MESSAGES.nested;
      }
      return null;
    }
    case 'alternation': {
      for (const branch of node.branches) {
        const issue = firstIssue(branch);
        if (issue) return issue;
      }
      return null;
    }
    case 'lookaround':
      return firstIssue(node.body);
    default:
      return null;
  }
}

/** The first rule of the accepted subset the pattern breaks, or null when it is inside it. */
export function patternSafetyIssue(source: string): string | null {
  let node: PatternNode;
  try {
    node = new PatternParser(source).parse();
  } catch {
    return PATTERN_ISSUE_MESSAGES.unsupported;
  }
  return firstIssue(node);
}
