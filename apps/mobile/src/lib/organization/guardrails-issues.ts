import {
  fromDraft,
  GUARDRAILS_LIMITS,
  type GuardrailsDraft,
  type GuardrailsIssue,
  INPUT_DETECTOR_IDS,
  type OrgGuardrailsConfig,
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
 * The refusals `refineEnkryptDetectors` raises for one detector set, input or
 * output: the lists a detector needs while it is on, their caps, and the policy
 * requirement its format carries.
 */
function detectorIssues(
  detectors: OrgGuardrailsConfig['detectors'] | OrgGuardrailsConfig['output']['detectors'],
  issues: GuardrailsIssue[]
): void {
  if (detectors.pii.enabled && detectors.pii.entities.length === 0) {
    issues.push('piiEntityRequired');
  }

  const keywords = detectors.keyword_detector.banned_keywords;
  if (detectors.keyword_detector.enabled && keywords.length === 0) {
    issues.push('keywordRequired');
  }
  if (keywords.length > GUARDRAILS_LIMITS.keywords) {
    issues.push('keywordsTooMany');
  }
  if (keywords.some(keyword => keyword.length > GUARDRAILS_LIMITS.keywordLength)) {
    issues.push('keywordTooLong');
  }

  const topics = detectors.topic_detector.topic;
  if (detectors.topic_detector.enabled && topics.length === 0) {
    issues.push('topicRequired');
  }
  if (topics.length > GUARDRAILS_LIMITS.topics) {
    issues.push('topicsTooMany');
  }
  if (topics.some(topic => topic.length > GUARDRAILS_LIMITS.topicLength)) {
    issues.push('topicTooLong');
  }

  const policy = detectors.policy_violation;
  if (policy.enabled && policy.format === 'policy_text' && policy.policy_text.trim().length === 0) {
    issues.push('policyTextRequired');
  }
  if (policy.enabled && policy.format === 'rules' && policy.rules.length === 0) {
    issues.push('ruleRequired');
  }
  // The server validates every stored rule, whichever format is in force.
  ruleIssues(policy.rules, issues);
}

/** An id the server accepts, a description, and an id no other rule reuses. */
function ruleIssues(rules: readonly OrgPolicyRule[], issues: GuardrailsIssue[]): void {
  const seenIds = new Set<string>();
  for (const rule of rules) {
    const id = rule.id.trim();
    if (id.length === 0) {
      issues.push('ruleIdRequired');
    } else if (!RULE_ID_PATTERN.test(id)) {
      issues.push('ruleIdInvalid');
    } else if (seenIds.has(id)) {
      issues.push('ruleIdDuplicate');
    }
    if (id.length > 0) {
      seenIds.add(id);
    }
    if (rule.text.trim().length === 0) {
      issues.push('ruleTextRequired');
    }
  }
  if (rules.length > GUARDRAILS_LIMITS.rules) {
    issues.push('rulesTooMany');
  }
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
  detectorIssues(config.detectors, issues);
  if (outputAvailable) {
    detectorIssues(config.output.detectors, issues);
  }
  return issues;
}
