import { type NativeModule, requireOptionalNativeModule } from 'expo';

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
};

const nativeModule = requireOptionalNativeModule<SurfaceGeometryModule>('KiloSurfaceGeometry');

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
