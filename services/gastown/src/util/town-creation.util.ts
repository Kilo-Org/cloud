import { findUserById } from './user-db.util';

const MINIMUM_ACCOUNT_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

type TownCreationEligibility =
  | { allowed: true }
  | { allowed: false; code: 'FORBIDDEN' | 'SERVICE_UNAVAILABLE'; message: string };

export async function checkTownCreationEligibility(
  env: Env,
  userId: string
): Promise<TownCreationEligibility> {
  let user;
  try {
    user = await findUserById(env.HYPERDRIVE.connectionString, userId);
  } catch {
    return {
      allowed: false,
      code: 'SERVICE_UNAVAILABLE',
      message: 'Unable to verify account age. Please try again.',
    };
  }

  if (!user) {
    return { allowed: false, code: 'FORBIDDEN', message: 'Account not found' };
  }

  const createdAt = new Date(user.created_at).getTime();
  if (!Number.isFinite(createdAt)) {
    return {
      allowed: false,
      code: 'SERVICE_UNAVAILABLE',
      message: 'Unable to verify account age. Please try again.',
    };
  }

  if (Date.now() - createdAt < MINIMUM_ACCOUNT_AGE_MS) {
    return {
      allowed: false,
      code: 'FORBIDDEN',
      message: 'Your account must be at least 7 days old to create a town.',
    };
  }

  return { allowed: true };
}
