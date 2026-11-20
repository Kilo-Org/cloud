import { type NativeModule, requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

export type NativeSurfaceGeometry = Readonly<{
  tag: number;
  visibleTop: number;
  visibleBottom: number;
  boundsHeight: number;
  safeAreaTop: number;
  safeAreaBottom: number;
}>;

type SurfaceGeometryEvents = {
  onSurfaceGeometryChange: (geometry: NativeSurfaceGeometry) => void;
};

type SurfaceGeometryModule = InstanceType<typeof NativeModule<SurfaceGeometryEvents>> & {
  observeSurface: (nativeViewTag: number) => Promise<NativeSurfaceGeometry>;
  unobserveSurface: (nativeViewTag: number) => Promise<void>;
  presentedSurfaceOriginTop?: (nativeViewTag: number) => Promise<number | null>;
};

/**
 * The native module, or null where the runtime does not expose it.
 *
 * `requireOptionalNativeModule` is the app's own lookup (a binary without the
 * module answers null). A test project that mocks the Expo runtime partially
 * omits it, and vitest throws on the property access itself rather than
 * answering undefined, so the lookup is guarded the same way
 * `readInitialWindowMetrics` guards its provider export.
 */
function requireGeometryModule(): SurfaceGeometryModule | null {
  try {
    return requireOptionalNativeModule<SurfaceGeometryModule>('KiloSurfaceGeometry') ?? null;
  } catch {
    return null;
  }
}

const nativeModule = requireGeometryModule();

export const isNativeSurfaceGeometryAvailable = nativeModule !== null;

export function addSurfaceGeometryListener(
  listener: (geometry: NativeSurfaceGeometry) => void
): { remove: () => void } | null {
  return nativeModule?.addListener('onSurfaceGeometryChange', listener) ?? null;
}

export async function observeSurface(nativeViewTag: number): Promise<NativeSurfaceGeometry> {
  if (!nativeModule) {
    throw new Error(
      'Native surface geometry requires a rebuilt iOS or Android development client.'
    );
  }
  if (!Number.isInteger(nativeViewTag) || nativeViewTag <= 0 || nativeViewTag > 2_147_483_647) {
    throw new RangeError('The native view tag must be a positive 32-bit integer.');
  }
  const geometry = await nativeModule.observeSurface(nativeViewTag);
  return geometry;
}

export async function unobserveSurface(nativeViewTag: number): Promise<void> {
  await nativeModule?.unobserveSurface(nativeViewTag);
}

/**
 * Where the surface's own origin sits in its window, in points, or null where
 * the runtime cannot answer.
 *
 * A presented sheet's offset is outside the React tree, so no JS read of its
 * content can see it. This is the iOS native read that does: 0 for a surface at
 * the window top, the status-bar inset for one presented below it. A binary that
 * predates it, or a view whose window is gone, answers null — the caller then
 * keeps the clearance its surface mode already reserved rather than guessing a
 * band from an absent read.
 *
 * iOS only, and answered here rather than in the native module's own shape: the
 * presentation offset comes from a `UISheetPresentationController`, and nothing
 * on Android reads this. Android presents a `formSheet` at the detent's height
 * and lays its content out itself, which the header's settled read already
 * covers, so the Android module carries no counterpart to keep unexercised.
 */
export async function presentedSurfaceOriginTop(nativeViewTag: number): Promise<number | null> {
  if (Platform.OS !== 'ios') {
    return null;
  }
  const read = nativeModule?.presentedSurfaceOriginTop;
  if (read === undefined) {
    return null;
  }
  if (!Number.isInteger(nativeViewTag) || nativeViewTag <= 0 || nativeViewTag > 2_147_483_647) {
    throw new RangeError('The native view tag must be a positive 32-bit integer.');
  }
  const origin = await read.call(nativeModule, nativeViewTag);
  // The native side answers a negative value for a view it cannot resolve; it
  // is an absence, not an origin above the window.
  return origin !== null && Number.isFinite(origin) && origin >= 0 ? origin : null;
}
