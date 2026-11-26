import { resetAdminNetworkConfigForTest } from '@kilocode/web-shared/lib/admin/admin-network';

/** A client address inside the list {@link withEnforcedAdminNetwork} sets. */
export const ALLOWED_ADMIN_ADDRESS = { 'x-vercel-forwarded-for': '203.0.113.7' };
/** A client address outside that list. */
export const OFF_NETWORK_ADDRESS = { 'x-vercel-forwarded-for': '198.51.100.1' };

/**
 * Runs `run` as a Vercel request whose admin network list is 203.0.113.0/24,
 * so the staff guard enforces the network check, then restores the
 * environment.
 */
export async function withEnforcedAdminNetwork<T>(run: () => Promise<T>): Promise<T> {
  const env: Record<string, string | undefined> = process.env;
  const original = { VERCEL: env.VERCEL, ADMIN_ALLOWED_NETWORKS: env.ADMIN_ALLOWED_NETWORKS };
  env.VERCEL = '1';
  env.ADMIN_ALLOWED_NETWORKS = '203.0.113.0/24';
  resetAdminNetworkConfigForTest();
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    resetAdminNetworkConfigForTest();
  }
}

/** Runs `run` with admin step-up enforcement on, then restores the switch. */
export async function withAdminStepUpEnabled<T>(run: () => Promise<T>): Promise<T> {
  const original = process.env.ADMIN_STEP_UP_ENABLED;
  process.env.ADMIN_STEP_UP_ENABLED = 'true';
  try {
    return await run();
  } finally {
    if (original === undefined) delete process.env.ADMIN_STEP_UP_ENABLED;
    else process.env.ADMIN_STEP_UP_ENABLED = original;
  }
}
