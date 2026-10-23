import { type NativeModule, requireOptionalNativeModule } from 'expo';

/**
 * The `KiloFontScale` module: the live system font scale and its change
 * events.
 *
 * This is the one place the app reaches `expo`'s module registry for the font
 * scale, so a test project that has no Expo runtime can mock this module
 * instead (see `vitest.setup.ts`).
 */

type FontScaleModule = InstanceType<
  typeof NativeModule<{ onFontScaleChange: (event: { fontScale: number }) => void }>
> & {
  getFontScale: () => number;
};

const nativeModule = requireOptionalNativeModule<FontScaleModule>('KiloFontScale');

export function readLiveFontScale(): number {
  const scale = nativeModule?.getFontScale() ?? 1;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

export function subscribeToFontScale(
  listener: (fontScale: number) => void
): { remove(): void } | null {
  return (
    nativeModule?.addListener('onFontScaleChange', event => {
      listener(event.fontScale);
    }) ?? null
  );
}
