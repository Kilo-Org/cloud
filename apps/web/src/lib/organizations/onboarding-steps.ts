import * as z from 'zod';

export const ORGANIZATION_ONBOARDING_STEP_KEYS = [
  'source-control',
  'code-reviewer',
  'invite-team',
] as const;

export const OrganizationOnboardingStepKeySchema = z.enum(ORGANIZATION_ONBOARDING_STEP_KEYS);
export type OrganizationOnboardingStepKey = z.infer<typeof OrganizationOnboardingStepKeySchema>;
