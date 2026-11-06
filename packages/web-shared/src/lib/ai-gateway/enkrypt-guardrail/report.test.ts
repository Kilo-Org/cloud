import { describe, expect, it } from '@jest/globals';
import {
  ENKRYPT_RULE_APPLICABILITIES,
  ENKRYPT_RULE_RISK_CATEGORIES,
  ENKRYPT_RULE_SEVERITIES,
} from '@kilocode/db/schema-types';
import { guardrailSettings } from './report';

describe('guardrailSettings', () => {
  it('reports each detector and its action, with only the size of authored text', () => {
    const settings = guardrailSettings({
      scanToolResults: false,
      status: 'ready',
      detectors: {
        injection_attack: { enabled: true, need_explanation: false },
        pii: { enabled: true, entities: ['pii', 'secrets'] },
        keyword_detector: { enabled: true, banned_keywords: ['Project Phoenix', 'Hydra'] },
        topic_detector: { enabled: true, topic: ['mergers'] },
        policy_violation: {
          enabled: true,
          need_explanation: false,
          policy_text: 'Never discuss Project Phoenix.',
        },
        bias: { enabled: true },
      },
      blockingDetectors: ['injection_attack', 'keyword_detector', 'policy_violation'],
    });

    expect(settings).toEqual({
      status: 'ready',
      scan_tool_results: false,
      detectors: [
        { detector: 'injection_attack', action: 'block' },
        { detector: 'pii', action: 'log', pii_entities: ['pii', 'secrets'] },
        { detector: 'keyword_detector', action: 'block', banned_keyword_count: 2 },
        { detector: 'topic_detector', action: 'log', topic_count: 1 },
        { detector: 'policy_violation', action: 'block', policy_format: 'text' },
        { detector: 'bias', action: 'log' },
      ],
    });
    const serialized = JSON.stringify(settings);
    expect(serialized).not.toContain('Phoenix');
    expect(serialized).not.toContain('mergers');
  });

  it('counts policy rules without their text', () => {
    const settings = guardrailSettings({
      scanToolResults: true,
      status: 'ready',
      detectors: {
        policy_violation: {
          enabled: true,
          need_explanation: false,
          rules: [
            {
              id: 'rule-1',
              display_text: 'Phoenix',
              text: 'Never discuss Project Phoenix.',
              risk_category: ENKRYPT_RULE_RISK_CATEGORIES[0],
              applicability: ENKRYPT_RULE_APPLICABILITIES[0],
              severity: ENKRYPT_RULE_SEVERITIES[0],
              frameworks: [],
              source: 'user',
              suggested: false,
            },
          ],
        },
      },
      blockingDetectors: ['policy_violation'],
    });

    expect(settings.detectors).toEqual([
      {
        detector: 'policy_violation',
        action: 'block',
        policy_format: 'rules',
        policy_rule_count: 1,
      },
    ]);
    expect(JSON.stringify(settings)).not.toContain('Phoenix');
  });

  it('reports an invalid configuration without detectors', () => {
    expect(guardrailSettings({ scanToolResults: true, status: 'invalid' })).toEqual({
      status: 'invalid',
      scan_tool_results: true,
      detectors: [],
    });
  });
});
