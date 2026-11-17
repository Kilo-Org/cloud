import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import type * as ConstantsModule from '@kilocode/web-shared/lib/constants';

const env = process.env as Record<string, string | undefined>;

const savedEnv = {
  VERCEL_ENV: env.VERCEL_ENV,
  VERCEL_TARGET_ENV: env.VERCEL_TARGET_ENV,
  DEBUG_SHOW_DEV_UI: env.DEBUG_SHOW_DEV_UI,
  NODE_ENV: env.NODE_ENV,
};

function resetDeploymentEnv(): void {
  for (const key of ['VERCEL_ENV', 'VERCEL_TARGET_ENV', 'DEBUG_SHOW_DEV_UI'] as const) {
    delete env[key];
  }
}

// The constants read the environment at module load, so every case loads a fresh module.
function requireConstants(): typeof ConstantsModule {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  return require('@kilocode/web-shared/lib/constants') as typeof ConstantsModule;
}

beforeEach(() => {
  resetDeploymentEnv();
});

afterEach(() => {
  resetDeploymentEnv();
  if (savedEnv.NODE_ENV === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = savedEnv.NODE_ENV;
  for (const key of ['VERCEL_ENV', 'VERCEL_TARGET_ENV', 'DEBUG_SHOW_DEV_UI'] as const) {
    const value = savedEnv[key];
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  jest.resetModules();
});

describe('staging deployment detection', () => {
  test('reports a deployment outside staging when the build environment is production', () => {
    env.VERCEL_ENV = 'production';
    env.VERCEL_TARGET_ENV = 'staging';

    const constants = requireConstants();

    expect(constants.isStagingDeployment()).toBe(false);
    expect(constants.allow_fake_login).toBe(false);
  });

  test('treats a preview build on a staging target as staging', () => {
    env.VERCEL_ENV = 'preview';
    env.VERCEL_TARGET_ENV = 'staging';

    const constants = requireConstants();

    expect(constants.isStagingDeployment()).toBe(true);
    expect(constants.allow_fake_login).toBe(true);
  });

  test('treats a staging target without a build environment as staging', () => {
    env.VERCEL_TARGET_ENV = 'staging';

    const constants = requireConstants();

    expect(constants.isStagingDeployment()).toBe(true);
    expect(constants.allow_fake_login).toBe(true);
  });

  test('keeps the local development flag branch treating fake login as enabled', () => {
    env.DEBUG_SHOW_DEV_UI = '1';
    env.NODE_ENV = 'development';

    const constants = requireConstants();

    expect(constants.isStagingDeployment()).toBe(false);
    expect(constants.allow_fake_login).toBe(true);
  });

  test('keeps the local development flag branch blocking fake login in a production node environment', () => {
    env.DEBUG_SHOW_DEV_UI = '1';
    env.NODE_ENV = 'production';

    const constants = requireConstants();

    expect(constants.isStagingDeployment()).toBe(false);
    expect(constants.allow_fake_login).toBe(false);
  });
});
