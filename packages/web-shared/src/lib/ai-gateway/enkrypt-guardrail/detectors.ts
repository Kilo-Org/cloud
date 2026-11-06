import {
  ENKRYPT_DETECTOR_IDS,
  ENKRYPT_OUTPUT_DETECTOR_IDS,
  ENKRYPT_PII_ENTITIES,
  type EnkryptDetectorId,
  type EnkryptInputDetectors,
  type EnkryptOutputDetectorId,
  type EnkryptOutputDetectors,
  type EnkryptPiiEntity,
  type EnkryptPolicyRule,
} from '@kilocode/db/schema-types';

/**
 * Enkrypt's detector types. Block-type detectors answer with a block message; revise-type
 * detectors answer with rewritten input text, so whether they block is the organization's choice.
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

/** Kilo Default: injection detection blocks; secrets detection is logged, as Enkrypt intends. */
export function createKiloDefaultEnkryptInputDetectors(): EnkryptInputDetectors {
  return {
    injection_attack: { enabled: true },
    pii: { enabled: true, action: 'log', entities: ['secrets'] },
    keyword_detector: { enabled: false, action: 'block', banned_keywords: [] },
    topic_detector: { enabled: false, topic: [] },
    policy_violation: { enabled: false, format: 'rules', policy_text: '', rules: [] },
    toxicity: { enabled: false },
    nsfw: { enabled: false },
    bias: { enabled: false, action: 'log' },
    sponge_attack: { enabled: false },
  };
}

/** The input detectors admins can configure: the ones that matter most for developers. */
export const ENKRYPT_CONFIGURABLE_INPUT_DETECTOR_IDS = [
  'injection_attack',
  'pii',
  'policy_violation',
  'nsfw',
] as const satisfies readonly EnkryptDetectorId[];

/**
 * The input detectors the gateway enforces: the configurable ones as saved, and every other one
 * off as in Kilo Default, whatever was saved for it before it stopped being offered.
 */
export function enforcedEnkryptInputDetectors(
  detectors: EnkryptInputDetectors
): EnkryptInputDetectors {
  return {
    ...createKiloDefaultEnkryptInputDetectors(),
    injection_attack: detectors.injection_attack,
    pii: detectors.pii,
    policy_violation: detectors.policy_violation,
    nsfw: detectors.nsfw,
  };
}

export function enabledEnkryptDetectorIds(detectors: EnkryptInputDetectors): EnkryptDetectorId[] {
  return ENKRYPT_DETECTOR_IDS.filter(id => detectors[id].enabled);
}

/** Enabled detectors whose detection blocks the request. */
export function blockingEnkryptDetectorIds(detectors: EnkryptInputDetectors): EnkryptDetectorId[] {
  return enabledEnkryptDetectorIds(detectors).filter(id => {
    const detector = detectors[id];
    return 'action' in detector ? detector.action === 'block' : true;
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
    injection_attack: { enabled: false },
    pii: detectors.pii,
    keyword_detector: detectors.keyword_detector,
    topic_detector: { enabled: topic_detector.enabled, topic: topic_detector.topic },
    policy_violation: {
      enabled: policy_violation.enabled,
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
