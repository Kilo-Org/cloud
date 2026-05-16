/**
 * Public DoltHub client surface for `@kilocode/wl-sdk`. Each module
 * is independently importable; this barrel re-exports the most
 * common types and functions for convenience.
 */

export {
  DOLTHUB_API_BASE,
  DOLTHUB_WEB_BASE,
  WlDoltHubError,
  buildDoltUrl,
  doltFetch,
  expectOk,
} from './api';
export type { DoltHubAuth, DoltFetchHooks, DoltFetchOptions, DoltFetchResult } from './api';

export { doltRead, shouldRetryAnonymously } from './read';
export type { DoltReadOptions, DoltReadResult } from './read';

export { doltWrite } from './write';
export type { DoltWriteOptions, DoltWriteResult } from './write';

export { pollOperation } from './operation';
export type { PollOperationOptions, PollOperationResult } from './operation';

export { listBranches, branchExists, deleteBranch, createBranch } from './branches';
export type {
  Branch,
  ListBranchesOptions,
  BranchExistsOptions,
  DeleteBranchOptions,
  CreateBranchOptions,
} from './branches';

export { listPulls, getPull, createPull, closePull, mergePull, commentOnPull } from './pulls';
export type {
  Pull,
  PullDetail,
  PullState,
  ListPullsOptions,
  GetPullOptions,
  CreatePullOptions,
  ClosePullOptions,
  MergePullOptions,
  CommentOnPullOptions,
  MergePullResult,
} from './pulls';

export { createDatabase, forkDatabase } from './database';
export type {
  CreateDatabaseOptions,
  CreateDatabaseResult,
  ForkDatabaseOptions,
  ForkDatabaseResult,
} from './database';
