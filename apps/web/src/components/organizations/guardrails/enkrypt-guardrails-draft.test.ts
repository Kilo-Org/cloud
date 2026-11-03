import { createKiloDefaultEnkryptInputDetectors } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detectors';
import {
  applyKiloDefaultPreset,
  createPolicyRule,
  draftsEqual,
  fromDraft,
  fromDraftDetectors,
  getEnkryptGuardrailsIssues,
  issueAt,
  parseLineList,
  toDraft,
  toDraftDetectors,
  type EnkryptGuardrailsDraft,
} from './enkrypt-guardrails-draft';

function enabledDraft(): EnkryptGuardrailsDraft {
  return toDraft({
    enabled: true,
    scan_tool_results: false,
    detectors: createKiloDefaultEnkryptInputDetectors(),
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
    const config = {
      enabled: true,
      scan_tool_results: true,
      detectors: createKiloDefaultEnkryptInputDetectors(),
    };
    expect(fromDraft(toDraft(config))).toEqual(config);
  });
});

describe('draftsEqual', () => {
  it('ignores key order and list formatting that would save the same configuration', () => {
    const draft = enabledDraft();
    const reordered: EnkryptGuardrailsDraft = {
      scan_tool_results: draft.scan_tool_results,
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
});

describe('applyKiloDefaultPreset', () => {
  it('restores the default detector selection but keeps entered lists and policies', () => {
    const { detectors } = enabledDraft();
    detectors.injection_attack.enabled = false;
    detectors.pii = { enabled: false, action: 'block', entities: ['url'] };
    detectors.toxicity.enabled = true;
    detectors.keyword_detector = { enabled: true, action: 'log', banned_keywords: 'Acme' };
    detectors.policy_violation = {
      enabled: true,
      format: 'policy_text',
      policy_text: 'No customer data.',
      rules: [],
    };

    const preset = applyKiloDefaultPreset(detectors);
    expect(preset.injection_attack.enabled).toBe(true);
    expect(preset.pii).toEqual({ enabled: true, action: 'log', entities: ['secrets'] });
    expect(preset.toxicity.enabled).toBe(false);
    expect(preset.keyword_detector).toEqual({
      enabled: false,
      action: 'log',
      banned_keywords: 'Acme',
    });
    expect(preset.policy_violation).toEqual({
      enabled: false,
      format: 'policy_text',
      policy_text: 'No customer data.',
      rules: [],
    });
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

  it('reports when no detector is enabled only while guardrails are on', () => {
    const draft = enabledDraft();
    draft.detectors.injection_attack.enabled = false;
    draft.detectors.pii.enabled = false;
    expect(issueAt(getEnkryptGuardrailsIssues(draft), 'detectors')).toBe(
      'Turn on at least one detector.'
    );
    expect(getEnkryptGuardrailsIssues({ ...draft, enabled: false }).size).toBe(0);
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
});
