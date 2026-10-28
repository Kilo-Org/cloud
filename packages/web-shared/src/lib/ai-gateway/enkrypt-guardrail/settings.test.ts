import { describe, expect, it } from '@jest/globals';
import type { OrganizationSettings } from '@kilocode/db/schema-types';
import { createKiloDefaultEnkryptInputDetectors } from './detectors';
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
      'an invalid guardrail',
      { enkrypt: { input_guardrail: { enabled: 'yes' } } } as unknown as OrganizationSettings,
    ],
  ] satisfies [string, OrganizationSettings | undefined][])('is off for %s', (_name, settings) => {
    expect(resolve(settings)).toBeNull();
  });

  it('applies Kilo Default and scans tool results when no detectors were saved', () => {
    expect(resolve({ enkrypt: { input_guardrail: { enabled: true } } })).toEqual({
      scanToolResults: true,
      status: 'ready',
      detectors: {
        injection_attack: { enabled: true, need_explanation: false },
        pii: { enabled: true, entities: ['secrets'] },
      },
      blockingDetectors: ['injection_attack'],
    });
  });

  it('uses the saved detectors and scope', () => {
    const detectors = createKiloDefaultEnkryptInputDetectors();
    detectors.pii.action = 'block';
    detectors.keyword_detector = { enabled: true, action: 'log', banned_keywords: ['Phoenix'] };

    expect(
      resolve({
        enkrypt: { input_guardrail: { enabled: true, scan_tool_results: false, detectors } },
      })
    ).toEqual({
      scanToolResults: false,
      status: 'ready',
      detectors: {
        injection_attack: { enabled: true, need_explanation: false },
        pii: { enabled: true, entities: ['secrets'] },
        keyword_detector: { enabled: true, banned_keywords: ['Phoenix'] },
      },
      blockingDetectors: ['injection_attack', 'pii'],
    });
  });

  it('is off when the saved detectors enable none', () => {
    const detectors = createKiloDefaultEnkryptInputDetectors();
    detectors.injection_attack.enabled = false;
    detectors.pii.enabled = false;

    expect(resolve({ enkrypt: { input_guardrail: { enabled: true, detectors } } })).toBeNull();
  });

  it('reports invalid saved detectors instead of weakening the policy', () => {
    expect(
      resolve({
        enkrypt: { input_guardrail: { enabled: true, detectors: { injection_attack: true } } },
      })
    ).toEqual({ scanToolResults: true, status: 'invalid' });
  });
});
