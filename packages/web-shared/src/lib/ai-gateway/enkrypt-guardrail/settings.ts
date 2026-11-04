import {
  ENKRYPT_DETECTOR_IDS,
  EnkryptInputDetectorsSchema,
  EnkryptInputGuardrailSettingsSchema,
  type EnkryptDetectorId,
  type EnkryptInputDetectors,
  type OrganizationSettings,
} from '@kilocode/db/schema-types';
import {
  blockingEnkryptDetectorIds,
  buildEnkryptDetectRequestDetectors,
  createKiloDefaultEnkryptInputDetectors,
  enabledEnkryptDetectorIds,
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

export type StoredEnkryptDetectors =
  | { status: 'missing' }
  | { status: 'invalid' }
  | { status: 'found'; detectors: EnkryptInputDetectors };

/** The saved detectors of `settings.enkrypt.input_guardrail`, validated. */
export function readStoredEnkryptDetectors(
  organizationId: string,
  detectors: unknown
): StoredEnkryptDetectors {
  if (detectors === undefined) return { status: 'missing' };
  const parsed = EnkryptInputDetectorsSchema.safeParse(detectors);
  if (parsed.success) return { status: 'found', detectors: parsed.data };
  warnExceptInTest('[enkrypt-guardrail] saved detectors are invalid', {
    organization_id: organizationId,
    issues: parsed.error.issues.map(issue => issue.path.join('.')),
  });
  return { status: 'invalid' };
}

/**
 * The organization's input guardrail, or null when Kilo admins have not granted the feature
 * (`kilo_encrypt`), or the guardrail is absent, disabled, invalid in settings, or selects no
 * detector. Organizations that never saved detectors get Kilo Default.
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
  const scanToolResults = parsed.data.scan_tool_results ?? true;

  const stored = readStoredEnkryptDetectors(organizationId, parsed.data.detectors);
  if (stored.status === 'invalid') return { scanToolResults, status: 'invalid' };
  const detectors =
    stored.status === 'found' ? stored.detectors : createKiloDefaultEnkryptInputDetectors();
  if (enabledEnkryptDetectorIds(detectors).length === 0) return null;
  return {
    scanToolResults,
    status: 'ready',
    detectors: buildEnkryptDetectRequestDetectors(detectors),
    blockingDetectors: blockingEnkryptDetectorIds(detectors),
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
