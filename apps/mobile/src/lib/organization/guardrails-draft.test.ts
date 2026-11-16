import { describe, expect, it } from 'vitest';

import { configKey, draftsEqual } from '@/lib/organization/guardrails-config-key';
import {
  applyKiloDefaultPreset,
  buildUpdateInput,
  detectorChoice,
  fromDraft,
  type OrgGuardrailsConfig,
  type OrgPolicyRule,
  parseLineList,
  toDraft,
  withInputDetectorChoice,
  withOutputDetectorChoice,
} from '@/lib/organization/guardrails-draft';
import { createPolicyRule, guardrailsIssues } from '@/lib/organization/guardrails-issues';

function rule(overrides: Partial<OrgPolicyRule> = {}): OrgPolicyRule {
  return { ...createPolicyRule([]), ...overrides };
}

function config(overrides: Partial<OrgGuardrailsConfig> = {}): OrgGuardrailsConfig {
  const base = {
    enabled: false,
    group_id: null,
    detectors: {
      injection_attack: { enabled: false, action: 'block' as const },
      pii: { enabled: false, action: 'block' as const, entities: ['secrets' as const] },
      keyword_detector: { enabled: false, action: 'block' as const, banned_keywords: [] },
      topic_detector: { enabled: false, topic: [] },
      policy_violation: {
        enabled: false,
        action: 'block' as const,
        format: 'rules' as const,
        policy_text: '',
        rules: [],
      },
      toxicity: { enabled: false },
      nsfw: { enabled: false },
      bias: { enabled: false, action: 'block' as const },
      sponge_attack: { enabled: false },
    },
    output: {
      enabled: false,
      detectors: {
        pii: { enabled: false, action: 'block' as const, entities: ['secrets' as const] },
        keyword_detector: { enabled: false, action: 'block' as const, banned_keywords: [] },
        topic_detector: { enabled: false, action: 'block' as const, topic: [] },
        policy_violation: {
          enabled: false,
          action: 'block' as const,
          format: 'rules' as const,
          policy_text: '',
          rules: [],
        },
        toxicity: { enabled: false, action: 'block' as const },
        nsfw: { enabled: false, action: 'block' as const },
        bias: { enabled: false, action: 'block' as const },
      },
    },
  };
  return { ...base, ...overrides };
}

describe('parseLineList', () => {
  it('trims, drops blank lines and dedupes', () => {
    expect(parseLineList(' alpha \n\n beta \nalpha\n')).toEqual(['alpha', 'beta']);
  });
});

describe('draft round trip', () => {
  it('keeps a saved configuration intact through the draft text fields', () => {
    const saved = config();
    saved.output.detectors.keyword_detector = {
      enabled: true,
      action: 'block',
      banned_keywords: ['alpha', 'beta'],
    };
    saved.output.detectors.topic_detector = { enabled: true, action: 'log', topic: ['weapons'] };
    const draft = toDraft(saved);
    expect(draft.outputDetectors.keyword_detector.banned_keywords).toBe('alpha\nbeta');
    expect(fromDraft(draft)).toEqual(saved);
  });

  it('identifies a configuration by content, not by key order', () => {
    const a = config();
    const b: OrgGuardrailsConfig = structuredClone(a);
    expect(configKey(a, true)).toBe(configKey(b, true));
    b.output.enabled = true;
    expect(configKey(a, true)).not.toBe(configKey(b, true));
    // Output guardrails are left out where they are unavailable.
    expect(configKey(a, false)).toBe(configKey(b, false));
  });

  it('reports a dirty draft only while it differs from the baseline', () => {
    const baseline = toDraft(config());
    expect(draftsEqual(baseline, toDraft(config()), true)).toBe(true);
    const changed = { ...baseline, inputEnabled: true };
    expect(draftsEqual(changed, baseline, true)).toBe(false);
  });
});

describe('detector choices', () => {
  it('reads an off detector as off and an on one by its action', () => {
    expect(detectorChoice({ enabled: false, action: 'block' })).toBe('off');
    expect(detectorChoice({ enabled: true, action: 'log' })).toBe('log');
    expect(detectorChoice({ enabled: true, action: 'block' })).toBe('block');
  });

  it('saves an input detector off at Block, the action it resumes with', () => {
    const detectors = withInputDetectorChoice(config().detectors, 'injection_attack', 'off');
    expect(detectors.injection_attack).toEqual({ enabled: false, action: 'block' });
  });

  it('keeps an output detector’s action while it is off', () => {
    const on = withOutputDetectorChoice(toDraft(config()).outputDetectors, 'toxicity', 'log');
    expect(on.toxicity).toEqual({ enabled: true, action: 'log' });
    const off = withOutputDetectorChoice(on, 'toxicity', 'off');
    expect(off.toxicity).toEqual({ enabled: false, action: 'log' });
  });
});

describe('applyKiloDefaultPreset', () => {
  it('turns on prompt injection and a logged policy violation, keeping keywords', () => {
    const detectors = config().detectors;
    detectors.keyword_detector = {
      enabled: true,
      action: 'block',
      banned_keywords: ['alpha'],
    };
    const preset = applyKiloDefaultPreset(detectors);
    expect(preset.injection_attack).toEqual({ enabled: true, action: 'log' });
    expect(preset.policy_violation.enabled).toBe(true);
    expect(preset.policy_violation.action).toBe('log');
    expect(preset.policy_violation.format).toBe('policy_text');
    expect(preset.policy_violation.policy_text.length).toBeGreaterThan(0);
    expect(preset.keyword_detector).toEqual({
      enabled: false,
      action: 'block',
      banned_keywords: ['alpha'],
    });
    expect(preset.toxicity).toEqual({ enabled: false });
  });
});

describe('guardrailsIssues', () => {
  it('requires a detector while the input guardrail is on', () => {
    expect(guardrailsIssues(toDraft(config()), true)).toEqual([]);
    expect(guardrailsIssues(toDraft(config({ enabled: true })), true)).toEqual([
      'inputDetectorRequired',
    ]);
  });

  it('requires an output detector while the output guardrail is on', () => {
    const saved = config();
    saved.output.enabled = true;
    expect(guardrailsIssues(toDraft(saved), true)).toEqual(['outputDetectorRequired']);
    // The output guardrail is not saved where its UI is unavailable.
    expect(guardrailsIssues(toDraft(saved), false)).toEqual([]);
  });

  it('rejects a rule with no text, a bad id, or more rules than the cap', () => {
    const saved = config();
    saved.detectors.policy_violation = {
      ...saved.detectors.policy_violation,
      enabled: true,
      action: 'log',
      rules: [rule({ text: '  ' })],
    };
    expect(guardrailsIssues(toDraft(saved), true)).toContain('ruleTextRequired');

    saved.detectors.policy_violation.rules = [rule({ text: 'No PII', id: 'bad id' })];
    expect(guardrailsIssues(toDraft(saved), true)).toContain('ruleIdInvalid');

    saved.detectors.policy_violation.rules = [rule({ text: 'No PII', id: ' ' })];
    expect(guardrailsIssues(toDraft(saved), true)).toContain('ruleIdRequired');

    saved.detectors.policy_violation.rules = Array.from({ length: 6 }, (_unused, index) =>
      rule({ id: `rule-${index}`, text: 'No PII' })
    );
    expect(guardrailsIssues(toDraft(saved), true)).toContain('rulesTooMany');
  });

  it('rejects an output keyword past the server’s per-entry cap', () => {
    const saved = config();
    saved.output.detectors.keyword_detector = {
      enabled: true,
      action: 'block',
      banned_keywords: ['x'.repeat(101)],
    };
    expect(guardrailsIssues(toDraft(saved), true)).toContain('keywordTooLong');
  });
});

describe('buildUpdateInput', () => {
  it('leaves output guardrails out where they are unavailable', () => {
    const draft = toDraft(config());
    expect('output' in buildUpdateInput(draft, true)).toBe(true);
    expect('output' in buildUpdateInput(draft, false)).toBe(false);
  });
});

describe('createPolicyRule', () => {
  it('picks an unused numeric id', () => {
    expect(createPolicyRule([rule({ id: 'rule-1' })]).id).toBe('rule-2');
    expect(createPolicyRule([rule({ id: 'rule-1' }), rule({ id: 'rule-2' })]).id).toBe('rule-3');
  });
});
