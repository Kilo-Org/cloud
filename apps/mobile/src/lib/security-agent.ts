import { isActiveSecurityCommand } from '@kilocode/app-shared/security-agent';
import {
  type inferRouterInputs,
  type inferRouterOutputs,
  type MobileRouter,
} from '@kilocode/trpc/mobile';
import { type Href } from 'expo-router';

type RouterInputs = inferRouterInputs<MobileRouter>;
type RouterOutputs = inferRouterOutputs<MobileRouter>;

export type SecurityAgentConfig = RouterOutputs['securityAgent']['getConfig'];
export type SecurityAgentConfigPatch = RouterInputs['securityAgent']['saveConfig'];
/**
 * Flattened form of the discriminated-union config. `getConfig` returns a
 * union on `hasConfig`/`configRevision`; optimistic-update spreads and
 * dirty-state refs need a single object shape, so this collapses the union.
 */
export type FlattenedSecurityAgentConfig = {
  [K in keyof SecurityAgentConfig]: SecurityAgentConfig[K];
};
export type SecurityFinding = RouterOutputs['securityAgent']['getFinding'];
export type SecurityAnalysis = RouterOutputs['securityAgent']['getAnalysis'];
export type SecurityCommand = NonNullable<RouterOutputs['securityAgent']['getCommandStatus']>;
export type SecurityCommandBatch = RouterOutputs['securityAgent']['getCommandStatuses'];

export function getSecurityAgentPath(scope: string, suffix = ''): Href {
  const path = `/(app)/security-agent/${scope}`;
  return (suffix ? `${path}/${suffix}` : path) as Href;
}

// The server batch procedure is bounded to 100 ids. The recovery source is
// limited server-side, but the tracked-id merge unions in-session mutation ids
// on top, so the total can exceed this cap.
export const BATCH_COMMAND_LIMIT = 100;

// The tRPC procedure-missing signature: a NOT_FOUND whose message matches
// `No "query"-procedure`. A bare NOT_FOUND is the per-command purge path and
// must never engage the old-server fallback.
export function isMissingBatchProcedureError(error: unknown): boolean {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the tRPC client error is an untyped boundary value; decode its shape before branching
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const err = error as { message?: unknown; data?: { code?: unknown } };
  return (
    err.data?.code === 'NOT_FOUND' &&
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- decode the message field before matching the signature
    typeof err.message === 'string' &&
    err.message.includes('No "query"-procedure')
  );
}

// Splits the tracked ids into the server-bounded batch slice (first 100) and
// the per-command overflow (the rest).
export function splitTrackedCommandIds(trackedIds: readonly string[]) {
  return {
    batchIds: trackedIds.slice(0, BATCH_COMMAND_LIMIT),
    overflowIds: trackedIds.slice(BATCH_COMMAND_LIMIT),
  };
}

export type CommandStatusQueryResult = {
  data?: SecurityCommand;
  error?: { data?: { code?: string } | null } | null;
};

export type CommandStatusReconciliation = {
  terminalCommands: SecurityCommand[];
  unavailableIds: string[];
};

// Builds a Map<id, command> from the batch array plus per-command results,
// then splits the tracked ids into terminal commands (present and inactive)
// and unavailable ids (absent once the source settled, or NOT_FOUND).
export function reconcileCommandStatuses(args: {
  trackedIds: readonly string[];
  batchIds: readonly string[];
  perCommandIds: readonly string[];
  batchCommands: SecurityCommandBatch | undefined;
  batchSettled: boolean;
  perCommandResults: readonly CommandStatusQueryResult[];
  processedTerminalIds: ReadonlySet<string>;
}): CommandStatusReconciliation {
  const {
    trackedIds,
    batchIds,
    perCommandIds,
    batchCommands,
    batchSettled,
    perCommandResults,
    processedTerminalIds,
  } = args;
  const commandsById = new Map<string, SecurityCommand>();
  for (const command of batchCommands ?? []) {
    commandsById.set(command.id, command);
  }
  for (const result of perCommandResults) {
    if (result.data) {
      commandsById.set(result.data.id, result.data);
    }
  }

  const terminalCommands: SecurityCommand[] = [];
  for (const command of commandsById.values()) {
    if (!isActiveSecurityCommand(command) && !processedTerminalIds.has(command.id)) {
      terminalCommands.push(command);
    }
  }

  const unavailableIds = trackedIds.flatMap(id => {
    if (commandsById.has(id) || processedTerminalIds.has(id)) {
      return [];
    }
    if (batchIds.includes(id)) {
      // The batch omits unknown ids; purge only once it settled without them.
      return batchSettled ? [id] : [];
    }
    const index = perCommandIds.indexOf(id);
    const result = index === -1 ? undefined : perCommandResults.at(index);
    return result?.error?.data?.code === 'NOT_FOUND' ? [id] : [];
  });

  return { terminalCommands, unavailableIds };
}

/**
 * The remediation fields the stale-analysis action reads, so both detail panels
 * can pass their `getAnalysis` response without reshaping it.
 */
type SecurityRemediationSignal = Pick<
  SecurityAnalysis,
  'remediationAttempts' | 'remediationCapability' | 'remediationSummary'
>;

/** The server's own record that a remediation attempt already exists. */
function hasRegisteredRemediationAttempt(analysis: SecurityRemediationSignal): boolean {
  return (
    analysis.remediationAttempts.length > 0 ||
    Boolean(
      analysis.remediationSummary?.latestAttemptId ?? analysis.remediationSummary?.latestAttempt?.id
    )
  );
}

/**
 * Whether a stale analysis is the only thing blocking remediation, mirroring
 * FindingDetailDialog.tsx's `remediationNeedsAnalysisRefresh`: a finding that
 * never registered an attempt, whose capability rejects the start or the retry
 * because the finding changed after the analysis that produced it.
 */
export function remediationNeedsAnalysisRefresh(analysis: SecurityRemediationSignal): boolean {
  return (
    !hasRegisteredRemediationAttempt(analysis) &&
    (analysis.remediationCapability.startReason === 'stale_analysis' ||
      analysis.remediationCapability.retryReason === 'stale_analysis')
  );
}

/**
 * Whether the finding's row offers the Analyze action: an open finding that was
 * never analyzed or whose analysis failed, and whose remediation has not opened
 * a PR (that row shows View PR instead). Eligibility only — whether the action
 * can run right now is the separate capacity state.
 */
export function isSecurityFindingAnalyzable(finding: SecurityFinding): boolean {
  const remediationPrUrl =
    finding.remediationSummary?.status === 'pr_opened' ? finding.remediationSummary.prUrl : null;
  return (
    !remediationPrUrl &&
    finding.status === 'open' &&
    (!finding.analysis_status || finding.analysis_status === 'failed')
  );
}
