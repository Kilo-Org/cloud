import { darkColors } from './theme-colors.generated';

type Palette = { readonly [K in keyof typeof darkColors]: string };

/**
 * Whether the palette in hand is the dark one.
 *
 * The app's theme is exactly the palette it resolved, so the background slot
 * identifies it without reading the platform appearance. Controls that need a
 * theme-dependent colour for a single native value — the switch's off track —
 * use this instead of asking the platform, so a mounted suite that stubs the
 * native modules still resolves a palette.
 */
export function isDarkPalette(colors: Palette): boolean {
  return colors.background === darkColors.background;
}
