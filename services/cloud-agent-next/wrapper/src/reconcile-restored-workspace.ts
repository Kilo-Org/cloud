import type { ExecResult } from './utils.js';

export class RestoredWorkspaceReconciliationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RestoredWorkspaceReconciliationError';
  }
}

export type RestoredWorkspaceStep = 'fetch' | 'checkout';

export type RestoredWorkspaceRunner = (
  args: string[],
  step: RestoredWorkspaceStep
) => Promise<ExecResult>;

export type RestoredWorkspaceReconcileOptions = {
  runGit: RestoredWorkspaceRunner;
  sourceRef: string;
  branchName: string;
};

/**
 * Fetch `sourceRef` from `origin` and reset `branchName` onto it. Source
 * selection stays with the caller; this owns only the fetch/checkout mechanic.
 */
export async function reconcileRestoredWorkspaceRef(
  options: RestoredWorkspaceReconcileOptions
): Promise<void> {
  const fetchResult = await options.runGit(['fetch', 'origin', options.sourceRef], 'fetch');
  if (fetchResult.exitCode !== 0) {
    throw new RestoredWorkspaceReconciliationError('Failed to fetch authoritative remote state');
  }

  const checkoutResult = await options.runGit(
    ['checkout', '-B', options.branchName, 'FETCH_HEAD'],
    'checkout'
  );
  if (checkoutResult.exitCode !== 0) {
    throw new RestoredWorkspaceReconciliationError(
      `Failed to create session branch ${options.branchName} from origin/${options.sourceRef}`
    );
  }
}
