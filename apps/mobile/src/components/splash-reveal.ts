import { makeMutable } from 'react-native-reanimated';

/**
 * Scale applied to the whole app tree while the splash overlay reveals it.
 * `AnimatedSplashOverlay` writes it; the content wrapper in
 * `src/app/_layout.tsx` reads it.
 *
 * Module state rather than context: the writer and the reader are siblings,
 * and the value must outlive the overlay's own unmount at the end of the
 * reveal. It stays at 1 unless a reveal actually runs, so a fast refresh or a
 * reduced-motion launch never scales the tree.
 */
export const splashContentScale = makeMutable(1);

/** How far the app content is scaled up before the reveal settles it to 1. */
export const SPLASH_CONTENT_OVERSCAN = 1.04;
