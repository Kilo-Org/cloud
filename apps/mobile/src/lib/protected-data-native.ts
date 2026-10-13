import { type NativeModule, requireOptionalNativeModule } from 'expo';

import { setProtectedDataAvailable } from '@/lib/protected-data';

type ProtectedDataEvents = {
  onProtectedDataChange: (event: { available: boolean }) => void;
};

type ProtectedDataModule = InstanceType<typeof NativeModule<ProtectedDataEvents>> & {
  isProtectedDataAvailable: () => boolean;
};

/**
 * Feeds the iOS protected-data state into `lib/protected-data`. Called from
 * the app entry before any module reads the keychain, so the startup
 * credential preload and a headless task already see a locked device. Android
 * has no module: its keystore does not lock with the screen, so the data stays
 * available.
 */
export function installProtectedDataSource(): void {
  const nativeModule = requireOptionalNativeModule<ProtectedDataModule>('KiloProtectedData');
  if (!nativeModule) {
    return;
  }
  // Subscribe before the first read, so a change between the two is not lost.
  nativeModule.addListener('onProtectedDataChange', ({ available }) => {
    setProtectedDataAvailable(available);
  });
  setProtectedDataAvailable(nativeModule.isProtectedDataAvailable());
}
