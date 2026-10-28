import {
  ENKRYPT_DETECTOR_IDS,
  ENKRYPT_DETECTOR_LIMITS,
  EnkryptInputDetectorsSchema,
  type EnkryptInputDetectors,
  type EnkryptPolicyRule,
} from '@kilocode/db/schema-types';
import {
  blockingEnkryptDetectorIds,
  buildEnkryptDetectRequestDetectors,
  createKiloDefaultEnkryptInputDetectors,
  ENKRYPT_BLOCK_DETECTOR_IDS,
  ENKRYPT_DETECTOR_TYPES,
  ENKRYPT_REVISE_DETECTOR_IDS,
  ENKRYPT_SUMMARY_DETECTORS,
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
    injection_attack: { enabled: true },
    pii: { enabled: true, action: 'block', entities: ['pii', 'secrets', 'ip_address', 'url'] },
    keyword_detector: { enabled: true, action: 'block', banned_keywords: ['Project Phoenix'] },
    topic_detector: { enabled: true, topic: ['weapons'] },
    policy_violation: { enabled: true, format: 'rules', policy_text: 'Old text', rules: [rule] },
    toxicity: { enabled: true },
    nsfw: { enabled: true },
    bias: { enabled: true, action: 'log' },
    sponge_attack: { enabled: true },
  };
}

function issueMessages(input: unknown) {
  const result = EnkryptInputDetectorsSchema.safeParse(input);
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

describe('detector metadata', () => {
  it('splits every detector by its Enkrypt type', () => {
    expect([...ENKRYPT_BLOCK_DETECTOR_IDS, ...ENKRYPT_REVISE_DETECTOR_IDS].sort()).toEqual(
      [...ENKRYPT_DETECTOR_IDS].sort()
    );
    for (const id of ENKRYPT_BLOCK_DETECTOR_IDS) expect(ENKRYPT_DETECTOR_TYPES[id]).toBe('block');
    for (const id of ENKRYPT_REVISE_DETECTOR_IDS) {
      expect(ENKRYPT_DETECTOR_TYPES[id]).toBe('revise');
    }
  });

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
  it('blocks on enabled block-type detectors and on revise-type detectors set to block', () => {
    expect(blockingEnkryptDetectorIds(createKiloDefaultEnkryptInputDetectors())).toEqual([
      'injection_attack',
    ]);
    expect(blockingEnkryptDetectorIds(allEnabled())).toEqual([
      'injection_attack',
      'pii',
      'keyword_detector',
      'topic_detector',
      'policy_violation',
      'toxicity',
      'nsfw',
      'sponge_attack',
    ]);
  });
});

describe('buildEnkryptDetectRequestDetectors', () => {
  it('sends prompt injection and secrets for Kilo Default', () => {
    expect(buildEnkryptDetectRequestDetectors(createKiloDefaultEnkryptInputDetectors())).toEqual({
      injection_attack: { enabled: true, need_explanation: false },
      pii: { enabled: true, entities: ['secrets'] },
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
    expect(buildEnkryptDetectRequestDetectors(detectors)).toEqual({});
  });
});
