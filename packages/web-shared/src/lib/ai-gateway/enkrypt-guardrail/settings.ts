import * as z from 'zod';
import { captureMessage } from '@sentry/nextjs';
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
import { claimReportWindow } from '@kilocode/web-shared/lib/ai-gateway/report-window';

/**
 * `invalid`: the organization enabled the guardrail but its saved detectors do not match the
 * schema, so every scanned request is rejected as if Enkrypt were unavailable rather than falling
 * back to a weaker policy.
 */
export type EnkryptGuardrailConfig =
  | {
      status: 'ready';
      detectors: EnkryptDetectRequestDetectors;
      blockingDetectors: EnkryptDetectorId[];
    }
  | { status: 'invalid' };

type Stored<Detectors> =
  | { status: 'missing' }
  | { status: 'invalid' }
  | { status: 'found'; detectors: Detectors };

type StoredEnkryptDetectors = Stored<EnkryptInputDetectors>;

type StoredEnkryptOutputDetectors = Stored<EnkryptOutputDetectors>;

/** The dotted paths of a schema failure, for a log that never carries the invalid value. */
function issuePaths(error: z.ZodError): string[] {
  return error.issues.map(issue => issue.path.join('.'));
}

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
    issues: issuePaths(parsed.error),
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

/** The settings section that holds each direction's guardrail. */
const GUARDRAIL_SETTINGS_KEYS = {
  input: 'input_guardrail',
  output: 'output_guardrail',
} as const satisfies Record<
  EnkryptGuardrailDirection,
  keyof NonNullable<OrganizationSettings['enkrypt']>
>;

/**
 * The enabled settings of one direction's guardrail, or null when Kilo admins have not granted the
 * feature (`kilo_encrypt`), or the section is absent, invalid, or disabled. A section that does not
 * match its schema is logged and reported to error monitoring with its issue paths, so on-call can
 * repair the stored settings.
 */
function resolveGuardrailSettings(
  organizationId: string,
  direction: EnkryptGuardrailDirection,
  settings: OrganizationSettings | undefined,
  schema: z.ZodType<{ enabled: boolean; detectors?: unknown }>
): { detectors: unknown } | null {
  if (settings?.kilo_encrypt !== true) return null;
  const section: unknown = settings.enkrypt?.[GUARDRAIL_SETTINGS_KEYS[direction]];
  if (section === undefined) return null;
  const parsed = schema.safeParse(section);
  if (!parsed.success) {
    // The request keeps being served and the report tells on-call what to repair. Both halves are
    // the intended policy for this branch: reading organization settings must not take the
    // organization's traffic down. The report is bounded per organization and direction so a
    // request loop cannot flood the event quota.
    const issues = issuePaths(parsed.error);
    warnExceptInTest('[enkrypt-guardrail] invalid organization settings; guardrail disabled', {
      guardrail: direction,
      organization_id: organizationId,
      issues,
    });
    if (
      claimReportWindow(`enkrypt-guardrail-settings:${organizationId}:${direction}`, Date.now())
    ) {
      captureMessage('[enkrypt-guardrail] invalid organization settings; guardrail disabled', {
        level: 'error',
        tags: { source: 'enkrypt_guardrail_settings', guardrail: direction },
        extra: { organization_id: organizationId, issues },
      });
    }
    return null;
  }
  if (!parsed.data.enabled) return null;
  return { detectors: parsed.data.detectors };
}

/**
 * The organization's input guardrail, or null when Kilo admins have not granted the feature
 * (`kilo_encrypt`), or the guardrail is absent, disabled, invalid in settings, or selects no
 * detector. Organizations that never saved detectors get Kilo Default.
 * Only the configurable detectors run, as saved; see `enforcedEnkryptInputDetectors`. Every input
 * is checked, including tool results. It applies only to members of `enkryptInputGuardrailGroupId`,
 * when that is set.
 */
export function resolveEnkryptInputGuardrail(
  organizationId: string,
  settings: OrganizationSettings | undefined
): EnkryptGuardrailConfig | null {
  const resolved = resolveGuardrailSettings(
    organizationId,
    'input',
    settings,
    EnkryptInputGuardrailSettingsSchema
  );
  if (resolved === null) return null;
  const stored = readStoredEnkryptDetectors(organizationId, resolved.detectors);
  if (stored.status === 'invalid') return { status: 'invalid' };
  const detectors = enforcedEnkryptInputDetectors(
    stored.status === 'found' ? stored.detectors : createKiloDefaultEnkryptInputDetectors()
  );
  if (enabledEnkryptDetectorIds(detectors).length === 0) return null;
  return {
    status: 'ready',
    detectors: buildEnkryptDetectRequestDetectors(detectors),
    blockingDetectors: blockingEnkryptDetectorIds(detectors),
  };
}

/**
 * The organization group the input guardrail is limited to, or null when it applies to every
 * member. Only meaningful while `resolveEnkryptInputGuardrail` returns a guardrail. A stored value
 * that is not a group ID cannot name a group, so the guardrail applies to every member instead of
 * to nobody.
 */
export function enkryptInputGuardrailGroupId(
  settings: OrganizationSettings | undefined
): string | null {
  const parsed = EnkryptInputGuardrailSettingsSchema.safeParse(settings?.enkrypt?.input_guardrail);
  if (!parsed.success) return null;
  const groupId = z.uuid().safeParse(parsed.data.group_id);
  return groupId.success ? groupId.data : null;
}

/** Whether the input guardrail applies to a member who belongs to `memberGroupIds`. */
export function enkryptInputGuardrailAppliesTo(
  settings: OrganizationSettings | undefined,
  memberGroupIds: readonly string[]
): boolean {
  const groupId = enkryptInputGuardrailGroupId(settings);
  return groupId === null || memberGroupIds.includes(groupId);
}

/**
 * The organization's output guardrail, or null when Kilo admins have not granted the feature
 * (`kilo_encrypt`), or the guardrail is absent, disabled, invalid in settings, or selects no
 * detector. Unlike the input guardrail it has no default, so an organization that never saved
 * output detectors scans no response.
 */
export function resolveEnkryptOutputGuardrail(
  organizationId: string,
  settings: OrganizationSettings | undefined
): EnkryptGuardrailConfig | null {
  const resolved = resolveGuardrailSettings(
    organizationId,
    'output',
    settings,
    EnkryptOutputGuardrailSettingsSchema
  );
  if (resolved === null) return null;

  const stored = readStoredEnkryptOutputDetectors(organizationId, resolved.detectors);
  if (stored.status === 'missing') return null;
  if (stored.status === 'invalid') return { status: 'invalid' };
  if (enabledEnkryptOutputDetectorIds(stored.detectors).length === 0) return null;
  return {
    status: 'ready',
    detectors: buildEnkryptDetectRequestDetectors(
      enkryptOutputDetectorsAsInputDetectors(stored.detectors)
    ),
    blockingDetectors: blockingEnkryptOutputDetectorIds(stored.detectors),
  };
}

type EnkryptInputGuardrailSplit = {
  blocking: EnkryptGuardrailConfig | null;
  logOnly: EnkryptGuardrailConfig | null;
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
 * adds the per-call minimums of its detectors, which are small for most detectors but about 5
 * credits for a policy. An invalid configuration stays blocking, so it keeps failing closed.
 */
export function splitEnkryptInputGuardrail(
  config: EnkryptGuardrailConfig
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
