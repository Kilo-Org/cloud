import { describe, expect, it } from '@jest/globals';
import type { OrganizationSettings } from '@kilocode/db/schema-types';
import { resolveEnkryptInputGuardrail } from './settings';

const organizationId = '00000000-0000-4000-8000-000000000002';

function resolve(settings: OrganizationSettings | undefined) {
  return resolveEnkryptInputGuardrail(organizationId, settings);
}

describe('resolveEnkryptInputGuardrail', () => {
  it.each([
    ['no settings', undefined],
    ['no guardrail setting', { data_collection: 'deny' }],
    ['an Enkrypt setting without a guardrail', { enkrypt: {} }],
    ['a disabled guardrail', { enkrypt: { input_guardrail: { enabled: false } } }],
    [
      'no enabled detector',
      { enkrypt: { input_guardrail: { enabled: true, detectors: { injection_attack: false } } } },
    ],
    [
      'an invalid guardrail',
      { enkrypt: { input_guardrail: { enabled: 'yes' } } } as unknown as OrganizationSettings,
    ],
  ] satisfies [string, OrganizationSettings | undefined][])('is off for %s', (_name, settings) => {
    expect(resolve(settings)).toBeNull();
  });

  it('defaults to injection and secrets detection, failing open', () => {
    expect(resolve({ enkrypt: { input_guardrail: { enabled: true } } })).toEqual({
      failMode: 'open',
      detectors: {
        injection_attack: { enabled: true, need_explanation: false },
        pii: { enabled: true, entities: ['secrets'] },
      },
    });
  });

  it('enables only the configured detectors', () => {
    expect(
      resolve({
        enkrypt: {
          input_guardrail: {
            enabled: true,
            fail_mode: 'closed',
            detectors: { toxicity: true, nsfw: true, pii_entities: ['pii', 'pii'] },
          },
        },
      })
    ).toEqual({
      failMode: 'closed',
      detectors: {
        pii: { enabled: true, entities: ['pii'] },
        nsfw: { enabled: true },
        toxicity: { enabled: true },
      },
    });
  });
});
