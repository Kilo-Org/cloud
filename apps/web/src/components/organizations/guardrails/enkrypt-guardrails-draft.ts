import {
  ENKRYPT_DETECTOR_IDS,
  EnkryptInputDetectorsSchema,
  type EnkryptInputDetectors,
  type EnkryptPolicyRule,
} from '@kilocode/db/schema-types';
import { createKiloDefaultEnkryptInputDetectors } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detectors';

export type EnkryptInputDetectorsDraft = Omit<
  EnkryptInputDetectors,
  'keyword_detector' | 'topic_detector'
> & {
  keyword_detector: Omit<EnkryptInputDetectors['keyword_detector'], 'banned_keywords'> & {
    banned_keywords: string;
  };
  topic_detector: { enabled: boolean; topic: string };
};

export type EnkryptGuardrailsConfig = {
  enabled: boolean;
  scan_tool_results: boolean;
  detectors: EnkryptInputDetectors;
};

export type EnkryptGuardrailsDraft = Omit<EnkryptGuardrailsConfig, 'detectors'> & {
  detectors: EnkryptInputDetectorsDraft;
};

export type EnkryptGuardrailsIssues = ReadonlyMap<string, string>;

export function parseLineList(text: string): string[] {
  const items = text
    .split('\n')
    .map(item => item.trim())
    .filter(item => item.length > 0);
  return [...new Set(items)];
}

export function toDraftDetectors(detectors: EnkryptInputDetectors): EnkryptInputDetectorsDraft {
  return {
    ...detectors,
    keyword_detector: {
      ...detectors.keyword_detector,
      banned_keywords: detectors.keyword_detector.banned_keywords.join('\n'),
    },
    topic_detector: {
      enabled: detectors.topic_detector.enabled,
      topic: detectors.topic_detector.topic.join('\n'),
    },
  };
}

export function fromDraftDetectors(draft: EnkryptInputDetectorsDraft): EnkryptInputDetectors {
  return {
    ...draft,
    keyword_detector: {
      ...draft.keyword_detector,
      banned_keywords: parseLineList(draft.keyword_detector.banned_keywords),
    },
    topic_detector: {
      enabled: draft.topic_detector.enabled,
      topic: parseLineList(draft.topic_detector.topic),
    },
  };
}

export function toDraft(config: EnkryptGuardrailsConfig): EnkryptGuardrailsDraft {
  return {
    enabled: config.enabled,
    scan_tool_results: config.scan_tool_results,
    detectors: toDraftDetectors(config.detectors),
  };
}

export function fromDraft(draft: EnkryptGuardrailsDraft): EnkryptGuardrailsConfig {
  return {
    enabled: draft.enabled,
    scan_tool_results: draft.scan_tool_results,
    detectors: fromDraftDetectors(draft.detectors),
  };
}

/** Applies Kilo Default's detector selection while keeping keywords, topics, and policies. */
export function applyKiloDefaultPreset(
  detectors: EnkryptInputDetectorsDraft
): EnkryptInputDetectorsDraft {
  const preset = toDraftDetectors(createKiloDefaultEnkryptInputDetectors());
  return {
    ...preset,
    keyword_detector: { ...detectors.keyword_detector, enabled: preset.keyword_detector.enabled },
    topic_detector: { ...detectors.topic_detector, enabled: preset.topic_detector.enabled },
    policy_violation: { ...detectors.policy_violation, enabled: preset.policy_violation.enabled },
  };
}

export function createPolicyRule(existingRules: EnkryptPolicyRule[]): EnkryptPolicyRule {
  const usedIds = new Set(existingRules.map(rule => rule.id));
  let number = existingRules.length + 1;
  while (usedIds.has(`rule-${number}`)) number++;
  return {
    id: `rule-${number}`,
    display_text: '',
    text: '',
    risk_category: 'security_fraud',
    applicability: 'user',
    severity: 'high',
    frameworks: [],
  };
}

/**
 * Issues keyed by the dotted path of the field that caused them; `''` is the whole configuration.
 * Detector settings are validated even while guardrails are off because they are saved either way.
 */
export function getEnkryptGuardrailsIssues(draft: EnkryptGuardrailsDraft): EnkryptGuardrailsIssues {
  const issues = new Map<string, string>();
  if (draft.enabled && !ENKRYPT_DETECTOR_IDS.some(id => draft.detectors[id].enabled)) {
    issues.set('detectors', 'Turn on at least one detector.');
  }
  const result = EnkryptInputDetectorsSchema.safeParse(fromDraftDetectors(draft.detectors));
  if (!result.success) {
    for (const issue of result.error.issues) {
      const path = issue.path.join('.');
      if (!issues.has(path)) issues.set(path, issue.message);
    }
  }
  return issues;
}

export function issueAt(issues: EnkryptGuardrailsIssues, path: string): string | undefined {
  for (const [issuePath, message] of issues) {
    if (issuePath === path || issuePath.startsWith(`${path}.`)) return message;
  }
  return undefined;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sortKeys(entry)])
    );
  }
  return value;
}

/** Identifies a configuration by content; PostgreSQL `jsonb` does not preserve key order. */
export function configKey(config: EnkryptGuardrailsConfig): string {
  return JSON.stringify(sortKeys(config));
}

export function draftsEqual(a: EnkryptGuardrailsDraft, b: EnkryptGuardrailsDraft): boolean {
  return configKey(fromDraft(a)) === configKey(fromDraft(b));
}
