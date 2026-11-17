import { KILO_DEFAULT_POLICY_TEXT } from '@kilocode/app-shared/organizations';
import {
  type inferRouterInputs,
  type inferRouterOutputs,
  type MobileRouter,
} from '@kilocode/trpc/mobile';

type RouterOutputs = inferRouterOutputs<MobileRouter>;
type RouterInputs = inferRouterInputs<MobileRouter>;

/** What `organizations.guardrails.get` answers, before the screen splits it into a draft. */
export type OrgGuardrails = RouterOutputs['organizations']['guardrails']['get'];
export type OrgGuardrailsInputDetectors = OrgGuardrails['detectors'];
export type OrgGuardrailsOutputDetectors = OrgGuardrails['output']['detectors'];
export type OrgGuardrailsConfig = Omit<
  OrgGuardrails,
  'groups' | 'output_available' | 'invalid_saved_detectors' | 'invalid_saved_output_detectors'
>;
export type OrgGuardrailsGroup = OrgGuardrails['groups'][number];

/** The update input without the organization id, which the hook adds. */
export type OrgGuardrailsUpdate = Omit<
  RouterInputs['organizations']['guardrails']['update'],
  'organizationId'
>;

type PolicyRule = OrgGuardrailsInputDetectors['policy_violation']['rules'][number];

/** One policy violation rule, as the rule editor edits it. */
export type OrgPolicyRule = PolicyRule;

export type RuleRiskCategory = PolicyRule['risk_category'];
export type RuleApplicability = PolicyRule['applicability'];
export type RuleSeverity = PolicyRule['severity'];
export type RuleFramework = PolicyRule['frameworks'][number];
export type PiiEntity = OrgGuardrailsOutputDetectors['pii']['entities'][number];
export type PolicyFormat = OrgGuardrailsInputDetectors['policy_violation']['format'];
export type DetectorAction = OrgGuardrailsInputDetectors['policy_violation']['action'];

/**
 * The input detectors the page configures. The gateway enforces only these two
 * and turns every other input detector off whatever was saved
 * (`enforcedEnkryptInputDetectors` in web-shared), so the screen does not offer
 * the rest.
 */
export const INPUT_DETECTOR_IDS = [
  'injection_attack',
  'policy_violation',
] as const satisfies readonly (keyof OrgGuardrailsInputDetectors)[];

export type InputDetectorId = (typeof INPUT_DETECTOR_IDS)[number];
export type OutputDetectorId = (typeof OUTPUT_DETECTOR_IDS)[number];

/** Every output detector the page configures, in the order it lists them. */
export const OUTPUT_DETECTOR_IDS = [
  'pii',
  'keyword_detector',
  'topic_detector',
  'policy_violation',
  'toxicity',
  'nsfw',
  'bias',
] as const satisfies readonly (keyof OrgGuardrailsOutputDetectors)[];

export const PII_ENTITIES = [
  'pii',
  'secrets',
  'ip_address',
  'url',
] as const satisfies readonly PiiEntity[];

export const RULE_RISK_CATEGORIES = [
  'security_fraud',
  'safety_harm',
  'privacy_data_protection',
  'brand_reputation_trust',
  'bias_fairness_ethical',
  'legal_ip_liability',
  'product_misuse_abuse',
  'performance_reliability_quality',
] as const satisfies readonly RuleRiskCategory[];

export const RULE_APPLICABILITIES = [
  'user',
  'user_assistant',
] as const satisfies readonly RuleApplicability[];

export const RULE_SEVERITIES = [
  'critical',
  'high',
  'medium',
  'low',
] as const satisfies readonly RuleSeverity[];

export const RULE_FRAMEWORKS = [
  'hipaa',
  'finra',
  'gdpr',
  'ccpa',
  'owasp_llm_2025',
  'nist_ai_rmf',
  'eu_ai_act',
  'iso_42001',
] as const satisfies readonly RuleFramework[];

/**
 * The server's `ENKRYPT_DETECTOR_LIMITS` (`packages/db/src/schema-types.ts`).
 * Mobile cannot import the db package, so the numbers are repeated here; the
 * server rejects anything past them either way.
 */
export const GUARDRAILS_LIMITS = {
  keywords: 200,
  keywordLength: 100,
  topics: 50,
  topicLength: 100,
  policyTextLength: 10_000,
  rules: 5,
  ruleIdLength: 64,
  ruleDisplayTextLength: 120,
  ruleTextLength: 1_000,
} as const;

export type OutputDetectorsDraft = Omit<
  OrgGuardrailsOutputDetectors,
  'keyword_detector' | 'topic_detector'
> & {
  keyword_detector: Omit<OrgGuardrailsOutputDetectors['keyword_detector'], 'banned_keywords'> & {
    banned_keywords: string;
  };
  topic_detector: Omit<OrgGuardrailsOutputDetectors['topic_detector'], 'topic'> & {
    topic: string;
  };
};

export type GuardrailsDraft = {
  inputEnabled: boolean;
  groupId: string | null;
  detectors: OrgGuardrailsInputDetectors;
  outputEnabled: boolean;
  outputDetectors: OutputDetectorsDraft;
};

/**
 * The reasons a draft cannot be saved, in the order the screen reports them.
 * They name the server's own refusals (`EnkryptInputDetectorsSchema` and
 * `EnkryptOutputDetectorsSchema` in `packages/db/src/schema-types.ts`), so a
 * refused save never reaches the round trip.
 */
export type GuardrailsIssue =
  | 'inputDetectorRequired'
  | 'outputDetectorRequired'
  | 'piiEntityRequired'
  | 'keywordRequired'
  | 'topicRequired'
  | 'keywordTooLong'
  | 'keywordsTooMany'
  | 'topicTooLong'
  | 'topicsTooMany'
  | 'policyTextRequired'
  | 'ruleRequired'
  | 'rulesTooMany'
  | 'ruleIdRequired'
  | 'ruleIdInvalid'
  | 'ruleIdDuplicate'
  | 'ruleTextRequired';

/** One keyword or topic per line, trimmed, without blank lines or repeats. */
export function parseLineList(text: string): string[] {
  const items = text
    .split('\n')
    .map(item => item.trim())
    .filter(item => item.length > 0);
  return [...new Set(items)];
}

export function toDraft(config: OrgGuardrailsConfig): GuardrailsDraft {
  const { detectors } = config;
  return {
    inputEnabled: config.enabled,
    groupId: config.group_id,
    detectors,
    outputEnabled: config.output.enabled,
    outputDetectors: {
      ...config.output.detectors,
      keyword_detector: {
        ...config.output.detectors.keyword_detector,
        banned_keywords: config.output.detectors.keyword_detector.banned_keywords.join('\n'),
      },
      topic_detector: {
        ...config.output.detectors.topic_detector,
        topic: config.output.detectors.topic_detector.topic.join('\n'),
      },
    },
  };
}

export function fromDraft(draft: GuardrailsDraft): OrgGuardrailsConfig {
  return {
    enabled: draft.inputEnabled,
    group_id: draft.groupId,
    detectors: draft.detectors,
    output: {
      enabled: draft.outputEnabled,
      detectors: {
        ...draft.outputDetectors,
        keyword_detector: {
          ...draft.outputDetectors.keyword_detector,
          banned_keywords: parseLineList(draft.outputDetectors.keyword_detector.banned_keywords),
        },
        topic_detector: {
          ...draft.outputDetectors.topic_detector,
          topic: parseLineList(draft.outputDetectors.topic_detector.topic),
        },
      },
    },
  };
}

export type DetectorChoice = 'off' | DetectorAction;

export function detectorChoice(detector: {
  enabled: boolean;
  action: DetectorAction;
}): DetectorChoice {
  return detector.enabled ? detector.action : 'off';
}

/**
 * An input detector saved while off carries Block, the action it resumes with;
 * an output detector keeps the action it had, because it never blocks anything
 * while off and the choice is the reader's.
 */
function withChoice<Detector extends { enabled: boolean; action: DetectorAction }>(
  detector: Detector,
  choice: DetectorChoice,
  { resetActionWhenOff }: { resetActionWhenOff: boolean }
): Detector {
  if (choice !== 'off') {
    return { ...detector, enabled: true, action: choice };
  }
  return {
    ...detector,
    enabled: false,
    action: resetActionWhenOff ? 'block' : detector.action,
  };
}

export function withInputDetectorChoice(
  detectors: OrgGuardrailsInputDetectors,
  id: InputDetectorId,
  choice: DetectorChoice
): OrgGuardrailsInputDetectors {
  return {
    ...detectors,
    [id]: withChoice(detectors[id], choice, { resetActionWhenOff: true }),
  };
}

export function withOutputDetectorChoice(
  detectors: OutputDetectorsDraft,
  id: OutputDetectorId,
  choice: DetectorChoice
): OutputDetectorsDraft {
  return {
    ...detectors,
    [id]: withChoice(detectors[id], choice, { resetActionWhenOff: false }),
  };
}

/**
 * Kilo Default's detector selection and actions, with Policy violation turned
 * to Log only and carrying Kilo's policy text. The reader's keywords and topics
 * survive; the preset only turns them off.
 */
export function applyKiloDefaultPreset(
  detectors: OrgGuardrailsInputDetectors
): OrgGuardrailsInputDetectors {
  return {
    ...detectors,
    injection_attack: { enabled: true, action: 'log' },
    pii: { ...detectors.pii, enabled: false, action: 'log' },
    keyword_detector: { ...detectors.keyword_detector, enabled: false },
    topic_detector: { ...detectors.topic_detector, enabled: false },
    policy_violation: {
      ...detectors.policy_violation,
      enabled: true,
      action: 'log',
      format: 'policy_text',
      policy_text: KILO_DEFAULT_POLICY_TEXT,
    },
    toxicity: { enabled: false },
    nsfw: { enabled: false },
    bias: { ...detectors.bias, enabled: false, action: 'log' },
    sponge_attack: { enabled: false },
  };
}

/** The mutation input a draft saves: output guardrails are left out where they are unavailable. */
export function buildUpdateInput(
  draft: GuardrailsDraft,
  outputAvailable: boolean
): OrgGuardrailsUpdate {
  const { output, ...rest } = fromDraft(draft);
  return outputAvailable ? { ...rest, output } : rest;
}
