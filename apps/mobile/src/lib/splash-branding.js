// @ts-check
/**
 * The launch splash's own branding: the mark's asset, the field behind it and
 * the mark's size in dp. app.config.ts paints them natively through the
 * `withBrandedSplash` plugin, and `AnimatedSplashOverlay` paints the same ones
 * while the native splash hides, so the handover never moves or resizes
 * anything. Plain .js because scripts/assert-expo-config.mjs runs under plain
 * Node, which cannot load workspace TS (same reason env-keys.js exists).
 * Checked by the mobile typecheck through tsconfig include — keep the entry.
 */

/** The mark, as the project-relative specifier `withBrandedSplash` hands to
 *  expo-splash-screen. */
export const SPLASH_LOGO_IMAGE = './assets/images/logo-mark.png';

/** The field the native splash and the overlay paint behind the mark. */
export const SPLASH_BACKGROUND_COLOR = '#FFDD00';

/** The launch splash's own mark, in dp. The branded splash plugin paints it
 *  natively from these numbers and `AnimatedSplashOverlay` paints the same one
 *  while the native splash hides, so the handover never moves or resizes it. */
export const SPLASH_LOGO_SIZE = 100;

/** The ring the overlay paints around the mark, on each side of it. */
const SPLASH_DISC_RING = 10;

/** The reveal disc: the mark plus its ring, the halo the wipe grows from. */
export const SPLASH_DISC_SIZE = SPLASH_LOGO_SIZE + SPLASH_DISC_RING * 2;
