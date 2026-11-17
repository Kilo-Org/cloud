import { captureException } from '@sentry/nextjs';

/**
 * Put the provider installation back after the Kilo integration write failed.
 *
 * The provider installation lives in the chat state store, which is separate
 * storage from the integration database transaction. When the transaction rolls
 * back, the installation it wrote stays stored, so the callback must revert it:
 * restore the installation this install replaced, or remove the one it created.
 */
export async function restoreProviderInstallation<T>(input: {
  provider: 'slack' | 'linear';
  previousInstallation: T | null;
  setInstallation: (installation: T) => Promise<void>;
  deleteInstallation: () => Promise<void>;
}): Promise<void> {
  try {
    if (input.previousInstallation) {
      await input.setInstallation(input.previousInstallation);
    } else {
      await input.deleteInstallation();
    }
  } catch (error) {
    // A failed reversion cannot be repaired here. Keep the original failure as
    // the callback's outcome and report this one so the next install can recover.
    captureException(error, {
      tags: {
        endpoint: `${input.provider}/callback`,
        source: `${input.provider}_oauth`,
      },
      extra: { stage: 'restore_provider_installation' },
    });
  }
}
