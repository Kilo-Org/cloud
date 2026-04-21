import {
  FAKE_ONBOARDING_STEP_PARAM,
  parseClawOnboardingFakeStep,
} from '../components/ClawOnboardingFlow.state';
import { ClawNewClient } from './ClawNewClient';

type ClawNewPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ClawNewPage({ searchParams }: ClawNewPageProps) {
  const params = await searchParams;
  const fakeOnboardingStep =
    process.env.NODE_ENV === 'production'
      ? null
      : parseClawOnboardingFakeStep(getSearchParam(params, FAKE_ONBOARDING_STEP_PARAM));

  return <ClawNewClient fakeOnboardingStep={fakeOnboardingStep} />;
}

function getSearchParam(
  params: Record<string, string | string[] | undefined>,
  key: string
): string | null {
  const value = params[key];
  return typeof value === 'string' ? value : null;
}
