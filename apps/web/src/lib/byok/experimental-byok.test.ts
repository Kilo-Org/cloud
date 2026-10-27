import { afterEach, describe, expect, test } from '@jest/globals';
import { KILO_ORGANIZATION_ID } from '@kilocode/web-shared/lib/organizations/constants';
import { isExperimentalByokEnabled } from './experimental-byok';

describe('isExperimentalByokEnabled', () => {
  const originalTargetEnv = process.env.VERCEL_TARGET_ENV;

  afterEach(() => {
    if (originalTargetEnv === undefined) delete process.env.VERCEL_TARGET_ENV;
    else process.env.VERCEL_TARGET_ENV = originalTargetEnv;
  });

  test.each([undefined, 'preview', 'staging', 'development'])(
    'is available to everyone when the target environment is %s',
    targetEnv => {
      if (targetEnv === undefined) delete process.env.VERCEL_TARGET_ENV;
      else process.env.VERCEL_TARGET_ENV = targetEnv;

      expect(isExperimentalByokEnabled(undefined)).toBe(true);
      expect(isExperimentalByokEnabled('00000000-0000-4000-8000-000000000001')).toBe(true);
    }
  );

  test('is available only to the Kilo organization in production', () => {
    process.env.VERCEL_TARGET_ENV = 'production';

    expect(isExperimentalByokEnabled(KILO_ORGANIZATION_ID)).toBe(true);
    expect(isExperimentalByokEnabled('00000000-0000-4000-8000-000000000001')).toBe(false);
    expect(isExperimentalByokEnabled(undefined)).toBe(false);
  });
});
