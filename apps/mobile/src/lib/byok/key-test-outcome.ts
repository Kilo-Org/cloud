import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { captureTelemetry } from '@/lib/telemetry/error-sink';
import { i18n } from '@/i18n';

type TestResult = inferRouterOutputs<MobileRouter>['byok']['testApiKey'];

/**
 * What one `Test key` tap announces. The server reports one of a fixed set of
 * verdicts on the stored key; the app says which in its own words. The
 * provider's own text stays on the server, because it can quote the upstream
 * account and is untranslated.
 */
export function announceTestOutcome(result: TestResult): void {
  switch (result.outcome) {
    case 'ok': {
      announcingToast.success(
        i18n.t('profile.providerKeys.testSucceeded', {
          provider: result.provider,
          model: result.model,
        })
      );
      break;
    }
    case 'incomplete': {
      announcingToast.error(i18n.t('profile.providerKeys.testIncomplete'));
      break;
    }
    case 'rejected': {
      announcingToast.error(i18n.t('profile.providerKeys.testRejected'));
      break;
    }
    case 'unsupported-provider': {
      announcingToast.error(i18n.t('profile.providerKeys.testUnsupportedProvider'));
      break;
    }
    case 'unreadable-key': {
      announcingToast.error(i18n.t('profile.providerKeys.testUnreadableKey'));
      break;
    }
    case 'deprecated-provider': {
      announcingToast.error(i18n.t('profile.providerKeys.testDeprecatedProvider'));
      break;
    }
    case 'failed': {
      announcingToast.error(i18n.t('profile.providerKeys.testFailed'));
      break;
    }
    default: {
      // `result` is `never`: this build knows every outcome the union declares.
      // The union belongs to the server, and a build installed before the server
      // adds one still receives it, so the tap answers with the generic failure
      // copy and the outcome is recorded.
      captureTelemetry({
        level: 'warning',
        message: 'Unhandled BYOK key test outcome',
        extra: { result },
      });
      announcingToast.error(i18n.t('profile.providerKeys.testFailed'));
      break;
    }
  }
}
