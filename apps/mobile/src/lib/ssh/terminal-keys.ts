export type TerminalKeyId =
  | 'esc'
  | 'tab'
  | 'ctrl'
  | 'alt'
  | 'left'
  | 'up'
  | 'down'
  | 'right'
  | 'pipe'
  | 'tilde'
  | 'slash'
  | 'dash';

export type TerminalKey = Readonly<{
  id: TerminalKeyId;
  /** The keycap's own name, as every terminal names it; not prose. */
  label: string;
}>;

/** The key bar, in the order it shows them: the arrows read left to right. */
export const TERMINAL_KEYS: readonly TerminalKey[] = [
  { id: 'esc', label: 'Esc' },
  { id: 'ctrl', label: 'Ctrl' },
  { id: 'alt', label: 'Alt' },
  { id: 'tab', label: 'Tab' },
  { id: 'left', label: '←' },
  { id: 'up', label: '↑' },
  { id: 'down', label: '↓' },
  { id: 'right', label: '→' },
  { id: 'pipe', label: '|' },
  { id: 'tilde', label: '~' },
  { id: 'slash', label: '/' },
  { id: 'dash', label: '-' },
];

/** The bytes a bar key sends as they are, before any sticky modifier. */
const KEY_SEQUENCES = {
  esc: '\u001B',
  tab: '\t',
  left: '\u001B[D',
  down: '\u001B[B',
  up: '\u001B[A',
  right: '\u001B[C',
  pipe: '|',
  tilde: '~',
  slash: '/',
  dash: '-',
} satisfies Record<Exclude<TerminalKeyId, 'ctrl' | 'alt'>, string>;

export function keySequence(id: Exclude<TerminalKeyId, 'ctrl' | 'alt'>): string {
  return KEY_SEQUENCES[id];
}

/** `c` with Control held: the byte the shell reads as an interrupt. */
export function controlSequence(letter: string): string {
  const code = letter.toLowerCase().codePointAt(0) ?? 0;
  return String.fromCodePoint(code - 96);
}

/** `c` with Alt held: the escape prefix every terminal sends. */
export function altSequence(letter: string): string {
  return `\u001B${letter}`;
}

/**
 * The letters the sticky-modifier row offers, most used first: interrupt,
 * end-of-input, suspend, reverse-search, clear, start-of-line, then the rest of
 * the alphabet, so the pairs a shell is driven with need no scrolling.
 */
export const MODIFIER_LETTERS: readonly string[] = [
  'c',
  'd',
  'z',
  'r',
  'l',
  'a',
  'e',
  'u',
  'w',
  'k',
  'b',
  'f',
  'g',
  'h',
  'i',
  'j',
  'm',
  'n',
  'o',
  'p',
  'q',
  's',
  't',
  'v',
  'x',
  'y',
];
