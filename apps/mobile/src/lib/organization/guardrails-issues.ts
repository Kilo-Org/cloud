import {
  fromDraft,
  GUARDRAILS_LIMITS,
  type GuardrailsDraft,
  type GuardrailsIssue,
  INPUT_DETECTOR_IDS,
  type OrgPolicyRule,
  OUTPUT_DETECTOR_IDS,
} from '@/lib/organization/guardrails-draft';

const RULE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** A rule with an unused `rule-<n>` id and the defaults the web editor creates. */
export function createPolicyRule(existingRules: readonly OrgPolicyRule[]): OrgPolicyRule {
  const usedIds = new Set(existingRules.map(rule => rule.id));
  let number = existingRules.length + 1;
  while (usedIds.has(`rule-${number}`)) {
    number += 1;
  }
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
 * Everything the server refuses, checked here first so Save can stay disabled
 * with the reason beside it instead of failing the round trip.
 */
export function guardrailsIssues(
  draft: GuardrailsDraft,
  outputAvailable: boolean
): readonly GuardrailsIssue[] {
  const issues: GuardrailsIssue[] = [];
  if (draft.inputEnabled && !INPUT_DETECTOR_IDS.some(id => draft.detectors[id].enabled)) {
    issues.push('inputDetectorRequired');
  }
  if (
    draft.outputEnabled &&
    outputAvailable &&
    !OUTPUT_DETECTOR_IDS.some(id => draft.outputDetectors[id].enabled)
  ) {
    issues.push('outputDetectorRequired');
  }

  const config = fromDraft(draft);
  for (const rule of draft.detectors.policy_violation.rules) {
    if (rule.id.trim().length === 0) {
      issues.push('ruleIdRequired');
    } else if (!RULE_ID_PATTERN.test(rule.id.trim())) {
      issues.push('ruleIdInvalid');
    }
    if (rule.text.trim().length === 0) {
      issues.push('ruleTextRequired');
    }
  }
  if (config.detectors.policy_violation.rules.length > GUARDRAILS_LIMITS.rules) {
    issues.push('rulesTooMany');
  }
  const outputKeywords = config.output.detectors.keyword_detector.banned_keywords;
  if (outputKeywords.some(keyword => keyword.length > GUARDRAILS_LIMITS.keywordLength)) {
    issues.push('keywordTooLong');
  }
  const outputTopics = config.output.detectors.topic_detector.topic;
  if (outputTopics.some(topic => topic.length > GUARDRAILS_LIMITS.topicLength)) {
    issues.push('topicTooLong');
  }
  return issues;
}
