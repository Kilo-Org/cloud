import { TRIAL_DURATION_DAYS } from '@kilocode/web-shared/lib/constants';

/**
 * The trial the organization-creation procedure grants. It covers the first
 * organization a creator makes, so every surface that offers it names that
 * scope instead of promising a window to each creation. The duration comes
 * from the shared constant the creation path reads, so the copy cannot drift
 * from the grant.
 */
export const FIRST_ORGANIZATION_TRIAL_OFFER = `Your first organization includes a ${TRIAL_DURATION_DAYS}-day Enterprise trial.`;
