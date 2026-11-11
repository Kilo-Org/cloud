import { describe, expect, it } from '@jest/globals';
import type { OrganizationSettings } from '@kilocode/db/schema-types';
import {
  createEmptyEnkryptOutputDetectors,
  createKiloDefaultEnkryptInputDetectors,
  type EnkryptDetectRequestDetectors,
} from './detectors';
import {
  enkryptInputGuardrailAppliesTo,
  enkryptInputGuardrailGroupId,
  resolveEnkryptInputGuardrail,
  resolveEnkryptOutputGuardrail,
  splitEnkryptInputGuardrail,
  type EnkryptInputGuardrailConfig,
} from './settings';

const organizationId = '00000000-0000-4000-8000-000000000002';
const groupId = '00000000-0000-4000-8000-000000000003';
const otherGroupId = '00000000-0000-4000-8000-000000000004';

function resolve(settings: OrganizationSettings | undefined) {
  return resolveEnkryptInputGuardrail(
    organizationId,
    settings && { kilo_encrypt: true, ...settings }
  );
}

describe('resolveEnkryptInputGuardrail', () => {
  it.each([
    ['not granted', { enkrypt: { input_guardrail: { enabled: true } } }],
    ['revoked', { kilo_encrypt: false, enkrypt: { input_guardrail: { enabled: true } } }],
  ] satisfies [string, OrganizationSettings][])(
    'is off when kilo_encrypt is %s, even with the guardrail enabled',
    (_name, settings) => {
      expect(resolveEnkryptInputGuardrail(organizationId, settings)).toBeNull();
    }
  );

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

  it('applies Kilo Default, logging prompt injection, and scans tool results when no detectors were saved', () => {
    expect(resolve({ enkrypt: { input_guardrail: { enabled: true } } })).toEqual({
      status: 'ready',
      detectors: {
        injection_attack: { enabled: true, need_explanation: false },
      },
      blockingDetectors: [],
    });
  });

  it('uses the saved configurable detectors and scans tool results even if a save turned them off', () => {
    const detectors = createKiloDefaultEnkryptInputDetectors();
    detectors.injection_attack.action = 'block';
    detectors.policy_violation = {
      enabled: true,
      action: 'block',
      format: 'policy_text',
      policy_text: 'Never share customer records.',
      rules: [],
    };

    expect(
      resolve({
        enkrypt: { input_guardrail: { enabled: true, ...{ scan_tool_results: false }, detectors } },
      })
    ).toEqual({
      status: 'ready',
      detectors: {
        injection_attack: { enabled: true, need_explanation: false },
        policy_violation: {
          enabled: true,
          need_explanation: false,
          policy_text: 'Never share customer records.',
        },
      },
      blockingDetectors: ['injection_attack', 'policy_violation'],
    });
  });

  it('keeps blocking configurable detectors saved before they had an action', () => {
    const { injection_attack, policy_violation, ...others } =
      createKiloDefaultEnkryptInputDetectors();
    const detectors = {
      ...others,
      injection_attack: { enabled: injection_attack.enabled },
      policy_violation: {
        enabled: true,
        format: 'policy_text',
        policy_text: 'Never share customer records.',
        rules: policy_violation.rules,
      },
    };

    expect(resolve({ enkrypt: { input_guardrail: { enabled: true, detectors } } })).toMatchObject({
      status: 'ready',
      blockingDetectors: ['injection_attack', 'policy_violation'],
    });
  });

  it('scans log only configurable detectors in the log only call, never the blocking one', () => {
    const detectors = createKiloDefaultEnkryptInputDetectors();
    detectors.policy_violation = {
      enabled: true,
      action: 'log',
      format: 'policy_text',
      policy_text: 'Never share customer records.',
      rules: [],
    };
    const config = resolve({ enkrypt: { input_guardrail: { enabled: true, detectors } } });
    if (config?.status !== 'ready') throw new Error('Expected a ready guardrail');

    expect(config.blockingDetectors).toEqual([]);
    const { blocking, logOnly } = splitEnkryptInputGuardrail(config);
    expect(blocking).toBeNull();
    expect(logOnly).toEqual({
      ...config,
      blockingDetectors: [],
      detectors: {
        injection_attack: { enabled: true, need_explanation: false },
        policy_violation: {
          enabled: true,
          need_explanation: false,
          policy_text: 'Never share customer records.',
        },
      },
    });
  });

  it('ignores saved detectors that are not configurable', () => {
    const detectors = createKiloDefaultEnkryptInputDetectors();
    detectors.injection_attack.action = 'block';
    detectors.pii = { enabled: true, action: 'block', entities: ['secrets', 'url'] };
    detectors.nsfw.enabled = true;
    detectors.keyword_detector = { enabled: true, action: 'block', banned_keywords: ['Phoenix'] };
    detectors.toxicity.enabled = true;

    expect(resolve({ enkrypt: { input_guardrail: { enabled: true, detectors } } })).toEqual({
      status: 'ready',
      detectors: { injection_attack: { enabled: true, need_explanation: false } },
      blockingDetectors: ['injection_attack'],
    });
  });

  it('is off when only detectors that are not configurable were saved as enabled', () => {
    const detectors = createKiloDefaultEnkryptInputDetectors();
    detectors.injection_attack.enabled = false;
    detectors.pii.enabled = true;
    detectors.nsfw.enabled = true;

    expect(resolve({ enkrypt: { input_guardrail: { enabled: true, detectors } } })).toBeNull();
  });

  it('reports invalid saved detectors instead of weakening the policy', () => {
    expect(
      resolve({
        enkrypt: { input_guardrail: { enabled: true, detectors: { injection_attack: true } } },
      })
    ).toEqual({ status: 'invalid' });
  });

  it('logs prompt injection without blocking when Kilo Default was saved', () => {
    const detectors = createKiloDefaultEnkryptInputDetectors();

    expect(resolve({ enkrypt: { input_guardrail: { enabled: true, detectors } } })).toEqual({
      status: 'ready',
      detectors: { injection_attack: { enabled: true, need_explanation: false } },
      blockingDetectors: [],
    });
  });

  it('resolves the same guardrail whether or not it is limited to a group', () => {
    expect(resolve({ enkrypt: { input_guardrail: { enabled: true, group_id: groupId } } })).toEqual(
      resolve({ enkrypt: { input_guardrail: { enabled: true } } })
    );
  });
});

describe('enkryptInputGuardrailGroupId', () => {
  it.each([
    ['no settings', undefined],
    ['no guardrail setting', {}],
    ['a guardrail without a group', { enkrypt: { input_guardrail: { enabled: true } } }],
    [
      'a guardrail with a null group',
      { enkrypt: { input_guardrail: { enabled: true, group_id: null } } },
    ],
    [
      'a guardrail with an empty group',
      { enkrypt: { input_guardrail: { enabled: true, group_id: '' } } },
    ],
    [
      'a guardrail with a group that is not a UUID',
      { enkrypt: { input_guardrail: { enabled: true, group_id: 'engineering' } } },
    ],
    [
      'an invalid guardrail',
      {
        enkrypt: { input_guardrail: { enabled: 'yes', group_id: groupId } },
      } as unknown as OrganizationSettings,
    ],
  ] satisfies [string, OrganizationSettings | undefined][])('is null for %s', (_name, settings) => {
    expect(enkryptInputGuardrailGroupId(settings)).toBeNull();
  });

  it.each([true, false])('returns the saved group when the guardrail enabled is %s', enabled => {
    expect(
      enkryptInputGuardrailGroupId({ enkrypt: { input_guardrail: { enabled, group_id: groupId } } })
    ).toBe(groupId);
  });
});

describe('enkryptInputGuardrailAppliesTo', () => {
  const limited: OrganizationSettings = {
    kilo_encrypt: true,
    enkrypt: { input_guardrail: { enabled: true, group_id: groupId } },
  };

  it('applies to every member when the guardrail is not limited to a group', () => {
    const settings: OrganizationSettings = {
      kilo_encrypt: true,
      enkrypt: { input_guardrail: { enabled: true } },
    };

    expect(enkryptInputGuardrailAppliesTo(settings, [])).toBe(true);
    expect(enkryptInputGuardrailAppliesTo(settings, [otherGroupId])).toBe(true);
    expect(enkryptInputGuardrailAppliesTo(undefined, [])).toBe(true);
  });

  it('applies to members of the group', () => {
    expect(enkryptInputGuardrailAppliesTo(limited, [otherGroupId, groupId])).toBe(true);
  });

  it('does not apply to members outside the group', () => {
    expect(enkryptInputGuardrailAppliesTo(limited, [])).toBe(false);
    expect(enkryptInputGuardrailAppliesTo(limited, [otherGroupId])).toBe(false);
  });
});

describe('splitEnkryptInputGuardrail', () => {
  const detectors = {
    injection_attack: { enabled: true, need_explanation: false },
    pii: { enabled: true, entities: ['secrets'] },
    bias: { enabled: true },
  } satisfies EnkryptDetectRequestDetectors;

  it('scans blocking and log-only detectors separately', () => {
    expect(
      splitEnkryptInputGuardrail({
        status: 'ready',
        detectors,
        blockingDetectors: ['injection_attack'],
      })
    ).toEqual({
      blocking: {
        status: 'ready',
        detectors: { injection_attack: detectors.injection_attack },
        blockingDetectors: ['injection_attack'],
      },
      logOnly: {
        status: 'ready',
        detectors: { pii: detectors.pii, bias: detectors.bias },
        blockingDetectors: [],
      },
    });
  });

  it('makes only a blocking scan when every detector blocks', () => {
    const config: EnkryptInputGuardrailConfig = {
      status: 'ready',
      detectors,
      blockingDetectors: ['injection_attack', 'pii', 'bias'],
    };

    expect(splitEnkryptInputGuardrail(config)).toEqual({ blocking: config, logOnly: null });
  });

  it('makes only a log-only scan when every detector only logs', () => {
    const config: EnkryptInputGuardrailConfig = {
      status: 'ready',
      detectors: { pii: detectors.pii, bias: detectors.bias },
      blockingDetectors: [],
    };

    expect(splitEnkryptInputGuardrail(config)).toEqual({ blocking: null, logOnly: config });
  });

  it('keeps an invalid configuration blocking so it fails closed', () => {
    const config: EnkryptInputGuardrailConfig = { status: 'invalid' };

    expect(splitEnkryptInputGuardrail(config)).toEqual({ blocking: config, logOnly: null });
  });
});

describe('resolveEnkryptOutputGuardrail', () => {
  function resolveOutput(settings: OrganizationSettings) {
    return resolveEnkryptOutputGuardrail(organizationId, { kilo_encrypt: true, ...settings });
  }

  function savedOutputDetectors() {
    const detectors = createEmptyEnkryptOutputDetectors();
    detectors.pii = { enabled: true, action: 'block', entities: ['secrets'] };
    detectors.keyword_detector = { enabled: true, action: 'log', banned_keywords: ['Phoenix'] };
    detectors.topic_detector = { enabled: true, action: 'block', topic: ['weapons'] };
    detectors.toxicity = { enabled: true, action: 'block' };
    detectors.nsfw = { enabled: true, action: 'log' };
    return detectors;
  }

  it.each([
    ['no settings', {}],
    ['no output guardrail setting', { enkrypt: {} }],
    ['only an input guardrail', { enkrypt: { input_guardrail: { enabled: true } } }],
    [
      'a disabled output guardrail',
      { enkrypt: { output_guardrail: { enabled: false, detectors: savedOutputDetectors() } } },
    ],
    [
      'an invalid output guardrail',
      { enkrypt: { output_guardrail: { enabled: 'yes' } } } as unknown as OrganizationSettings,
    ],
  ] satisfies [string, OrganizationSettings][])('is off for %s', (_name, settings) => {
    expect(resolveOutput(settings)).toBeNull();
  });

  it.each([
    ['not granted', undefined],
    ['revoked', false],
  ] as const)('is off when kilo_encrypt is %s', (_name, kiloEncrypt) => {
    expect(
      resolveEnkryptOutputGuardrail(organizationId, {
        kilo_encrypt: kiloEncrypt,
        enkrypt: { output_guardrail: { enabled: true, detectors: savedOutputDetectors() } },
      })
    ).toBeNull();
  });

  it('applies no default preset when no detectors were saved', () => {
    expect(resolveOutput({ enkrypt: { output_guardrail: { enabled: true } } })).toBeNull();
  });

  it('is off when the saved detectors enable none', () => {
    expect(
      resolveOutput({
        enkrypt: {
          output_guardrail: { enabled: true, detectors: createEmptyEnkryptOutputDetectors() },
        },
      })
    ).toBeNull();
  });

  it('reports invalid saved detectors instead of disabling the guardrail', () => {
    expect(
      resolveOutput({ enkrypt: { output_guardrail: { enabled: true, detectors: { pii: 'bad' } } } })
    ).toEqual({ status: 'invalid' });
  });

  it('maps the saved detectors to the Enkrypt request and blocks only on block actions', () => {
    expect(
      resolveOutput({
        enkrypt: { output_guardrail: { enabled: true, detectors: savedOutputDetectors() } },
      })
    ).toEqual({
      status: 'ready',
      detectors: {
        pii: { enabled: true, entities: ['secrets'] },
        keyword_detector: { enabled: true, banned_keywords: ['Phoenix'] },
        topic_detector: { enabled: true, topic: ['weapons'] },
        toxicity: { enabled: true },
        nsfw: { enabled: true },
      },
      blockingDetectors: ['pii', 'topic_detector', 'toxicity'],
    });
  });

  it('is unaffected by the input guardrail settings', () => {
    const outputGuardrail = { enabled: true, detectors: savedOutputDetectors() };

    expect(
      resolveOutput({
        enkrypt: {
          input_guardrail: { enabled: true, detectors: { injection_attack: true } },
          output_guardrail: outputGuardrail,
        },
      })
    ).toEqual(resolveOutput({ enkrypt: { output_guardrail: outputGuardrail } }));
  });

  it.each(['block', 'log'] as const)('keeps the saved NSFW output action %s', action => {
    const detectors = createEmptyEnkryptOutputDetectors();
    detectors.nsfw = { enabled: true, action };

    expect(resolveOutput({ enkrypt: { output_guardrail: { enabled: true, detectors } } })).toEqual({
      status: 'ready',
      detectors: { nsfw: { enabled: true } },
      blockingDetectors: action === 'block' ? ['nsfw'] : [],
    });
  });
});
