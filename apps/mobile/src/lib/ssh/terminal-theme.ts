import { type TerminalTheme } from '@kilocode/react-native-ssh';

/**
 * The two terminal palettes.
 *
 * They are designed against the terminal's own background rather than copied
 * from the app's surfaces: each of the sixteen ANSI colours clears WCAG AA
 * (4.5:1) against the background it is painted on, so the coloured output of a
 * tool — a diff, a linter, a shell prompt — stays readable in both schemes.
 * `terminal-theme.test.ts` holds that measurement.
 */
export const LIGHT_TERMINAL_THEME: TerminalTheme = {
  foreground: '#14130F',
  background: '#FFFFFF',
  cursor: '#4F5A10',
  selection: '#4F5A1033',
  ansi: [
    '#1F1F1F',
    '#B3261E',
    '#1D6B32',
    '#8A5A00',
    '#1D4ED8',
    '#8B2C86',
    '#0E6E7A',
    '#3A3A3A',
    '#565656',
    '#D1342B',
    '#2A8043',
    '#A06A00',
    '#2A62F0',
    '#A03E9B',
    '#147C8A',
    '#14130F',
  ],
};

export const DARK_TERMINAL_THEME: TerminalTheme = {
  foreground: '#F2F0EB',
  background: '#0E0E10',
  cursor: '#FFDD00',
  selection: '#FFDD0033',
  ansi: [
    '#7C7C86',
    '#FF8C80',
    '#7FD08B',
    '#EFC46B',
    '#8FB6FF',
    '#E39BE0',
    '#6FD3D8',
    '#C9C6CF',
    '#8C8A94',
    '#FFA79C',
    '#95E39E',
    '#F7D488',
    '#A9C7FF',
    '#EFB6EC',
    '#8FE4E8',
    '#F2F0EB',
  ],
};

export function terminalThemeFor(dark: boolean): TerminalTheme {
  return dark ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME;
}
