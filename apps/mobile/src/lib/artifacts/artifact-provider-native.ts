import { requireOptionalNativeModule } from 'expo';

/**
 * JS bridge to the platform artifact provider that makes the mirror browsable:
 * the iOS File Provider extension and the Android DocumentsProvider.
 *
 * The bridge is optional on two axes and both are absorbed here, so no call
 * site needs a guard. The Expo module is absent from a JS-only build and from
 * any host without a device, and the iOS domain entry point has no counterpart
 * on Android, whose provider is served in-process from `context.filesDir`.
 */

type ArtifactsProviderModule = {
  notifyArtifactsChanged: () => void;
  /** Registers the iOS File Provider domain; Android has no domain to register. */
  registerArtifactsProviderDomain?: () => void;
};

const nativeModule = requireOptionalNativeModule<ArtifactsProviderModule>('ArtifactsProvider');

/**
 * Tell the platform provider the mirror changed, so the phone's file browser
 * re-queries the root instead of showing a stale one. No-op without the module.
 */
export function notifyArtifactsChanged(): void {
  nativeModule?.notifyArtifactsChanged();
}

/**
 * Register the iOS File Provider domain that exposes the mirror. No-op when the
 * module or the entry point is absent.
 */
export function registerArtifactsProviderDomain(): void {
  nativeModule?.registerArtifactsProviderDomain?.();
}
