import { type AccessRequiredSubcase } from '@/lib/analytics/onboarding-events';

type CtaVariant = 'default' | 'outline';

type AccessRequiredPresentation = {
  body: string;
  ctaLabel: string | null;
  ctaVariant: CtaVariant | null;
  title: string;
};

const SUBSCRIBE_SUBCASES: ReadonlySet<AccessRequiredSubcase> = new Set([
  'trial_expired',
  'subscription_canceled',
  'subscription_past_due',
]);

const WEB_PRESENTATION: Record<AccessRequiredSubcase, AccessRequiredPresentation> = {
  trial_expired: {
    title: 'Subscribe on the web',
    body: "To keep using KiloClaw, go to kilo.ai/claw from your browser. You can't subscribe in the app.",
    ctaLabel: 'Open kilo.ai/claw',
    ctaVariant: 'default',
  },
  subscription_canceled: {
    title: 'Subscribe on the web',
    body: "To use KiloClaw, go to kilo.ai/claw from your browser. You can't subscribe in the app.",
    ctaLabel: 'Open kilo.ai/claw',
    ctaVariant: 'default',
  },
  subscription_past_due: {
    title: 'Update payment on the web',
    body: "We had trouble with your most recent payment. Go to kilo.ai/claw from your browser to update it. You can't manage billing in the app.",
    ctaLabel: 'Open kilo.ai/claw',
    ctaVariant: 'default',
  },
  quarantined: {
    title: 'Instance needs remediation',
    body: "Your KiloClaw instance is in a quarantined state and can't be used right now. Our team needs to help restore it.",
    ctaLabel: 'Continue on kilo.ai',
    ctaVariant: 'outline',
  },
  multiple_current_conflict: {
    title: 'Account needs review',
    body: "We found more than one active subscription on your account, so we've paused things to avoid double-billing you.",
    ctaLabel: 'Continue on kilo.ai',
    ctaVariant: 'outline',
  },
  non_canonical_earlybird: {
    title: 'Legacy plan detected',
    body: 'Your early-access plan needs a manual review before it can be used on mobile.',
    ctaLabel: 'Continue on kilo.ai',
    ctaVariant: 'outline',
  },
};

export function getAccessRequiredPresentation(
  subcase: AccessRequiredSubcase,
  platformOS: string
): AccessRequiredPresentation {
  if (platformOS !== 'ios') {
    return WEB_PRESENTATION[subcase];
  }

  if (SUBSCRIBE_SUBCASES.has(subcase)) {
    return {
      title: 'KiloClaw unavailable in iOS',
      body: 'KiloClaw access is not available in the iOS app for this account. Manage KiloClaw from your Kilo account on another device.',
      ctaLabel: null,
      ctaVariant: null,
    };
  }

  return {
    title: 'Account needs review',
    body: 'This KiloClaw account state needs review before it can be used in the iOS app.',
    ctaLabel: null,
    ctaVariant: null,
  };
}

export function getAccessRequiredOpenUrl(subcase: AccessRequiredSubcase, webBaseUrl: string) {
  return SUBSCRIBE_SUBCASES.has(subcase) ? `${webBaseUrl}/claw` : webBaseUrl;
}
