import {
  createEmptyEnkryptOutputDetectors,
  createKiloDefaultEnkryptInputDetectors,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detectors';
import {
  applyKiloDefaultPreset,
  createPolicyRule,
  draftsEqual,
  fromDraft,
  fromDraftDetectors,
  getEnkryptGuardrailsIssues,
  getEnkryptOutputGuardrailIssues,
  issueAt,
  parseLineList,
  toDraft,
  toDraftDetectors,
  type EnkryptGuardrailsDraft,
} from './enkrypt-guardrails-draft';
import { KILO_DEFAULT_POLICY_TEXT } from './kilo-default-policy';

function offOutput() {
  return { enabled: false, detectors: createEmptyEnkryptOutputDetectors() };
}

function policyRules(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    ...createPolicyRule([]),
    id: `rule-${index}`,
    text: 'Do not share customer records.',
  }));
}

function enabledDraft(): EnkryptGuardrailsDraft {
  return toDraft({
    enabled: true,
    detectors: createKiloDefaultEnkryptInputDetectors(),
    output: offOutput(),
  });
}

describe('parseLineList', () => {
  it('trims, drops blank lines, and removes duplicates', () => {
    expect(parseLineList(' Acme \n\nGlobal Enterprises\nAcme\n')).toEqual([
      'Acme',
      'Global Enterprises',
    ]);
  });
});

describe('draft conversion', () => {
  it('round-trips keyword and topic lists through editable text', () => {
    const detectors = createKiloDefaultEnkryptInputDetectors();
    detectors.keyword_detector = {
      enabled: true,
      action: 'block',
      banned_keywords: ['Project Phoenix', 'Acme'],
    };
    detectors.topic_detector.topic = ['weapons'];

    const draft = toDraftDetectors(detectors);
    expect(draft.keyword_detector.banned_keywords).toBe('Project Phoenix\nAcme');
    expect(fromDraftDetectors(draft)).toEqual(detectors);
  });

  it('round-trips the whole configuration', () => {
    const outputDetectors = createEmptyEnkryptOutputDetectors();
    outputDetectors.keyword_detector = { enabled: true, action: 'log', banned_keywords: ['Acme'] };
    outputDetectors.topic_detector = { enabled: true, action: 'block', topic: ['weapons'] };
    const config = {
      enabled: true,
      detectors: createKiloDefaultEnkryptInputDetectors(),
      output: { enabled: true, detectors: outputDetectors },
    };
    const draft = toDraft(config);
    expect(draft.output.detectors.topic_detector).toEqual({
      enabled: true,
      action: 'block',
      topic: 'weapons',
    });
    expect(fromDraft(draft)).toEqual(config);
  });
});

describe('draftsEqual', () => {
  it('ignores key order and list formatting that would save the same configuration', () => {
    const draft = enabledDraft();
    const reordered: EnkryptGuardrailsDraft = {
      output: draft.output,
      detectors: Object.fromEntries(
        Object.entries(draft.detectors).reverse()
      ) as EnkryptGuardrailsDraft['detectors'],
      enabled: draft.enabled,
    };
    expect(draftsEqual(draft, reordered)).toBe(true);

    const edited = enabledDraft();
    edited.detectors.keyword_detector.banned_keywords = '\n';
    expect(draftsEqual(draft, edited)).toBe(true);

    edited.detectors.keyword_detector.banned_keywords = 'Acme';
    expect(draftsEqual(draft, edited)).toBe(false);
  });

  it('ignores only output changes when output is excluded', () => {
    const saved = enabledDraft();
    const edited = enabledDraft();
    edited.output.enabled = true;
    edited.output.detectors.toxicity.enabled = true;

    expect(draftsEqual(saved, edited)).toBe(false);
    expect(draftsEqual(saved, edited, false)).toBe(true);

    edited.enabled = false;
    expect(draftsEqual(saved, edited, false)).toBe(false);
  });
});

describe('applyKiloDefaultPreset', () => {
  it('restores the default detector selection and turns on the Kilo default policy text', () => {
    const { detectors } = enabledDraft();
    const rules = [{ ...createPolicyRule([]), text: 'No customer data.' }];
    detectors.injection_attack = { enabled: true, action: 'log' };
    detectors.toxicity.enabled = true;
    detectors.keyword_detector = { enabled: true, action: 'log', banned_keywords: 'Acme' };
    detectors.policy_violation = {
      enabled: false,
      action: 'log',
      format: 'rules',
      policy_text: 'Old policy.',
      rules,
    };

    const preset = applyKiloDefaultPreset(detectors);
    expect(preset.injection_attack).toEqual({ enabled: true, action: 'block' });
    expect(preset.toxicity.enabled).toBe(false);
    expect(preset.keyword_detector).toEqual({
      enabled: false,
      action: 'log',
      banned_keywords: 'Acme',
    });
    expect(preset.policy_violation).toEqual({
      enabled: true,
      action: 'block',
      format: 'policy_text',
      policy_text: KILO_DEFAULT_POLICY_TEXT,
      rules,
    });
  });

  it('produces a configuration that saves as is', () => {
    const draft = enabledDraft();
    draft.detectors = applyKiloDefaultPreset(draft.detectors);

    expect(getEnkryptGuardrailsIssues(draft).size).toBe(0);
    expect(fromDraft(draft).detectors.policy_violation.policy_text).toBe(KILO_DEFAULT_POLICY_TEXT);
    expect(KILO_DEFAULT_POLICY_TEXT).toBe(KILO_DEFAULT_POLICY_TEXT.trim());
  });
});

describe('createPolicyRule', () => {
  it('picks the next unused rule ID', () => {
    const first = createPolicyRule([]);
    expect(first.id).toBe('rule-1');
    expect(createPolicyRule([first, { ...first, id: 'rule-3' }]).id).toBe('rule-4');
    expect(createPolicyRule([{ ...first, id: 'rule-2' }]).id).toBe('rule-3');
  });
});

describe('getEnkryptGuardrailsIssues', () => {
  it('reports nothing for Kilo Default, on or off', () => {
    expect(getEnkryptGuardrailsIssues(enabledDraft()).size).toBe(0);
    expect(getEnkryptGuardrailsIssues({ ...enabledDraft(), enabled: false }).size).toBe(0);
  });

  it('reports when no configurable detector is on, counting log only, only while guardrails are on', () => {
    const draft = enabledDraft();
    draft.detectors.injection_attack.enabled = false;
    draft.detectors.toxicity.enabled = true;
    expect(issueAt(getEnkryptGuardrailsIssues(draft), 'detectors')).toBe(
      'Turn on at least one input detector.'
    );
    expect(getEnkryptGuardrailsIssues({ ...draft, enabled: false }).size).toBe(0);

    draft.detectors.policy_violation = {
      enabled: true,
      action: 'log',
      format: 'policy_text',
      policy_text: 'No customer data.',
      rules: [],
    };
    expect(getEnkryptGuardrailsIssues(draft).size).toBe(0);
  });

  it('keeps reporting invalid detector settings while guardrails are off, since they are saved', () => {
    const draft = { ...enabledDraft(), enabled: false };
    draft.detectors.keyword_detector = { enabled: true, action: 'block', banned_keywords: '' };
    expect(issueAt(getEnkryptGuardrailsIssues(draft), 'keyword_detector')).toBe(
      'Add at least one keyword.'
    );
  });

  it('maps schema issues to the fields that caused them', () => {
    const draft = enabledDraft();
    draft.detectors.policy_violation = {
      enabled: true,
      action: 'block',
      format: 'rules',
      policy_text: '',
      rules: [{ ...createPolicyRule([]), text: '' }],
    };

    const issues = getEnkryptGuardrailsIssues(draft);
    expect(issueAt(issues, 'policy_violation.rules')).toBe(
      'Describe what the rule forbids or requires.'
    );
    expect(issueAt(issues, 'policy_violation.rules.0.text')).toBe(
      'Describe what the rule forbids or requires.'
    );
    expect(issueAt(issues, 'policy_violation.rules.0.id')).toBeUndefined();
  });

  it('skips invalid output when excluded without skipping input validation', () => {
    const draft = enabledDraft();
    draft.output.enabled = true;
    draft.output.detectors.topic_detector = { enabled: true, action: 'block', topic: '' };

    expect(getEnkryptGuardrailsIssues(draft).get('output.topic_detector.topic')).toBe(
      'Add at least one topic.'
    );
    expect(getEnkryptGuardrailsIssues(draft, false).size).toBe(0);

    draft.detectors.keyword_detector = { enabled: true, action: 'block', banned_keywords: '' };
    const issues = getEnkryptGuardrailsIssues(draft, false);
    expect(issueAt(issues, 'keyword_detector')).toBe('Add at least one keyword.');
    expect(issueAt(issues, 'output')).toBeUndefined();
  });

  it('caps structured rules at five and policy text at 10,000 characters', () => {
    const draft = enabledDraft();
    draft.detectors.policy_violation = {
      enabled: true,
      action: 'block',
      format: 'rules',
      policy_text: '',
      rules: policyRules(5),
    };
    expect(getEnkryptGuardrailsIssues(draft).size).toBe(0);

    draft.detectors.policy_violation.rules = policyRules(6);
    expect(getEnkryptGuardrailsIssues(draft).get('policy_violation.rules')).toBe(
      'Add up to 5 rules.'
    );

    draft.detectors.policy_violation = {
      enabled: true,
      action: 'block',
      format: 'policy_text',
      policy_text: 'x'.repeat(10_000),
      rules: [],
    };
    expect(getEnkryptGuardrailsIssues(draft).size).toBe(0);

    draft.detectors.policy_violation.policy_text = 'x'.repeat(10_001);
    expect(issueAt(getEnkryptGuardrailsIssues(draft), 'policy_violation.policy_text')).toBe(
      'Policy text can be up to 10,000 characters.'
    );
  });
});

describe('getEnkryptOutputGuardrailIssues', () => {
  it('reports nothing while output guardrails are off and no detector is set', () => {
    expect(getEnkryptOutputGuardrailIssues(enabledDraft().output).size).toBe(0);
  });

  it('requires an output detector while output guardrails are on', () => {
    const { output } = enabledDraft();
    output.enabled = true;
    expect(issueAt(getEnkryptOutputGuardrailIssues(output), 'detectors')).toBe(
      'Turn on at least one output detector.'
    );

    output.detectors.toxicity = { enabled: true, action: 'log' };
    expect(getEnkryptOutputGuardrailIssues(output).size).toBe(0);
  });

  it('is reported under output. in the whole configuration', () => {
    const draft = enabledDraft();
    draft.output.detectors.topic_detector = { enabled: true, action: 'block', topic: '' };

    const issues = getEnkryptGuardrailsIssues(draft);
    expect(issueAt(issues, 'output.topic_detector.topic')).toBe('Add at least one topic.');
    expect(issueAt(issues, 'topic_detector')).toBeUndefined();
  });

  it('caps structured rules at five', () => {
    const { output } = enabledDraft();
    output.enabled = true;
    output.detectors.policy_violation = {
      enabled: true,
      action: 'block',
      format: 'rules',
      policy_text: '',
      rules: policyRules(6),
    };

    expect(getEnkryptOutputGuardrailIssues(output).get('policy_violation.rules')).toBe(
      'Add up to 5 rules.'
    );
  });
});
