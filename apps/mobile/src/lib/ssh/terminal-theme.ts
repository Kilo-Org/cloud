import { type TerminalTheme } from '../../../modules/kilo-ssh/src';

/**
 * The terminal is dark in both app schemes, which is DESIGN.md's terminal
 * component: a shell is a dark surface wherever it is embedded, and one palette
 * is one place to keep readable. `surface.inset` is the background and
 * `syntax.plain` the default text.
 *
 * The sixteen ANSI slots keep their conventional roles: 0 is near the
 * background, 7 and 15 are the light neutrals text falls back to, 8 is the dim
 * neutral that still has to read, and each bright is at least 15 L* from its
 * normal so bold output stays distinguishable from plain.
 *
 * `terminal-theme.test.ts` holds the measurements: every colour that is drawn as
 * text clears WCAG AA (4.5:1) on the background, and ANSI 0 clears it on the six
 * colour slots it is used over (tmux's status bar, htop's keys, a diff badge).
 */
export const TERMINAL_BACKGROUND = '#101010';

export const TERMINAL_THEME: TerminalTheme = {
  foreground: '#E6E4E0',
  background: TERMINAL_BACKGROUND,
  cursor: '#FFDD00',
  selection: '#FFDD0033',
  ansi: [
    '#1C1C1C',
    '#E5544B',
    '#4FBF6A',
    '#D8A94A',
    '#6C9BF2',
    '#C77ADF',
    '#4FC4CE',
    '#C9C7C2',
    '#8A8A8F',
    '#FF9C8C',
    '#67F98A',
    '#FFE363',
    '#95D7FF',
    '#FFAEFF',
    '#67FFFF',
    '#F4F2EF',
  ],
};
