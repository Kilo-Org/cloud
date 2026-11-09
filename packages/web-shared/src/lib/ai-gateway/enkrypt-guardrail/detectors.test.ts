import type * as z from 'zod';
import {
  ENKRYPT_DETECTOR_IDS,
  ENKRYPT_DETECTOR_LIMITS,
  EnkryptInputDetectorsSchema,
  EnkryptInputDetectorsUpdateSchema,
  EnkryptOutputDetectorsSchema,
  EnkryptOutputDetectorsUpdateSchema,
  type EnkryptDetectorId,
  type EnkryptInputDetectors,
  type EnkryptOutputDetectors,
  type EnkryptPolicyRule,
} from '@kilocode/db/schema-types';
import {
  blockingEnkryptDetectorIds,
  blockingEnkryptOutputDetectorIds,
  buildEnkryptDetectRequestDetectors,
  createEmptyEnkryptOutputDetectors,
  createKiloDefaultEnkryptInputDetectors,
  enabledEnkryptDetectorIds,
  enabledEnkryptOutputDetectorIds,
  ENKRYPT_CONFIGURABLE_INPUT_DETECTOR_IDS,
  ENKRYPT_DETECTOR_TYPES,
  ENKRYPT_SUMMARY_DETECTORS,
  enforcedEnkryptInputDetectors,
  enkryptOutputDetectorsAsInputDetectors,
  storableEnkryptInputDetectors,
} from './detectors';

const rule: EnkryptPolicyRule = {
  id: 'priv-1',
  display_text: 'No customer records',
  text: 'User queries must not include customer account records.',
  risk_category: 'privacy_data_protection',
  applicability: 'user',
  severity: 'high',
  frameworks: ['gdpr'],
};

function allEnabled(): EnkryptInputDetectors {
  return {
    injection_attack: { enabled: true, action: 'block' },
    pii: { enabled: true, action: 'block', entities: ['pii', 'secrets', 'ip_address', 'url'] },
    keyword_detector: { enabled: true, action: 'block', banned_keywords: ['Project Phoenix'] },
    topic_detector: { enabled: true, topic: ['weapons'] },
    policy_violation: {
      enabled: true,
      action: 'block',
      format: 'rules',
      policy_text: 'Old text',
      rules: [rule],
    },
    toxicity: { enabled: true },
    nsfw: { enabled: true },
    bias: { enabled: true, action: 'log' },
    sponge_attack: { enabled: true },
  };
}

function issueMessages(input: unknown, schema: z.ZodType = EnkryptInputDetectorsSchema) {
  const result = schema.safeParse(input);
  return result.success
    ? []
    : result.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }));
}

describe('EnkryptInputDetectorsSchema', () => {
  it('accepts Kilo Default and a configuration with every detector enabled', () => {
    expect(issueMessages(createKiloDefaultEnkryptInputDetectors())).toEqual([]);
    expect(issueMessages(allEnabled())).toEqual([]);
  });

  it('rejects detectors that are not offered yet', () => {
    for (const detector of ['system_prompt', 'copyright_ip']) {
      expect(
        EnkryptInputDetectorsSchema.safeParse({ ...allEnabled(), [detector]: { enabled: true } })
          .success
      ).toBe(false);
    }
  });

  it('rejects block messages, explanations, and saved policy names', () => {
    const detectors = allEnabled();
    expect(
      EnkryptInputDetectorsSchema.safeParse({
        ...detectors,
        injection_attack: { enabled: true, need_explanation: true },
      }).success
    ).toBe(false);
    expect(
      EnkryptInputDetectorsSchema.safeParse({
        ...detectors,
        toxicity: { enabled: true, block_message: 'Blocked' },
      }).success
    ).toBe(false);
    expect(
      EnkryptInputDetectorsSchema.safeParse({
        ...detectors,
        policy_violation: { ...detectors.policy_violation, coc_policy_name: 'Saved policy' },
      }).success
    ).toBe(false);
  });

  it('requires a log or block action on revise-type detectors only', () => {
    const detectors = allEnabled();
    expect(
      EnkryptInputDetectorsSchema.safeParse({
        ...detectors,
        pii: { enabled: true, entities: ['secrets'] },
      }).success
    ).toBe(false);
    expect(
      EnkryptInputDetectorsSchema.safeParse({
        ...detectors,
        toxicity: { enabled: true, action: 'log' },
      }).success
    ).toBe(false);
  });

  it('reads configurable detectors saved without an action as blocking and accepts log only', () => {
    const { action: _injectionAction, ...injection_attack } = allEnabled().injection_attack;
    const { action: _policyAction, ...policy_violation } = allEnabled().policy_violation;
    const saved = EnkryptInputDetectorsSchema.parse({
      ...allEnabled(),
      injection_attack,
      policy_violation,
    });
    expect(saved.injection_attack).toEqual({ enabled: true, action: 'block' });
    expect(saved.policy_violation.action).toBe('block');

    const logOnly = allEnabled();
    logOnly.injection_attack.action = 'log';
    logOnly.policy_violation.action = 'log';
    expect(EnkryptInputDetectorsSchema.parse(logOnly)).toEqual(logOnly);
    expect(
      EnkryptInputDetectorsSchema.safeParse({
        ...allEnabled(),
        injection_attack: { enabled: true, action: 'revise' },
      }).success
    ).toBe(false);
  });

  it('requires the settings an enabled detector needs', () => {
    const detectors = allEnabled();
    detectors.pii.entities = [];
    detectors.keyword_detector.banned_keywords = [];
    detectors.topic_detector.topic = [];
    detectors.policy_violation.rules = [];

    expect(issueMessages(detectors)).toEqual([
      { path: 'pii.entities', message: 'Select at least one type of data to detect.' },
      { path: 'keyword_detector.banned_keywords', message: 'Add at least one keyword.' },
      { path: 'topic_detector.topic', message: 'Add at least one topic.' },
      { path: 'policy_violation.rules', message: 'Add at least one rule.' },
    ]);

    detectors.policy_violation = {
      enabled: true,
      action: 'block',
      format: 'policy_text',
      policy_text: ' ',
      rules: [],
    };
    expect(issueMessages(detectors)).toContainEqual({
      path: 'policy_violation.policy_text',
      message: 'Enter the policy text.',
    });
  });

  it('ignores missing settings on disabled detectors', () => {
    const detectors = createKiloDefaultEnkryptInputDetectors();
    detectors.pii = { enabled: false, action: 'log', entities: [] };
    expect(issueMessages(detectors)).toEqual([]);
  });

  it('bounds list sizes, string lengths, rule IDs, and total size', () => {
    const tooMany = allEnabled();
    tooMany.keyword_detector.banned_keywords = Array.from(
      { length: ENKRYPT_DETECTOR_LIMITS.keywords + 1 },
      (_, index) => `keyword-${index}`
    );
    expect(issueMessages(tooMany)).toContainEqual({
      path: 'keyword_detector.banned_keywords',
      message: 'Add up to 200 keywords.',
    });

    const longTopic = allEnabled();
    longTopic.topic_detector.topic = ['x'.repeat(ENKRYPT_DETECTOR_LIMITS.topicLength + 1)];
    expect(issueMessages(longTopic)).toContainEqual({
      path: 'topic_detector.topic.0',
      message: 'Each topic can be up to 100 characters.',
    });

    const badRules = allEnabled();
    badRules.policy_violation.rules = [rule, { ...rule, id: 'bad id' }];
    expect(issueMessages(badRules)).toContainEqual({
      path: 'policy_violation.rules.1.id',
      message: 'Rule IDs can only contain letters, numbers, dots, dashes, and underscores.',
    });

    const duplicateRules = allEnabled();
    duplicateRules.policy_violation.rules = [rule, rule];
    expect(issueMessages(duplicateRules)).toEqual([
      { path: 'policy_violation.rules.1.id', message: 'Rule IDs must be unique.' },
    ]);

    const oversized = allEnabled();
    oversized.policy_violation.rules = Array.from({ length: 50 }, (_, index) => ({
      ...rule,
      id: `rule-${index}`,
      text: 'x'.repeat(ENKRYPT_DETECTOR_LIMITS.ruleTextLength),
    }));
    oversized.keyword_detector.banned_keywords = Array.from({ length: 200 }, (_, index) =>
      `${index}`.padEnd(ENKRYPT_DETECTOR_LIMITS.keywordLength, 'k')
    );
    expect(issueMessages(oversized)).toEqual([
      {
        path: '',
        message:
          'This detector configuration is too large. Remove some keywords, topics, or rules.',
      },
    ]);
  });
});

describe('policy rule cap', () => {
  const rules = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ ...rule, id: `rule-${index}` }));
  const ruleIssue = { path: 'policy_violation.rules', message: 'Add up to 5 rules.' };

  it('caps saved input and output policies at five rules', () => {
    const input = allEnabled();
    input.policy_violation.rules = rules(5);
    expect(issueMessages(input, EnkryptInputDetectorsUpdateSchema)).toEqual([]);
    input.policy_violation.rules = rules(6);
    expect(issueMessages(input, EnkryptInputDetectorsUpdateSchema)).toEqual([ruleIssue]);

    const output = allOutputEnabled();
    output.policy_violation.rules = rules(5);
    expect(issueMessages(output, EnkryptOutputDetectorsUpdateSchema)).toEqual([]);
    output.policy_violation.rules = rules(6);
    expect(issueMessages(output, EnkryptOutputDetectorsUpdateSchema)).toEqual([ruleIssue]);
  });

  it('keeps reading policies saved with more rules before the cap, so they stay enforced', () => {
    const input = allEnabled();
    input.policy_violation.rules = rules(50);
    expect(issueMessages(input)).toEqual([]);
    input.policy_violation.rules = rules(51);
    expect(issueMessages(input)).toContainEqual(ruleIssue);

    const output = allOutputEnabled();
    output.policy_violation.rules = rules(50);
    expect(issueMessages(output, EnkryptOutputDetectorsSchema)).toEqual([]);
  });
});

describe('enforcedEnkryptInputDetectors', () => {
  it('keeps the configurable detectors and applies Kilo Default to every other one', () => {
    const detectors = allEnabled();
    const enforced = enforcedEnkryptInputDetectors(detectors);

    expect(enabledEnkryptDetectorIds(enforced)).toEqual([
      'injection_attack',
      'pii',
      'policy_violation',
      'nsfw',
    ]);
    expect(enforced.policy_violation).toBe(detectors.policy_violation);
    const configurable: readonly EnkryptDetectorId[] = ENKRYPT_CONFIGURABLE_INPUT_DETECTOR_IDS;
    for (const id of ENKRYPT_DETECTOR_IDS.filter(id => !configurable.includes(id))) {
      expect(enforced[id]).toEqual(createKiloDefaultEnkryptInputDetectors()[id]);
    }
  });

  it('logs NSFW content and secrets even when the saved detectors turned them off', () => {
    const detectors = createKiloDefaultEnkryptInputDetectors();
    detectors.injection_attack.enabled = false;
    detectors.pii = { enabled: false, action: 'block', entities: ['url'] };
    detectors.nsfw.enabled = false;
    const enforced = enforcedEnkryptInputDetectors(detectors);

    expect(buildEnkryptDetectRequestDetectors(enforced)).toEqual({
      pii: { enabled: true, entities: ['secrets'] },
      nsfw: { enabled: true },
    });
    expect(blockingEnkryptDetectorIds(enforced)).toEqual([]);
  });
});

describe('detector metadata', () => {
  it('maps every summary key to a typed detector', () => {
    for (const detector of Object.values(ENKRYPT_SUMMARY_DETECTORS)) {
      expect(ENKRYPT_DETECTOR_TYPES[detector]).toBeDefined();
    }
    expect(new Set(Object.values(ENKRYPT_SUMMARY_DETECTORS))).toEqual(
      new Set(Object.keys(ENKRYPT_DETECTOR_TYPES))
    );
  });
});

describe('blockingEnkryptDetectorIds', () => {
  it('blocks only on enabled configurable detectors set to block', () => {
    expect(blockingEnkryptDetectorIds(createKiloDefaultEnkryptInputDetectors())).toEqual([
      'injection_attack',
    ]);
    expect(blockingEnkryptDetectorIds(allEnabled())).toEqual([
      'injection_attack',
      'policy_violation',
    ]);
  });

  it('only logs configurable detectors set to log only', () => {
    const detectors = createKiloDefaultEnkryptInputDetectors();
    detectors.injection_attack.action = 'log';
    detectors.policy_violation = { ...allEnabled().policy_violation, action: 'log' };

    expect(enabledEnkryptDetectorIds(detectors)).toEqual([
      'injection_attack',
      'pii',
      'policy_violation',
      'nsfw',
    ]);
    expect(blockingEnkryptDetectorIds(detectors)).toEqual([]);
  });
});

describe('storableEnkryptInputDetectors', () => {
  it('saves blocking configurable detectors in the shape read before the action existed', () => {
    const detectors = allEnabled();
    const stored = storableEnkryptInputDetectors(detectors);

    expect(stored.injection_attack).toEqual({ enabled: true });
    expect(stored.policy_violation).not.toHaveProperty('action');
    expect(stored.toxicity).toEqual(detectors.toxicity);
    expect(EnkryptInputDetectorsSchema.parse(stored)).toEqual(detectors);
  });

  it('saves log only configurable detectors with their action', () => {
    const detectors = allEnabled();
    detectors.injection_attack.action = 'log';
    detectors.policy_violation.action = 'log';
    const stored = storableEnkryptInputDetectors(detectors);

    expect(stored.injection_attack).toEqual({ enabled: true, action: 'log' });
    expect(stored.policy_violation).toHaveProperty('action', 'log');
    expect(EnkryptInputDetectorsSchema.parse(stored)).toEqual(detectors);
  });

  it('drops the log only action from a detector turned off', () => {
    const detectors = allEnabled();
    detectors.injection_attack = { enabled: false, action: 'log' };
    detectors.policy_violation = { ...detectors.policy_violation, enabled: false, action: 'log' };
    const stored = storableEnkryptInputDetectors(detectors);

    expect(stored.injection_attack).toEqual({ enabled: false });
    expect(stored.policy_violation).not.toHaveProperty('action');
    expect(EnkryptInputDetectorsSchema.parse(stored).injection_attack).toEqual({
      enabled: false,
      action: 'block',
    });
  });
});

describe('buildEnkryptDetectRequestDetectors', () => {
  it('sends prompt injection, secrets, and NSFW for Kilo Default', () => {
    expect(buildEnkryptDetectRequestDetectors(createKiloDefaultEnkryptInputDetectors())).toEqual({
      injection_attack: { enabled: true, need_explanation: false },
      pii: { enabled: true, entities: ['secrets'] },
      nsfw: { enabled: true },
    });
  });

  it('serializes every enabled detector without Kilo-only fields', () => {
    expect(buildEnkryptDetectRequestDetectors(allEnabled())).toEqual({
      injection_attack: { enabled: true, need_explanation: false },
      pii: { enabled: true, entities: ['pii', 'secrets', 'ip_address', 'url'] },
      keyword_detector: { enabled: true, banned_keywords: ['Project Phoenix'] },
      topic_detector: { enabled: true, topic: ['weapons'] },
      policy_violation: {
        enabled: true,
        need_explanation: false,
        rules: [{ ...rule, source: 'user', suggested: false }],
      },
      toxicity: { enabled: true },
      nsfw: { enabled: true },
      bias: { enabled: true },
      sponge_attack: { enabled: true },
    });
  });

  it('sends policy text when that format is selected and omits empty rule names', () => {
    const detectors = createKiloDefaultEnkryptInputDetectors();
    detectors.policy_violation = {
      enabled: true,
      action: 'block',
      format: 'policy_text',
      policy_text: 'Do not share customer data.',
      rules: [{ ...rule, display_text: '' }],
    };
    expect(buildEnkryptDetectRequestDetectors(detectors).policy_violation).toEqual({
      enabled: true,
      need_explanation: false,
      policy_text: 'Do not share customer data.',
    });

    detectors.policy_violation.format = 'rules';
    expect(buildEnkryptDetectRequestDetectors(detectors).policy_violation).toEqual({
      enabled: true,
      need_explanation: false,
      rules: [
        {
          id: 'priv-1',
          text: rule.text,
          risk_category: 'privacy_data_protection',
          applicability: 'user',
          severity: 'high',
          frameworks: ['gdpr'],
          source: 'user',
          suggested: false,
        },
      ],
    });
  });

  it('omits disabled detectors', () => {
    const detectors = createKiloDefaultEnkryptInputDetectors();
    detectors.injection_attack.enabled = false;
    detectors.pii.enabled = false;
    detectors.nsfw.enabled = false;
    expect(buildEnkryptDetectRequestDetectors(detectors)).toEqual({});
  });
});

function allOutputEnabled(): EnkryptOutputDetectors {
  return {
    pii: { enabled: true, action: 'block', entities: ['pii', 'secrets'] },
    keyword_detector: { enabled: true, action: 'log', banned_keywords: ['Project Phoenix'] },
    topic_detector: { enabled: true, action: 'block', topic: ['weapons'] },
    policy_violation: {
      enabled: true,
      action: 'log',
      format: 'policy_text',
      policy_text: 'Do not share customer data.',
      rules: [rule],
    },
    toxicity: { enabled: true, action: 'block' },
    nsfw: { enabled: true, action: 'log' },
    bias: { enabled: true, action: 'block' },
  };
}

describe('createEmptyEnkryptOutputDetectors', () => {
  it('is a valid configuration with no detector enabled', () => {
    const detectors = createEmptyEnkryptOutputDetectors();

    expect(EnkryptOutputDetectorsSchema.safeParse(detectors).success).toBe(true);
    expect(enabledEnkryptOutputDetectorIds(detectors)).toEqual([]);
    expect(blockingEnkryptOutputDetectorIds(detectors)).toEqual([]);
  });

  it('accepts every output detector enabled', () => {
    expect(EnkryptOutputDetectorsSchema.safeParse(allOutputEnabled()).success).toBe(true);
  });
});

describe('enabledEnkryptOutputDetectorIds', () => {
  it('lists enabled output detectors in detector order', () => {
    const detectors = allOutputEnabled();
    detectors.keyword_detector.enabled = false;
    detectors.nsfw.enabled = false;

    expect(enabledEnkryptOutputDetectorIds(detectors)).toEqual([
      'pii',
      'topic_detector',
      'policy_violation',
      'toxicity',
      'bias',
    ]);
  });
});

describe('blockingEnkryptOutputDetectorIds', () => {
  it('blocks only on enabled detectors set to block', () => {
    const detectors = allOutputEnabled();
    detectors.bias.enabled = false;

    expect(blockingEnkryptOutputDetectorIds(detectors)).toEqual([
      'pii',
      'topic_detector',
      'toxicity',
    ]);
  });
});

describe('enkryptOutputDetectorsAsInputDetectors', () => {
  it('keeps each output detector setting and disables prompt-only detectors', () => {
    const detectors = allOutputEnabled();
    const input = enkryptOutputDetectorsAsInputDetectors(detectors);

    expect(EnkryptInputDetectorsSchema.safeParse(input).success).toBe(true);
    expect(input).toEqual({
      injection_attack: { enabled: false, action: 'block' },
      pii: detectors.pii,
      keyword_detector: detectors.keyword_detector,
      topic_detector: { enabled: true, topic: ['weapons'] },
      policy_violation: {
        enabled: true,
        action: 'log',
        format: 'policy_text',
        policy_text: 'Do not share customer data.',
        rules: [rule],
      },
      toxicity: { enabled: true },
      nsfw: { enabled: true },
      bias: detectors.bias,
      sponge_attack: { enabled: false },
    });
    expect(enabledEnkryptDetectorIds(input)).toEqual(enabledEnkryptOutputDetectorIds(detectors));
  });

  it('keeps disabled output detectors disabled', () => {
    expect(
      enabledEnkryptDetectorIds(
        enkryptOutputDetectorsAsInputDetectors(createEmptyEnkryptOutputDetectors())
      )
    ).toEqual([]);
  });
});
