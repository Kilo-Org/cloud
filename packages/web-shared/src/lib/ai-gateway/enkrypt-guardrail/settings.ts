import {
  EnkryptInputGuardrailSettingsSchema,
  type EnkryptInputGuardrailSettings,
  type EnkryptPiiEntity,
  type OrganizationSettings,
} from '@kilocode/db/schema-types';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';

/** The `detectors` object of Enkrypt's `POST /guardrails/detect` request. */
export type EnkryptDetectors = {
  injection_attack?: { enabled: true; need_explanation: false };
  pii?: { enabled: true; entities: EnkryptPiiEntity[] };
  nsfw?: { enabled: true };
  toxicity?: { enabled: true };
};

export type EnkryptInputGuardrailConfig = {
  failMode: 'open' | 'closed';
  detectors: EnkryptDetectors;
};

/**
 * Injection detection covers indirect prompt injection in tool results, the main threat to coding
 * agents; secrets detection reports credentials read into the conversation.
 */
export const DEFAULT_ENKRYPT_DETECTORS = {
  injection_attack: true,
  pii_entities: ['secrets'],
} satisfies EnkryptInputGuardrailSettings['detectors'];

function enkryptDetectors(
  selection: NonNullable<EnkryptInputGuardrailSettings['detectors']>
): EnkryptDetectors {
  const piiEntities = [...new Set(selection.pii_entities ?? [])];
  return {
    // Explanations double the detector's credit cost and never change the verdict.
    ...(selection.injection_attack
      ? { injection_attack: { enabled: true, need_explanation: false } }
      : {}),
    ...(piiEntities.length > 0 ? { pii: { enabled: true, entities: piiEntities } } : {}),
    ...(selection.nsfw ? { nsfw: { enabled: true } } : {}),
    ...(selection.toxicity ? { toxicity: { enabled: true } } : {}),
  };
}

/**
 * The organization's input guardrail, or null when it is absent, disabled, invalid, or selects no
 * detector. Organization settings are edited directly in the database for now, so they are
 * validated here rather than trusted.
 */
export function resolveEnkryptInputGuardrail(
  organizationId: string,
  settings: OrganizationSettings | undefined
): EnkryptInputGuardrailConfig | null {
  const raw: unknown = settings?.enkrypt?.input_guardrail;
  if (raw === undefined) return null;
  const parsed = EnkryptInputGuardrailSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    warnExceptInTest('[enkrypt-guardrail] invalid organization settings; guardrail disabled', {
      organization_id: organizationId,
      issues: parsed.error.issues.map(issue => issue.path.join('.')),
    });
    return null;
  }
  if (!parsed.data.enabled) return null;
  const detectors = enkryptDetectors(parsed.data.detectors ?? DEFAULT_ENKRYPT_DETECTORS);
  if (Object.keys(detectors).length === 0) return null;
  return { failMode: parsed.data.fail_mode ?? 'open', detectors };
}
