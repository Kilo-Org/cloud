import { afterEach, describe, expect, test } from '@jest/globals';
import { KILO_ORGANIZATION_ID } from '@kilocode/web-shared/lib/organizations/constants';
import { isDirectCloudByokAvailable } from './direct-cloud-byok';

describe('isDirectCloudByokAvailable', () => {
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

      expect(isDirectCloudByokAvailable(undefined)).toBe(true);
      expect(isDirectCloudByokAvailable('00000000-0000-4000-8000-000000000001')).toBe(true);
    }
  );

  test('is available only to the Kilo organization in production', () => {
    process.env.VERCEL_TARGET_ENV = 'production';

    expect(isDirectCloudByokAvailable(KILO_ORGANIZATION_ID)).toBe(true);
    expect(isDirectCloudByokAvailable('00000000-0000-4000-8000-000000000001')).toBe(false);
    expect(isDirectCloudByokAvailable(undefined)).toBe(false);
  });
});
