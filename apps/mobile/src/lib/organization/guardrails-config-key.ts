import {
  fromDraft,
  type GuardrailsDraft,
  type OrgGuardrailsConfig,
  type OrgGuardrailsInputDetectors,
  type OrgGuardrailsOutputDetectors,
  type OrgPolicyRule,
} from '@/lib/organization/guardrails-draft';

function ruleKey(rule: OrgPolicyRule) {
  return [
    rule.id,
    rule.display_text,
    rule.text,
    rule.risk_category,
    rule.applicability,
    rule.severity,
    rule.frameworks,
  ];
}

function inputDetectorsKey(detectors: OrgGuardrailsInputDetectors) {
  return {
    injection_attack: [detectors.injection_attack.enabled, detectors.injection_attack.action],
    pii: [detectors.pii.enabled, detectors.pii.entities],
    keyword_detector: [
      detectors.keyword_detector.enabled,
      detectors.keyword_detector.banned_keywords,
    ],
    topic_detector: [detectors.topic_detector.enabled, detectors.topic_detector.topic],
    policy_violation: [
      detectors.policy_violation.enabled,
      detectors.policy_violation.action,
      detectors.policy_violation.format,
      detectors.policy_violation.policy_text,
      detectors.policy_violation.rules.map(rule => ruleKey(rule)),
    ],
    toxicity: [detectors.toxicity.enabled],
    nsfw: [detectors.nsfw.enabled],
    bias: [detectors.bias.enabled, detectors.bias.action],
    sponge_attack: [detectors.sponge_attack.enabled],
  };
}

function outputDetectorsKey(detectors: OrgGuardrailsOutputDetectors) {
  return {
    pii: [detectors.pii.enabled, detectors.pii.entities],
    keyword_detector: [
      detectors.keyword_detector.enabled,
      detectors.keyword_detector.banned_keywords,
    ],
    topic_detector: [
      detectors.topic_detector.enabled,
      detectors.topic_detector.action,
      detectors.topic_detector.topic,
    ],
    policy_violation: [
      detectors.policy_violation.enabled,
      detectors.policy_violation.action,
      detectors.policy_violation.format,
      detectors.policy_violation.policy_text,
      detectors.policy_violation.rules.map(rule => ruleKey(rule)),
    ],
    toxicity: [detectors.toxicity.enabled, detectors.toxicity.action],
    nsfw: [detectors.nsfw.enabled, detectors.nsfw.action],
    bias: [detectors.bias.enabled, detectors.bias.action],
  };
}

/**
 * A configuration's identity by content, for the dirty check and for noticing a
 * refetch that moved the baseline. Every field is serialized in its schema
 * order, so two readings of the same settings agree even though PostgreSQL
 * `jsonb` reorders the keys it stores. Output guardrails are left out where they
 * are unavailable, because a save then leaves them untouched.
 */
export function configKey(config: OrgGuardrailsConfig, outputAvailable: boolean): string {
  const head = [config.enabled, config.group_id ?? '', inputDetectorsKey(config.detectors)];
  if (!outputAvailable) {
    return JSON.stringify(head);
  }
  return JSON.stringify([
    head,
    [config.output.enabled, outputDetectorsKey(config.output.detectors)],
  ]);
}

export function draftsEqual(
  a: GuardrailsDraft,
  b: GuardrailsDraft,
  outputAvailable: boolean
): boolean {
  return configKey(fromDraft(a), outputAvailable) === configKey(fromDraft(b), outputAvailable);
}
