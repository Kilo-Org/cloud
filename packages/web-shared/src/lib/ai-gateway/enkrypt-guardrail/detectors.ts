import {
  ENKRYPT_DETECTOR_IDS,
  ENKRYPT_OUTPUT_DETECTOR_IDS,
  ENKRYPT_PII_ENTITIES,
  type EnkryptDetectorId,
  type EnkryptInputDetectors,
  type EnkryptInputDetectorsSchema,
  type EnkryptOutputDetectorId,
  type EnkryptOutputDetectors,
  type EnkryptPiiEntity,
  type EnkryptPolicyRule,
} from '@kilocode/db/schema-types';
import type * as z from 'zod';

/**
 * Enkrypt's detector types. Block-type detectors answer with a block message; revise-type
 * detectors answer with rewritten input text. Either way the gateway decides from the verdict
 * whether a detection blocks.
 */
export const ENKRYPT_DETECTOR_TYPES = {
  injection_attack: 'block',
  topic_detector: 'block',
  policy_violation: 'block',
  toxicity: 'block',
  nsfw: 'block',
  sponge_attack: 'block',
  pii: 'revise',
  keyword_detector: 'revise',
  bias: 'revise',
} as const satisfies Record<EnkryptDetectorId, 'block' | 'revise'>;

/** Enkrypt reports two detectors in `summary` under names that differ from their request keys. */
export const ENKRYPT_SUMMARY_DETECTORS: Record<string, EnkryptDetectorId> = {
  injection_attack: 'injection_attack',
  on_topic: 'topic_detector',
  policy_violation: 'policy_violation',
  toxicity: 'toxicity',
  nsfw: 'nsfw',
  sponge_attack: 'sponge_attack',
  pii: 'pii',
  keyword_detected: 'keyword_detector',
  bias: 'bias',
};

/**
 * Kilo Default: prompt injection blocks; NSFW content and secrets are logged.
 * NSFW and secrets stay on whatever an organization saves; see `enforcedEnkryptInputDetectors`.
 */
export function createKiloDefaultEnkryptInputDetectors(): EnkryptInputDetectors {
  return {
    injection_attack: { enabled: true, action: 'block' },
    pii: { enabled: true, action: 'log', entities: ['secrets'] },
    keyword_detector: { enabled: false, action: 'block', banned_keywords: [] },
    topic_detector: { enabled: false, topic: [] },
    policy_violation: {
      enabled: false,
      action: 'block',
      format: 'rules',
      policy_text: '',
      rules: [],
    },
    toxicity: { enabled: false },
    nsfw: { enabled: true },
    bias: { enabled: false, action: 'log' },
    sponge_attack: { enabled: false },
  };
}

/** The input detectors admins can configure, in the order the page shows them. */
export const ENKRYPT_CONFIGURABLE_INPUT_DETECTOR_IDS = [
  'injection_attack',
  'policy_violation',
] as const satisfies readonly EnkryptDetectorId[];

/**
 * The input detectors the gateway enforces: the configurable ones as saved and Kilo Default for
 * every other one, whatever was saved for it. Every organization therefore logs NSFW content and
 * secrets while their input controls are unavailable.
 */
export function enforcedEnkryptInputDetectors(
  detectors: EnkryptInputDetectors
): EnkryptInputDetectors {
  return {
    ...createKiloDefaultEnkryptInputDetectors(),
    injection_attack: detectors.injection_attack,
    policy_violation: detectors.policy_violation,
  };
}

function withActionOnlyForLogging<Detector extends { enabled: boolean; action: 'log' | 'block' }>({
  action,
  ...detector
}: Detector) {
  return detector.enabled && action === 'log' ? { ...detector, action } : detector;
}

/**
 * The input detectors as saved. A configurable detector is saved with `action` only while it is set
 * to Log only, because versions from before the choice reject the key and then fail every scanned
 * request. A missing `action` reads as block, so a detector turned off resumes at Block.
 */
export function storableEnkryptInputDetectors(
  detectors: EnkryptInputDetectors
): z.input<typeof EnkryptInputDetectorsSchema> {
  return {
    ...detectors,
    injection_attack: withActionOnlyForLogging(detectors.injection_attack),
    policy_violation: withActionOnlyForLogging(detectors.policy_violation),
  };
}

export function enabledEnkryptDetectorIds(detectors: EnkryptInputDetectors): EnkryptDetectorId[] {
  return ENKRYPT_DETECTOR_IDS.filter(id => detectors[id].enabled);
}

/** Only detectors with input controls can block; hidden baseline detectors stay log-only. */
export function blockingEnkryptDetectorIds(detectors: EnkryptInputDetectors): EnkryptDetectorId[] {
  return ENKRYPT_CONFIGURABLE_INPUT_DETECTOR_IDS.filter(id => {
    const detector = detectors[id];
    return detector.enabled && detector.action === 'block';
  });
}

/** Output scanning has no Kilo Default, so every output detector starts off. */
export function createEmptyEnkryptOutputDetectors(): EnkryptOutputDetectors {
  return {
    pii: { enabled: false, action: 'block', entities: ['secrets'] },
    keyword_detector: { enabled: false, action: 'block', banned_keywords: [] },
    topic_detector: { enabled: false, action: 'block', topic: [] },
    policy_violation: {
      enabled: false,
      action: 'block',
      format: 'rules',
      policy_text: '',
      rules: [],
    },
    toxicity: { enabled: false, action: 'block' },
    nsfw: { enabled: false, action: 'block' },
    bias: { enabled: false, action: 'block' },
  };
}

export function enabledEnkryptOutputDetectorIds(
  detectors: EnkryptOutputDetectors
): EnkryptOutputDetectorId[] {
  return ENKRYPT_OUTPUT_DETECTOR_IDS.filter(id => detectors[id].enabled);
}

/** Enabled output detectors whose detection blocks the response. */
export function blockingEnkryptOutputDetectorIds(
  detectors: EnkryptOutputDetectors
): EnkryptOutputDetectorId[] {
  return enabledEnkryptOutputDetectorIds(detectors).filter(id => detectors[id].action === 'block');
}

/** Enkrypt scans a response with the same detector settings as a request. */
export function enkryptOutputDetectorsAsInputDetectors(
  detectors: EnkryptOutputDetectors
): EnkryptInputDetectors {
  const { topic_detector, policy_violation } = detectors;
  return {
    injection_attack: { enabled: false, action: 'block' },
    pii: detectors.pii,
    keyword_detector: detectors.keyword_detector,
    topic_detector: { enabled: topic_detector.enabled, topic: topic_detector.topic },
    policy_violation: {
      enabled: policy_violation.enabled,
      action: policy_violation.action,
      format: policy_violation.format,
      policy_text: policy_violation.policy_text,
      rules: policy_violation.rules,
    },
    toxicity: { enabled: detectors.toxicity.enabled },
    nsfw: { enabled: detectors.nsfw.enabled },
    bias: detectors.bias,
    sponge_attack: { enabled: false },
  };
}

type EnabledToggle = { enabled: true };

type EnkryptRequestPolicyRule = Omit<EnkryptPolicyRule, 'display_text'> & {
  display_text?: string;
  source: 'user';
  suggested: false;
};

/** The `detectors` object of Enkrypt's `POST /guardrails/detect` request. */
export type EnkryptDetectRequestDetectors = {
  injection_attack?: EnabledToggle & { need_explanation: false };
  pii?: EnabledToggle & { entities: EnkryptPiiEntity[] };
  keyword_detector?: EnabledToggle & { banned_keywords: string[] };
  topic_detector?: EnabledToggle & { topic: string[] };
  policy_violation?: EnabledToggle & { need_explanation: false } & (
      | { policy_text: string }
      | { rules: EnkryptRequestPolicyRule[] }
    );
  toxicity?: EnabledToggle;
  nsfw?: EnabledToggle;
  bias?: EnabledToggle;
  sponge_attack?: EnabledToggle;
};

function toRequestPolicyRule({
  display_text,
  ...rule
}: EnkryptPolicyRule): EnkryptRequestPolicyRule {
  return {
    ...rule,
    ...(display_text ? { display_text } : {}),
    source: 'user',
    suggested: false,
  };
}

/**
 * Explanations are always disabled: they cost extra credits, never change the verdict, and return
 * prompt-derived text Kilo neither stores nor shows. `policy_violation` explains unless told not to.
 */
export function buildEnkryptDetectRequestDetectors(
  detectors: EnkryptInputDetectors
): EnkryptDetectRequestDetectors {
  const request: EnkryptDetectRequestDetectors = {};
  const on = { enabled: true } as const;
  const {
    injection_attack,
    pii,
    keyword_detector,
    topic_detector,
    policy_violation,
    toxicity,
    nsfw,
    bias,
    sponge_attack,
  } = detectors;

  if (injection_attack.enabled) request.injection_attack = { ...on, need_explanation: false };
  if (pii.enabled) {
    request.pii = { ...on, entities: ENKRYPT_PII_ENTITIES.filter(e => pii.entities.includes(e)) };
  }
  if (keyword_detector.enabled) {
    request.keyword_detector = { ...on, banned_keywords: keyword_detector.banned_keywords };
  }
  if (topic_detector.enabled) request.topic_detector = { ...on, topic: topic_detector.topic };
  if (policy_violation.enabled) {
    request.policy_violation =
      policy_violation.format === 'rules'
        ? { ...on, need_explanation: false, rules: policy_violation.rules.map(toRequestPolicyRule) }
        : { ...on, need_explanation: false, policy_text: policy_violation.policy_text };
  }
  if (toxicity.enabled) request.toxicity = on;
  if (nsfw.enabled) request.nsfw = on;
  if (bias.enabled) request.bias = on;
  if (sponge_attack.enabled) request.sponge_attack = on;
  return request;
}
