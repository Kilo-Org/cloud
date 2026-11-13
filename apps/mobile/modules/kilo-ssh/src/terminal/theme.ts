import type { NativeTerminalTheme, TerminalTheme } from './terminal.types';

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export const DEFAULT_TERMINAL_THEME: Required<TerminalTheme> = {
  foreground: '#d8dee9',
  background: '#101418',
  cursor: '#d8dee9',
  selection: '#553b82c4',
  ansi: [
    '#1b2027',
    '#d06a6a',
    '#8fbf7f',
    '#d6b36a',
    '#6c9fd8',
    '#b48ead',
    '#6fb6bf',
    '#c3c9d4',
    '#5a6472',
    '#e08a8a',
    '#a8d49a',
    '#e7cb88',
    '#8ab8e8',
    '#c9a6cd',
    '#8fd0d8',
    '#f0f3f7',
  ],
};

export function parseColor(value: string): number {
  if (!HEX.test(value)) {
    throw new Error(`Invalid terminal colour: ${value}`);
  }

  const hex = value.slice(1);
  const expanded = hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex;
  const argb = expanded.length === 6 ? `ff${expanded}` : expanded;
  return parseInt(argb, 16) | 0;
}

export function resolveTheme(theme: TerminalTheme = {}): NativeTerminalTheme {
  const ansi = theme.ansi ?? DEFAULT_TERMINAL_THEME.ansi;
  if (ansi.length !== 16) {
    throw new Error(`A terminal theme needs 16 ANSI colours, received ${ansi.length}`);
  }

  return {
    foreground: parseColor(theme.foreground ?? DEFAULT_TERMINAL_THEME.foreground),
    background: parseColor(theme.background ?? DEFAULT_TERMINAL_THEME.background),
    cursor: parseColor(theme.cursor ?? DEFAULT_TERMINAL_THEME.cursor),
    selection: parseColor(theme.selection ?? DEFAULT_TERMINAL_THEME.selection),
    ansi: ansi.map(parseColor),
  };
}
