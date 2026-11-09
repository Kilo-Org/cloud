import {
  ENKRYPT_OUTPUT_DETECTOR_IDS,
  EnkryptInputDetectorsUpdateSchema,
  EnkryptOutputDetectorsUpdateSchema,
  type EnkryptInputDetectors,
  type EnkryptOutputDetectors,
  type EnkryptPolicyRule,
} from '@kilocode/db/schema-types';
import type * as z from 'zod';
import {
  createKiloDefaultEnkryptInputDetectors,
  ENKRYPT_CONFIGURABLE_INPUT_DETECTOR_IDS,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detectors';
import { KILO_DEFAULT_POLICY_TEXT } from './kilo-default-policy';

export type EnkryptInputDetectorsDraft = Omit<
  EnkryptInputDetectors,
  'keyword_detector' | 'topic_detector'
> & {
  keyword_detector: Omit<EnkryptInputDetectors['keyword_detector'], 'banned_keywords'> & {
    banned_keywords: string;
  };
  topic_detector: { enabled: boolean; topic: string };
};

export type EnkryptOutputDetectorsDraft = Omit<
  EnkryptOutputDetectors,
  'keyword_detector' | 'topic_detector'
> & {
  keyword_detector: Omit<EnkryptOutputDetectors['keyword_detector'], 'banned_keywords'> & {
    banned_keywords: string;
  };
  topic_detector: Omit<EnkryptOutputDetectors['topic_detector'], 'topic'> & { topic: string };
};

export type EnkryptOutputGuardrailConfig = {
  enabled: boolean;
  detectors: EnkryptOutputDetectors;
};

export type EnkryptOutputGuardrailDraft = {
  enabled: boolean;
  detectors: EnkryptOutputDetectorsDraft;
};

export type EnkryptGuardrailsConfig = {
  enabled: boolean;
  detectors: EnkryptInputDetectors;
  output: EnkryptOutputGuardrailConfig;
};

export type EnkryptGuardrailsDraft = Omit<EnkryptGuardrailsConfig, 'detectors' | 'output'> & {
  detectors: EnkryptInputDetectorsDraft;
  output: EnkryptOutputGuardrailDraft;
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

export function toDraftOutputDetectors(
  detectors: EnkryptOutputDetectors
): EnkryptOutputDetectorsDraft {
  return {
    ...detectors,
    keyword_detector: {
      ...detectors.keyword_detector,
      banned_keywords: detectors.keyword_detector.banned_keywords.join('\n'),
    },
    topic_detector: {
      ...detectors.topic_detector,
      topic: detectors.topic_detector.topic.join('\n'),
    },
  };
}

export function fromDraftOutputDetectors(
  draft: EnkryptOutputDetectorsDraft
): EnkryptOutputDetectors {
  return {
    ...draft,
    keyword_detector: {
      ...draft.keyword_detector,
      banned_keywords: parseLineList(draft.keyword_detector.banned_keywords),
    },
    topic_detector: {
      ...draft.topic_detector,
      topic: parseLineList(draft.topic_detector.topic),
    },
  };
}

export function toDraft(config: EnkryptGuardrailsConfig): EnkryptGuardrailsDraft {
  return {
    enabled: config.enabled,
    detectors: toDraftDetectors(config.detectors),
    output: {
      enabled: config.output.enabled,
      detectors: toDraftOutputDetectors(config.output.detectors),
    },
  };
}

export function fromDraft(draft: EnkryptGuardrailsDraft): EnkryptGuardrailsConfig {
  return {
    enabled: draft.enabled,
    detectors: fromDraftDetectors(draft.detectors),
    output: {
      enabled: draft.output.enabled,
      detectors: fromDraftOutputDetectors(draft.output.detectors),
    },
  };
}

/**
 * Applies Kilo Default's detector selection and actions and sets Policy violation to block with
 * Kilo's default policy text, keeping keywords, topics, and structured rules.
 */
export function applyKiloDefaultPreset(
  detectors: EnkryptInputDetectorsDraft
): EnkryptInputDetectorsDraft {
  const preset = toDraftDetectors(createKiloDefaultEnkryptInputDetectors());
  return {
    ...preset,
    keyword_detector: { ...detectors.keyword_detector, enabled: preset.keyword_detector.enabled },
    topic_detector: { ...detectors.topic_detector, enabled: preset.topic_detector.enabled },
    policy_violation: {
      ...detectors.policy_violation,
      enabled: true,
      action: preset.policy_violation.action,
      format: 'policy_text',
      policy_text: KILO_DEFAULT_POLICY_TEXT,
    },
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

function addSchemaIssues(issues: Map<string, string>, result: z.ZodSafeParseResult<unknown>) {
  if (result.success) return;
  for (const issue of result.error.issues) {
    const path = issue.path.join('.');
    if (!issues.has(path)) issues.set(path, issue.message);
  }
}

/**
 * The output guardrail's issues, keyed like `getEnkryptGuardrailsIssues` but relative to the
 * output guardrail.
 */
export function getEnkryptOutputGuardrailIssues(
  output: EnkryptOutputGuardrailDraft
): EnkryptGuardrailsIssues {
  const issues = new Map<string, string>();
  if (output.enabled && !ENKRYPT_OUTPUT_DETECTOR_IDS.some(id => output.detectors[id].enabled)) {
    issues.set('detectors', 'Turn on at least one output detector.');
  }
  addSchemaIssues(
    issues,
    EnkryptOutputDetectorsUpdateSchema.safeParse(fromDraftOutputDetectors(output.detectors))
  );
  return issues;
}

/**
 * Issues keyed by the dotted path of the field that caused them; `''` is the whole configuration.
 * Output guardrail paths start with `output.`. Detector settings are validated even while
 * guardrails are off because they are saved either way, unless output is excluded from the save.
 */
export function getEnkryptGuardrailsIssues(
  draft: EnkryptGuardrailsDraft,
  includeOutput = true
): EnkryptGuardrailsIssues {
  const issues = new Map<string, string>();
  if (
    draft.enabled &&
    !ENKRYPT_CONFIGURABLE_INPUT_DETECTOR_IDS.some(id => draft.detectors[id].enabled)
  ) {
    issues.set('detectors', 'Turn on at least one input detector.');
  }
  addSchemaIssues(
    issues,
    EnkryptInputDetectorsUpdateSchema.safeParse(fromDraftDetectors(draft.detectors))
  );
  if (includeOutput) {
    for (const [path, message] of getEnkryptOutputGuardrailIssues(draft.output)) {
      issues.set(path ? `output.${path}` : 'output', message);
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
export function configKey(config: EnkryptGuardrailsConfig, includeOutput = true): string {
  return JSON.stringify(
    sortKeys(includeOutput ? config : { enabled: config.enabled, detectors: config.detectors })
  );
}

export function draftsEqual(
  a: EnkryptGuardrailsDraft,
  b: EnkryptGuardrailsDraft,
  includeOutput = true
): boolean {
  return configKey(fromDraft(a), includeOutput) === configKey(fromDraft(b), includeOutput);
}
