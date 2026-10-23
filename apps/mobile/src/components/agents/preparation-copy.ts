import { type TFunction } from 'i18next';
import { type PreparationStepSnapshot } from '@kilocode/cloud-agent-sdk';

import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';

/**
 * Preparation rows carry the control plane's own vocabulary: phase keys
 * (`sandbox_provision`) for a row's name and English progress sentences
 * (`Retrying sandbox creation`) or route failure codes (`preparation_timeout`)
 * for its detail. Every one of them resolves through the catalog, so a
 * translated screen never shows an English phase name or a raw machine code.
 *
 * The server vocabulary is closed: the phase keys are `PreparingStep`
 * (`services/cloud-agent-next/src/shared/protocol.ts`) and the failure codes are
 * `CONTROL_PLANE_FAILURE_REASON_VALUES`. A value outside these tables falls
 * back to generic catalog copy rather than rendering untranslated text.
 */
const STEP_LABEL_KEYS = {
  workspace_setup: 'agentChat.preparation.stepWorkspaceSetup',
  disk_check: 'agentChat.preparation.stepDiskCheck',
  cloning: 'agentChat.preparation.stepCloning',
  branch: 'agentChat.preparation.stepBranch',
  devcontainer_setup: 'agentChat.preparation.stepDevcontainerSetup',
  setup_commands: 'agentChat.preparation.detailRunningSetupCommands',
  workspace_restore: 'agentChat.preparation.stepWorkspaceRestore',
  workspace_backup: 'agentChat.preparation.stepWorkspaceBackup',
  sandbox_provision: 'agentChat.preparation.stepSandboxProvision',
  sandbox_boot: 'agentChat.preparation.stepSandboxBoot',
  snapshot_fallback: 'agentChat.preparation.stepSnapshotFallback',
  kilo_server: 'agentChat.preparation.stepKiloServer',
  kilo_session: 'agentChat.preparation.stepKiloSession',
  restore_incomplete: 'agentChat.preparation.stepRestoreIncomplete',
  ready: 'agentChat.preparation.stepReady',
  failed: 'agentChat.preparation.stepFailed',
} satisfies Record<string, string>;

/**
 * The control plane's own English sentences, keyed without their trailing
 * ellipsis or period: the same phase detail arrives both ways (`Cloning
 * repository...` from the wrapper, `Cloning repository` from the route step).
 */
const MESSAGE_KEYS = {
  'Preparing environment': 'agentChat.preparation.preparingEnvironment',
  'Creating sandbox': 'agentChat.preparation.detailCreatingSandbox',
  'Starting sandbox': 'agentChat.preparation.stepSandboxBoot',
  'Retrying without a snapshot': 'agentChat.preparation.stepSnapshotFallback',
  'Cloning repository': 'agentChat.preparation.stepCloning',
  'Updating repository': 'agentChat.preparation.detailUpdatingRepository',
  'Checking out branch': 'agentChat.preparation.detailCheckingOutBranch',
  'Running setup commands': 'agentChat.preparation.detailRunningSetupCommands',
  'Saving repository for faster starts': 'agentChat.preparation.detailSavingRepository',
  'Starting Kilo runtime': 'agentChat.preparation.detailStartingKiloRuntime',
  'Starting Kilo': 'agentChat.preparation.stepKiloServer',
  'Preparing Kilo session': 'agentChat.preparation.detailPreparingKiloSession',
  'Waiting for the previous sandbox to stop':
    'agentChat.preparation.detailWaitingForPreviousSandbox',
  'Retrying sandbox creation': 'agentChat.preparation.detailRetryingSandboxCreation',
  'Previous snapshot startup failed. Retrying without a snapshot':
    'agentChat.preparation.detailPreviousSnapshotFailed',
  'Snapshot startup failed. Retrying without a snapshot':
    'agentChat.preparation.detailSnapshotStartupFailed',
  'Starting sandbox without a snapshot':
    'agentChat.preparation.detailStartingSandboxWithoutSnapshot',
  'Setting up workspace': 'agentChat.preparation.detailSettingUpWorkspace',
  'Setting up branch': 'agentChat.preparation.stepBranch',
  'Restoring session': 'agentChat.preparation.detailRestoringSession',
  'Importing session': 'agentChat.newSession.importingSession',
  'Warm workspace reused': 'agentChat.preparation.detailWarmWorkspaceReused',
  'Session restore incomplete': 'agentChat.preparation.stepRestoreIncomplete',
  'Preparation did not complete': 'agentChat.preparation.errorPreparationDidNotComplete',
} satisfies Record<string, string>;

/**
 * Route failure codes. The control plane stores the code itself as the
 * attempt's `safeError`, so a failed preparation surfaces it as body text
 * unless the app names it.
 */
const ERROR_KEYS = {
  preparation_timeout: 'agentChat.preparation.errorPreparationTimeout',
  workspace_setup_failed: 'agentChat.preparation.errorWorkspaceSetupFailed',
  credential_upgrade_required: 'agentChat.preparation.errorCredentialUpgradeRequired',
  agent_unavailable: 'agentChat.preparation.errorAgentUnavailable',
  billing_blocked: 'agentChat.preparation.errorBillingBlocked',
  billing_unavailable: 'agentChat.preparation.errorBillingUnavailable',
  container_limit_reached: 'agentChat.preparation.errorContainerLimitReached',
  invalid_configuration: 'agentChat.preparation.errorInvalidConfiguration',
  runtime_artifact_unauthorized: 'agentChat.preparation.errorRuntimeArtifactUnauthorized',
  runtime_artifact_invalid: 'agentChat.preparation.errorRuntimeArtifactInvalid',
  runtime_cli_probe_failed: 'agentChat.preparation.errorRuntimeCliProbeFailed',
  runtime_supervisor_missing: 'agentChat.preparation.errorRuntimeSupervisorMissing',
  connection_lost: 'agentChat.preparation.errorConnectionLost',
  sandbox_lost: 'agentChat.preparation.errorSandboxLost',
  agent_restarted: 'agentChat.preparation.errorAgentRestarted',
  sandbox_out_of_memory: 'agentChat.preparation.errorSandboxOutOfMemory',
} satisfies Record<string, string>;

/** Why a snapshot restore skipped a file (`RESTORE_SKIP_REASON_WORDS`). */
const RESTORE_REASON_KEYS = {
  'the patch did not apply': 'agentChat.preparation.detailReasonPatchFailed',
  'the path is outside the workspace': 'agentChat.preparation.detailReasonOutsideWorkspace',
  'the snapshot carried no content for the file':
    'agentChat.preparation.detailReasonMissingContent',
  'the index could not be reset after a failed apply':
    'agentChat.preparation.detailReasonIndexResetFailed',
  'the file could not be removed': 'agentChat.preparation.detailReasonUnlinkFailed',
  'the file could not be written': 'agentChat.preparation.detailReasonWriteFailed',
} satisfies Record<string, string>;

const RESTORE_REPORT_PATTERN =
  /^Session restore incomplete: (\d+) of (\d+) files were not restored \(([^)]*)\)\.?(?: Missing: (.*))?$/u;
const RESTORE_MORE_PATTERN = /^(.*) and (\d+) more$/u;
const CLONE_RETRY_PATTERN = /^Retrying clone \(attempt (\d+) of (\d+)\)$/u;
const SETUP_COMMAND_FAILED_PATTERN = /^Setup command (\d+) failed$/u;
const SETUP_COMMAND_TIMED_OUT_PATTERN = /^Setup command (\d+) timed out$/u;
const COLD_RESTORE_PATTERN = /^Cold restore, snapshot applied, (\d+)\/(\d+) files restored$/u;
const GIT_PROGRESS_PATTERN = /(\d{1,3})%$/u;

/** Looks up a possibly-unknown key in a literal dictionary without widening its type. */
function lookup<V>(dictionary: Readonly<Record<string, V>>, key: string): V | undefined {
  return (dictionary as Readonly<Record<string, V | undefined>>)[key];
}

function localizedNumber(value: string): string {
  return formatNumber(Number(value), i18n.language);
}

/**
 * A row's name: the localized phase name for its server key, or a generic name
 * for a key this app does not know. Setup-command rows carry their own label
 * from the caller and never reach here.
 */
export function preparationStepLabel(step: PreparationStepSnapshot, t: TFunction): string {
  const key = lookup(STEP_LABEL_KEYS, step.key);
  return t(key ?? 'agentChat.preparation.stepUnknown');
}

/**
 * A live progress line. Known sentences and the phase's own progress patterns
 * read in the app language; anything else becomes a generic line rather than an
 * English sentence, so a newer server can never leak untranslated copy.
 */
export function preparationDetailText(detail: string, t: TFunction): string {
  return resolvePreparationText(detail, t) ?? t('agentChat.preparation.detailUnknown');
}

/**
 * A failure line. Route reason codes and the wrapper's own failure sentences
 * read in the app language; an unknown value falls back to the attempt's
 * failure title.
 */
export function preparationErrorText(error: string, t: TFunction): string {
  return resolvePreparationText(error, t) ?? t('agentChat.preparation.preparationFailed');
}

function resolvePreparationText(raw: string, t: TFunction): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const report = resolveRestoreReport(trimmed, t);
  if (report !== undefined) {
    return report;
  }
  // The wrapper ends a sentence with an ellipsis where the route step ends it
  // with nothing, so compare without trailing punctuation.
  const text = trimmed.replace(/[.…]+$/u, '');
  const known = lookup(MESSAGE_KEYS, text) ?? lookup(ERROR_KEYS, text);
  if (known !== undefined) {
    return t(known);
  }
  const cloneRetry = CLONE_RETRY_PATTERN.exec(text);
  if (cloneRetry) {
    return t('agentChat.preparation.detailRetryingClone', {
      attempt: localizedNumber(cloneRetry[1] ?? ''),
      total: localizedNumber(cloneRetry[2] ?? ''),
    });
  }
  const setupFailed = SETUP_COMMAND_FAILED_PATTERN.exec(text);
  if (setupFailed) {
    return t('agentChat.preparation.detailSetupCommandFailed', {
      index: localizedNumber(setupFailed[1] ?? ''),
    });
  }
  const setupTimedOut = SETUP_COMMAND_TIMED_OUT_PATTERN.exec(text);
  if (setupTimedOut) {
    return t('agentChat.preparation.detailSetupCommandTimedOut', {
      index: localizedNumber(setupTimedOut[1] ?? ''),
    });
  }
  const coldRestore = COLD_RESTORE_PATTERN.exec(text);
  if (coldRestore) {
    return t('agentChat.preparation.detailColdRestore', {
      applied: localizedNumber(coldRestore[1] ?? ''),
      total: localizedNumber(coldRestore[2] ?? ''),
    });
  }
  // Git's own clone progress, which the wrapper prefixes with its phase line.
  const progress = GIT_PROGRESS_PATTERN.exec(text);
  if (progress) {
    return t('agentChat.preparation.detailProgressPercent', {
      percent: localizedNumber(progress[1] ?? ''),
    });
  }
  return undefined;
}

/**
 * The wrapper's named report for a restore that left files behind, which also
 * titles the group: counts, why each file was skipped, and the paths.
 */
function resolveRestoreReport(raw: string, t: TFunction): string | undefined {
  const match = RESTORE_REPORT_PATTERN.exec(raw);
  if (!match) {
    return undefined;
  }
  const reasons = (match[3] ?? '')
    .split(', ')
    .map(reason => {
      const key = lookup(RESTORE_REASON_KEYS, reason);
      return key === undefined ? t('agentChat.preparation.detailReasonUnknown') : t(key);
    })
    .join(', ');
  const summary = t('agentChat.preparation.detailRestoreIncompleteReport', {
    skipped: localizedNumber(match[1] ?? ''),
    total: localizedNumber(match[2] ?? ''),
    reasons,
  });
  const missing = match[4];
  if (missing === undefined || missing.length === 0) {
    return summary;
  }
  const more = RESTORE_MORE_PATTERN.exec(missing);
  const paths =
    more === null
      ? missing
      : t('agentChat.preparation.detailRestoreIncompleteMore', {
          listed: more[1] ?? '',
          omitted: localizedNumber(more[2] ?? ''),
        });
  return `${summary} ${t('agentChat.preparation.detailRestoreIncompleteMissing', { paths })}`;
}
