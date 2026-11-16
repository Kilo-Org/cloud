import { type TFunction } from 'i18next';

import { GUARDRAILS_LIMITS, type GuardrailsIssue } from '@/lib/organization/guardrails-draft';

/** The copy each input detector renders, by detector id. */
export const INPUT_DETECTOR_COPY = {
  injection_attack: {
    label: 'organizationGuardrails.detector.promptInjection.label',
    description: 'organizationGuardrails.detector.promptInjection.description',
  },
  policy_violation: {
    label: 'organizationGuardrails.detector.policyViolation.label',
    description: 'organizationGuardrails.detector.policyViolation.description',
  },
} as const;

/** The copy each output detector renders, by detector id. */
export const OUTPUT_DETECTOR_COPY = {
  pii: {
    label: 'organizationGuardrails.detector.pii.label',
    description: 'organizationGuardrails.detector.pii.description',
  },
  keyword_detector: {
    label: 'organizationGuardrails.detector.keywords.label',
    description: 'organizationGuardrails.detector.keywords.descriptionOutput',
  },
  topic_detector: {
    label: 'organizationGuardrails.detector.topics.label',
    description: 'organizationGuardrails.detector.topics.descriptionOutput',
  },
  policy_violation: {
    label: 'organizationGuardrails.detector.policyViolation.label',
    description: 'organizationGuardrails.detector.policyViolation.descriptionOutput',
  },
  toxicity: {
    label: 'organizationGuardrails.detector.toxicity.label',
    description: 'organizationGuardrails.detector.toxicity.description',
  },
  nsfw: {
    label: 'organizationGuardrails.detector.nsfw.label',
    description: 'organizationGuardrails.detector.nsfw.description',
  },
  bias: {
    label: 'organizationGuardrails.detector.bias.label',
    description: 'organizationGuardrails.detector.bias.description',
  },
} as const;

const ISSUE_KEYS = {
  inputDetectorRequired: 'organizationGuardrails.inputDetectorRequired',
  outputDetectorRequired: 'organizationGuardrails.outputDetectorRequired',
  piiEntityRequired: 'organizationGuardrails.piiEntityRequired',
  keywordRequired: 'organizationGuardrails.keywordRequired',
  topicRequired: 'organizationGuardrails.topicRequired',
  keywordTooLong: 'organizationGuardrails.keywordTooLong',
  keywordsTooMany: 'organizationGuardrails.keywordsTooMany',
  topicTooLong: 'organizationGuardrails.topicTooLong',
  topicsTooMany: 'organizationGuardrails.topicsTooMany',
  policyTextRequired: 'organizationGuardrails.policyTextRequired',
  ruleRequired: 'organizationGuardrails.ruleRequired',
  rulesTooMany: 'organizationGuardrails.rulesTooMany',
  ruleIdRequired: 'organizationGuardrails.ruleIdRequired',
  ruleIdInvalid: 'organizationGuardrails.ruleIdInvalid',
  ruleIdDuplicate: 'organizationGuardrails.ruleIdDuplicate',
  ruleTextRequired: 'organizationGuardrails.ruleTextRequired',
} satisfies Record<GuardrailsIssue, string>;

/** The issues whose sentence names the cap it enforces. */
const ISSUE_LIMITS = {
  rulesTooMany: GUARDRAILS_LIMITS.rules,
  keywordsTooMany: GUARDRAILS_LIMITS.keywords,
  topicsTooMany: GUARDRAILS_LIMITS.topics,
  keywordTooLong: GUARDRAILS_LIMITS.keywordLength,
  topicTooLong: GUARDRAILS_LIMITS.topicLength,
  inputDetectorRequired: null,
  outputDetectorRequired: null,
  piiEntityRequired: null,
  keywordRequired: null,
  topicRequired: null,
  policyTextRequired: null,
  ruleRequired: null,
  ruleIdRequired: null,
  ruleIdInvalid: null,
  ruleIdDuplicate: null,
  ruleTextRequired: null,
} satisfies Record<GuardrailsIssue, number | null>;

/** The sentence that explains why a draft cannot be saved. */
export function issueMessage(t: TFunction, issue: GuardrailsIssue): string {
  const limit = ISSUE_LIMITS[issue];
  return limit === null ? t(ISSUE_KEYS[issue]) : t(ISSUE_KEYS[issue], { max: limit });
}
