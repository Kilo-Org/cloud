import { useEffect, useRef } from 'react';
import type { PostHog } from 'posthog-js/react';
import type { RowOutcome } from './rowExecutor';

export type WizardType = 'add' | 'remove';

/**
 * Selections at or above this size are flagged as "large" for telemetry —
 * this Phase 1 UI's rollout question is whether bulk edits are commonly
 * small (fine for one-row-at-a-time UX) or large enough to justify a
 * Phase 2 backend built for batch operations.
 */
export const LARGE_SELECTION_THRESHOLD = 15;

export function isLargeSelection(selectedPersonCount: number): boolean {
  return selectedPersonCount >= LARGE_SELECTION_THRESHOLD;
}

/**
 * A wizard run counts as a "repeat" if it starts within this many
 * milliseconds of a previous run of the same wizard type, for the same
 * parent org, in the same browser session.
 */
export const REPEAT_RUN_WINDOW_MS = 15 * 60 * 1000;

export function isWithinRepeatRunWindow(lastRunAt: number | null, now: number): boolean {
  return lastRunAt !== null && now - lastRunAt < REPEAT_RUN_WINDOW_MS;
}

function repeatRunStorageKey(parentOrganizationId: string, wizardType: WizardType): string {
  return `sub_org_directory.last_wizard_run.${parentOrganizationId}:${wizardType}`;
}

/**
 * Records "a wizard of this type just ran for this parent org" and reports
 * whether that counts as a repeat of a previous run within the rolling
 * window. Backed by `sessionStorage`, keyed by `${parentOrganizationId}:
 * ${wizardType}`, so it survives the wizard/drawer remounting between runs
 * but stays scoped to one browser tab — deliberately minimal, not a
 * general "recent events" store.
 */
export function checkAndRecordWizardRun(
  parentOrganizationId: string,
  wizardType: WizardType,
  now: number = Date.now()
): boolean {
  if (typeof sessionStorage === 'undefined') return false;
  const key = repeatRunStorageKey(parentOrganizationId, wizardType);
  const stored = sessionStorage.getItem(key);
  const lastRunAt = stored === null ? null : Number(stored);
  const isRepeat = isWithinRepeatRunWindow(lastRunAt, now);
  sessionStorage.setItem(key, String(now));
  return isRepeat;
}

export type FailureSummary = {
  failedCount: number;
  totalCount: number;
  hasFailure: boolean;
};

/**
 * Summarizes a completed wizard run's outcomes for the partial-failure
 * event. A `failed` row is the only status that counts as a failure here —
 * `skipped` rows (already-a-member, can't-remove-an-owner, etc.) are
 * expected outcomes, not failures.
 */
export function summarizeFailures(outcomes: RowOutcome[]): FailureSummary {
  const failedCount = outcomes.filter(outcome => outcome.status === 'failed').length;
  return { failedCount, totalCount: outcomes.length, hasFailure: failedCount > 0 };
}

/**
 * Fires the `wizard_run` event, and its `wizard_large_selection` and
 * `wizard_repeat_run` companions when applicable, for one wizard execution.
 * Shared by both bulk-action wizards so the run-time telemetry logic lives
 * in one place rather than being duplicated per wizard.
 */
export function captureWizardRun(
  posthog: PostHog | undefined,
  params: {
    parentOrganizationId: string;
    wizardType: WizardType;
    targetOrganizationId: string;
    selectedPersonCount: number;
  }
): void {
  const { parentOrganizationId, wizardType, targetOrganizationId, selectedPersonCount } = params;

  posthog?.capture('sub_org_directory.wizard_run', {
    parentOrganizationId,
    wizardType,
    targetOrganizationId,
    selectedPersonCount,
  });

  if (isLargeSelection(selectedPersonCount)) {
    posthog?.capture('sub_org_directory.wizard_large_selection', {
      parentOrganizationId,
      wizardType,
      targetOrganizationId,
      selectedPersonCount,
    });
  }

  if (checkAndRecordWizardRun(parentOrganizationId, wizardType)) {
    posthog?.capture('sub_org_directory.wizard_repeat_run', {
      parentOrganizationId,
      wizardType,
    });
  }
}

/**
 * Fires `wizard_partial_failure` once, if — and only if — `outcomes`
 * contains at least one `failed` row. Callers are responsible for calling
 * this exactly once per completed run (see the `wasRunningRef` guard in
 * each wizard's results step).
 */
export function capturePartialFailureIfAny(
  posthog: PostHog | undefined,
  params: { parentOrganizationId: string; wizardType: WizardType },
  outcomes: RowOutcome[]
): void {
  const summary = summarizeFailures(outcomes);
  if (!summary.hasFailure) return;
  posthog?.capture('sub_org_directory.wizard_partial_failure', {
    parentOrganizationId: params.parentOrganizationId,
    wizardType: params.wizardType,
    failedCount: summary.failedCount,
    totalCount: summary.totalCount,
  });
}

/**
 * Wires a wizard's results step into the run-telemetry lifecycle: fires
 * `captureWizardRun` and calls `start()` exactly once, on mount, then fires
 * `capturePartialFailureIfAny` exactly once, the first time the run
 * transitions from running to not-running (the initial run, or a retry).
 * Both bulk-action wizards' results steps had this identical pair of
 * mount/completion effects duplicated before this was pulled out.
 */
export function useWizardRunTelemetry(params: {
  posthog: PostHog | undefined;
  parentOrganizationId: string;
  wizardType: WizardType;
  targetOrganizationId: string;
  selectedPersonCount: number;
  start: () => void;
  isRunning: boolean;
  outcomes: RowOutcome[];
}): void {
  const {
    posthog,
    parentOrganizationId,
    wizardType,
    targetOrganizationId,
    selectedPersonCount,
    start,
    isRunning,
    outcomes,
  } = params;

  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    captureWizardRun(posthog, {
      parentOrganizationId,
      wizardType,
      targetOrganizationId,
      selectedPersonCount,
    });
    start();
    // Intentionally run once on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const wasRunningRef = useRef(false);
  const firedPartialFailureRef = useRef(false);
  useEffect(() => {
    if (isRunning) {
      wasRunningRef.current = true;
      return;
    }
    if (!wasRunningRef.current || firedPartialFailureRef.current) return;
    firedPartialFailureRef.current = true;
    capturePartialFailureIfAny(posthog, { parentOrganizationId, wizardType }, outcomes);
  }, [isRunning, outcomes, posthog, parentOrganizationId, wizardType]);
}
