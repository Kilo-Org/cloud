import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import {
  FAKE_ONBOARDING_STEP_PARAM,
  parseClawOnboardingFakeStep,
} from '@/app/(app)/claw/components/ClawOnboardingFlow.state';
import { OrgClawNewClient } from './OrgClawNewClient';

type OrgClawNewPageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function OrgClawNewPage({ params, searchParams }: OrgClawNewPageProps) {
  const resolvedSearchParams = await searchParams;
  const fakeOnboardingStep =
    process.env.NODE_ENV === 'production'
      ? null
      : parseClawOnboardingFakeStep(
          getSearchParam(resolvedSearchParams, FAKE_ONBOARDING_STEP_PARAM)
        );

  return (
    <OrganizationByPageLayout
      params={params}
      render={org => (
        <OrgClawNewClient
          organizationId={org.organization.id}
          fakeOnboardingStep={fakeOnboardingStep}
        />
      )}
    />
  );
}

function getSearchParam(
  params: Record<string, string | string[] | undefined>,
  key: string
): string | null {
  const value = params[key];
  return typeof value === 'string' ? value : null;
}
