import { describe, expect, it } from 'vitest';
import { parseE2BReleaseConfig } from './e2b-runtime-config.js';

const env = {
  E2B_SANDBOX_TEMPLATE: 'kilo/kilo-cloud-agent:11111111-1111-4111-8111-111111111111',
  E2B_SANDBOX_TEMPLATE_ID: 'template-id',
  E2B_SANDBOX_RUNTIME_BUILD_ID: 'e2b-runtime-build',
};

describe('E2B release admission configuration', () => {
  it('requires the complete immutable release identity', () => {
    expect(parseE2BReleaseConfig(env)).toEqual({
      templateId: env.E2B_SANDBOX_TEMPLATE_ID,
      templateReference: env.E2B_SANDBOX_TEMPLATE,
      runtimeBuildId: env.E2B_SANDBOX_RUNTIME_BUILD_ID,
    });
    for (const key of Object.keys(env)) {
      expect(() => parseE2BReleaseConfig({ ...env, [key]: '' })).toThrow();
    }
  });

  it.each([
    'kilo-cloud-agent',
    'kilo/kilo-cloud-agent',
    'kilo/kilo-cloud-agent:default',
    'kilo/kilo-cloud-agent:production',
    'kilo/kilo-cloud-agent:11111111-1111-4111-8111-111111111111/extra',
  ])('rejects mutable or malformed template %s', template => {
    expect(() => parseE2BReleaseConfig({ ...env, E2B_SANDBOX_TEMPLATE: template })).toThrow();
  });
});
