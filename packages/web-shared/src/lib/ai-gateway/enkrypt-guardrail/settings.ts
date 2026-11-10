import type * as z from 'zod';
import {
  ENKRYPT_DETECTOR_IDS,
  EnkryptInputDetectorsSchema,
  EnkryptInputGuardrailSettingsSchema,
  EnkryptOutputDetectorsSchema,
  EnkryptOutputGuardrailSettingsSchema,
  type EnkryptDetectorId,
  type EnkryptGuardrailDirection,
  type EnkryptInputDetectors,
  type EnkryptOutputDetectors,
  type OrganizationSettings,
} from '@kilocode/db/schema-types';
import {
  blockingEnkryptDetectorIds,
  blockingEnkryptOutputDetectorIds,
  buildEnkryptDetectRequestDetectors,
  createKiloDefaultEnkryptInputDetectors,
  enabledEnkryptDetectorIds,
  enabledEnkryptOutputDetectorIds,
  enforcedEnkryptInputDetectors,
  enkryptOutputDetectorsAsInputDetectors,
  type EnkryptDetectRequestDetectors,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detectors';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';

/**
 * `invalid`: the organization enabled the guardrail but its saved detectors do not match the
 * schema, so every scanned request is rejected as if Enkrypt were unavailable rather than falling
 * back to a weaker policy.
 */
export type EnkryptInputGuardrailConfig = { scanToolResults: boolean } & (
  | {
      status: 'ready';
      detectors: EnkryptDetectRequestDetectors;
      blockingDetectors: EnkryptDetectorId[];
    }
  | { status: 'invalid' }
);

type Stored<Detectors> =
  | { status: 'missing' }
  | { status: 'invalid' }
  | { status: 'found'; detectors: Detectors };

export type StoredEnkryptDetectors = Stored<EnkryptInputDetectors>;

export type StoredEnkryptOutputDetectors = Stored<EnkryptOutputDetectors>;

function readStored<Detectors>(
  schema: z.ZodType<Detectors>,
  guardrail: EnkryptGuardrailDirection,
  organizationId: string,
  detectors: unknown
): Stored<Detectors> {
  if (detectors === undefined) return { status: 'missing' };
  const parsed = schema.safeParse(detectors);
  if (parsed.success) return { status: 'found', detectors: parsed.data };
  warnExceptInTest('[enkrypt-guardrail] saved detectors are invalid', {
    guardrail,
    organization_id: organizationId,
    issues: parsed.error.issues.map(issue => issue.path.join('.')),
  });
  return { status: 'invalid' };
}

/** The saved detectors of `settings.enkrypt.input_guardrail`, validated. */
export function readStoredEnkryptDetectors(
  organizationId: string,
  detectors: unknown
): StoredEnkryptDetectors {
  return readStored(EnkryptInputDetectorsSchema, 'input', organizationId, detectors);
}

/** The saved detectors of `settings.enkrypt.output_guardrail`, validated. */
export function readStoredEnkryptOutputDetectors(
  organizationId: string,
  detectors: unknown
): StoredEnkryptOutputDetectors {
  return readStored(EnkryptOutputDetectorsSchema, 'output', organizationId, detectors);
}

/**
 * The organization's input guardrail, or null when Kilo admins have not granted the feature
 * (`kilo_encrypt`), or the guardrail is absent, disabled, invalid in settings, or selects no
 * detector. Organizations that never saved detectors get Kilo Default. Only the configurable
 * detectors run, as saved; see `enforcedEnkryptInputDetectors`. Every input is
 * checked, including tool results, whatever `scan_tool_results` says.
 */
export function resolveEnkryptInputGuardrail(
  organizationId: string,
  settings: OrganizationSettings | undefined
): EnkryptInputGuardrailConfig | null {
  if (settings?.kilo_encrypt !== true) return null;
  const raw: unknown = settings.enkrypt?.input_guardrail;
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
  const stored = readStoredEnkryptDetectors(organizationId, parsed.data.detectors);
  if (stored.status === 'invalid') return { scanToolResults: true, status: 'invalid' };
  const detectors = enforcedEnkryptInputDetectors(
    stored.status === 'found' ? stored.detectors : createKiloDefaultEnkryptInputDetectors()
  );
  if (enabledEnkryptDetectorIds(detectors).length === 0) return null;
  return {
    scanToolResults: true,
    status: 'ready',
    detectors: buildEnkryptDetectRequestDetectors(detectors),
    blockingDetectors: blockingEnkryptDetectorIds(detectors),
  };
}

/**
 * The organization's output guardrail, or null when Kilo admins have not granted the feature
 * (`kilo_encrypt`), or the guardrail is absent, disabled, invalid in settings, or selects no
 * detector. Unlike the input guardrail it has no default, so an organization that never saved
 * output detectors scans no response. Responses have no tool results, so `scanToolResults` is
 * false.
 */
export function resolveEnkryptOutputGuardrail(
  organizationId: string,
  settings: OrganizationSettings | undefined
): EnkryptInputGuardrailConfig | null {
  if (settings?.kilo_encrypt !== true) return null;
  const raw: unknown = settings.enkrypt?.output_guardrail;
  if (raw === undefined) return null;
  const parsed = EnkryptOutputGuardrailSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    warnExceptInTest('[enkrypt-guardrail] invalid organization settings; guardrail disabled', {
      guardrail: 'output',
      organization_id: organizationId,
      issues: parsed.error.issues.map(issue => issue.path.join('.')),
    });
    return null;
  }
  if (!parsed.data.enabled) return null;

  const stored = readStoredEnkryptOutputDetectors(organizationId, parsed.data.detectors);
  if (stored.status === 'missing') return null;
  if (stored.status === 'invalid') return { scanToolResults: false, status: 'invalid' };
  if (enabledEnkryptOutputDetectorIds(stored.detectors).length === 0) return null;
  return {
    scanToolResults: false,
    status: 'ready',
    detectors: buildEnkryptDetectRequestDetectors(
      enkryptOutputDetectorsAsInputDetectors(stored.detectors)
    ),
    blockingDetectors: blockingEnkryptOutputDetectorIds(stored.detectors),
  };
}

type EnkryptInputGuardrailSplit = {
  blocking: EnkryptInputGuardrailConfig | null;
  logOnly: EnkryptInputGuardrailConfig | null;
};

function selectDetectors(
  detectors: EnkryptDetectRequestDetectors,
  ids: readonly EnkryptDetectorId[]
): EnkryptDetectRequestDetectors {
  const selected: EnkryptDetectRequestDetectors = {};
  const select = <Id extends EnkryptDetectorId>(id: Id) => {
    selected[id] = detectors[id];
  };
  ids.forEach(select);
  return selected;
}

/**
 * Log-only detectors never gate a request, so they are scanned in their own Enkrypt call that the
 * request does not wait for. Enkrypt bills each enabled detector per call, so the extra call only
 * adds its 1-credit per-call minimum. An invalid configuration stays blocking, so it keeps failing
 * closed.
 */
export function splitEnkryptInputGuardrail(
  config: EnkryptInputGuardrailConfig
): EnkryptInputGuardrailSplit {
  if (config.status === 'invalid') return { blocking: config, logOnly: null };
  const logOnlyDetectors = ENKRYPT_DETECTOR_IDS.filter(
    id => config.detectors[id] !== undefined && !config.blockingDetectors.includes(id)
  );
  return {
    blocking:
      config.blockingDetectors.length === 0
        ? null
        : { ...config, detectors: selectDetectors(config.detectors, config.blockingDetectors) },
    logOnly:
      logOnlyDetectors.length === 0
        ? null
        : {
            ...config,
            detectors: selectDetectors(config.detectors, logOnlyDetectors),
            blockingDetectors: [],
          },
  };
}
