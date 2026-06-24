import type {
  OrganizationOnboardingChecklist,
  OrganizationOnboardingStepKey,
} from '@/lib/organizations/onboarding-checklist';

export const ORGANIZATION_ONBOARDING_SCREENS = [
  'github',
  'code-reviewer',
  'invite-team',
  'complete',
] as const;

export type OrganizationOnboardingScreen = (typeof ORGANIZATION_ONBOARDING_SCREENS)[number];

type SearchParamReader = {
  get(name: string): string | null;
};

export function getOrganizationOnboardingScreen(
  searchParams: SearchParamReader
): OrganizationOnboardingScreen | null {
  const step = searchParams.get('step');
  return ORGANIZATION_ONBOARDING_SCREENS.find(screen => screen === step) ?? null;
}

export function getFirstIncompleteOnboardingScreen(
  checklist: OrganizationOnboardingChecklist
): OrganizationOnboardingScreen {
  return checklist.steps.find(step => !step.done)?.key ?? 'complete';
}

export function buildOrganizationWelcomePath(
  organizationId: string,
  screen: OrganizationOnboardingScreen,
  extraParams?: Record<string, string>
): string {
  const params = new URLSearchParams({ step: screen, ...extraParams });
  return `/organizations/${organizationId}/welcome?${params.toString()}`;
}

export function getNextOnboardingScreen(
  screen: OrganizationOnboardingScreen
): OrganizationOnboardingScreen {
  const index = ORGANIZATION_ONBOARDING_SCREENS.indexOf(screen);
  return ORGANIZATION_ONBOARDING_SCREENS[
    Math.min(index + 1, ORGANIZATION_ONBOARDING_SCREENS.length - 1)
  ];
}

export function getPreviousOnboardingScreen(
  screen: OrganizationOnboardingScreen
): OrganizationOnboardingScreen | null {
  const index = ORGANIZATION_ONBOARDING_SCREENS.indexOf(screen);
  return index > 0 ? ORGANIZATION_ONBOARDING_SCREENS[index - 1] : null;
}

export function isOnboardingStepKey(
  screen: OrganizationOnboardingScreen
): screen is OrganizationOnboardingStepKey {
  return screen !== 'complete';
}
