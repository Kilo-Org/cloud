/**
 * Public surface for `@kilocode/wl-sdk`.
 *
 * Most callers want the {@link WlClient} class — it bundles auth +
 * upstream + fork coordinates and exposes one method per op. The
 * lower-level building blocks (free-function ops, DoltHub helpers,
 * SQL escapers, generated DML/schema) are also exported for callers
 * that need to compose custom flows.
 */

// region client
export { WlClient } from './client';
export type {
  WlClientConfig,
  PostInput,
  EditInput,
  DoneInput,
  AcceptInput,
  AcceptUpstreamClientInput,
  RejectInput,
  PublishInput,
  PublishOutcome,
  JoinInput,
} from './client';

/** Pinned to `package.json` `version`. Useful for telemetry. */
export const WL_SDK_VERSION = '0.0.0';
// endregion

// region ops — free-function layer (alternative to WlClient)
export { join } from './ops/join';
export type { JoinOptions, JoinResult } from './ops/join';
export { leave } from './ops/leave';
export type { LeaveOptions, LeaveResult } from './ops/leave';
export { browse } from './ops/browse';
export type { BrowseEntry, BrowseFilter, BrowseOptions } from './ops/browse';
export { post } from './ops/post';
export type { PostOptions } from './ops/post';
export { edit } from './ops/edit';
export type { EditOptions } from './ops/edit';
export { claim } from './ops/claim';
export type { ClaimOptions } from './ops/claim';
export { unclaim } from './ops/unclaim';
export type { UnclaimOptions } from './ops/unclaim';
export { done } from './ops/done';
export type { DoneOptions } from './ops/done';
export { accept } from './ops/accept';
export type { AcceptOptions } from './ops/accept';
export { acceptUpstream } from './ops/accept-upstream';
export type { AcceptUpstreamOptions } from './ops/accept-upstream';
export { reject } from './ops/reject';
export type { RejectOptions } from './ops/reject';
export { close } from './ops/close';
export type { CloseOptions } from './ops/close';
export { publish } from './ops/publish';
export type { PublishOptions, PublishResult } from './ops/publish';
export { unpublish } from './ops/unpublish';
export type { UnpublishOptions, UnpublishResult } from './ops/unpublish';
export { listMyBranches, discardBranch } from './ops/workshop';
export type { ListMyBranchesOptions, DiscardBranchOptions, MyBranchEntry } from './ops/workshop';
export { readBranchHead, assertForkMainCurrent } from './ops/state';

// region ops — types and errors
export { WlError } from './ops/types';
export type {
  AcceptOutcome,
  BranchName,
  DoneOutcome,
  ForkRef,
  MutationContext,
  MutationOutcome,
  PostOutcome,
  RigHandle,
  WastelandRef,
  WlErrorCode,
  WlResult,
} from './ops/types';

// Plan-named aliases — match the public-surface vocabulary used in
// `.plans/wasteland-typescript-sdk-and-three-place-ui.md`. The
// underlying types live under `*Outcome` / `*Entry` names; these
// aliases let the documented surface stay stable if the internals
// rename later.
export type { MutationOutcome as MutationResult } from './ops/types';
export type { MyBranchEntry as MyBranch } from './ops/workshop';
export type { Pull as UpstreamPR } from './dolthub/pulls';
// `BrowseResult` is the array form callers actually receive from
// `WlClient.browse()`. Aliased below using the already-exported
// `BrowseEntry` element type.
import type { BrowseEntry as _BrowseEntry } from './ops/browse';
export type BrowseResult = _BrowseEntry[];

// region ops — branch helpers
export { makeRegisterBranch, makeWlBranch, parseWlBranch, rigBranchPrefix } from './ops/branch';
export type { ParsedBranch } from './ops/branch';
// endregion

// region dolthub — low-level HTTP client
export {
  DOLTHUB_API_BASE,
  DOLTHUB_WEB_BASE,
  WlDoltHubError,
  buildDoltUrl,
  doltFetch,
  expectOk,
} from './dolthub/api';
export type { DoltFetchHooks, DoltFetchOptions, DoltFetchResult, DoltHubAuth } from './dolthub/api';
export { doltRead, shouldRetryAnonymously } from './dolthub/read';
export type { DoltReadOptions, DoltReadResult } from './dolthub/read';
export { doltWrite } from './dolthub/write';
export type { DoltWriteOptions, DoltWriteResult } from './dolthub/write';
export { pollOperation } from './dolthub/operation';
export type { PollOperationOptions, PollOperationResult } from './dolthub/operation';
export { branchExists, createBranch, deleteBranch, listBranches } from './dolthub/branches';
export type {
  Branch,
  BranchExistsOptions,
  CreateBranchOptions,
  DeleteBranchOptions,
  ListBranchesOptions,
} from './dolthub/branches';
export {
  closePull,
  commentOnPull,
  createPull,
  getPull,
  listPulls,
  mergePull,
} from './dolthub/pulls';
export type {
  ClosePullOptions,
  CommentOnPullOptions,
  CreatePullOptions,
  GetPullOptions,
  ListPullsOptions,
  MergePullOptions,
  MergePullResult,
  Pull,
  PullDetail,
  PullState,
} from './dolthub/pulls';
export { createDatabase, forkDatabase } from './dolthub/database';
export type {
  CreateDatabaseOptions,
  CreateDatabaseResult,
  ForkDatabaseOptions,
  ForkDatabaseResult,
} from './dolthub/database';
// endregion

// region commons — SQL escape helpers
export {
  escapeSqlIdentifier,
  escapeSqlLike,
  escapeSqlString,
  sqlStringLiteral,
  sqlStringOrNull,
  sqlValue,
} from './commons/escape';
// endregion

// region commons — generated DML helpers
export {
  acceptCompletionDML,
  acceptUpstreamDML,
  claimWantedDML,
  closeUpstreamDML,
  closeWantedDML,
  deleteWantedDML,
  formatNowUtc,
  formatTagsJson,
  insertWantedDML,
  rejectCompletionDML,
  submitCompletionDML,
  unclaimWantedDML,
  updateWantedDML,
} from './commons/dml.generated';
export type {
  AcceptCompletionInput,
  AcceptUpstreamInput,
  ClaimWantedInput,
  CloseUpstreamInput,
  CloseWantedInput,
  DeleteWantedInput,
  InsertWantedInput,
  RejectCompletionInput,
  StampInput,
  SubmitCompletionInput,
  UnclaimWantedInput,
  UpdateWantedInput,
  WantedUpdateFields,
} from './commons/dml.generated';
// endregion

// region commons — generated row schemas
export {
  BadgesRowSchema,
  BootBlocksRowSchema,
  COMMONS_SCHEMA_STATEMENTS,
  COMMONS_SCHEMA_VERSION,
  ChainMetaRowSchema,
  CompletionsRowSchema,
  MetaRowSchema,
  RigLinksRowSchema,
  RigsRowSchema,
  StampsRowSchema,
  WantedRowSchema,
  badgesTable,
  bootBlocksTable,
  chainMetaTable,
  completionsTable,
  metaTable,
  rigLinksTable,
  rigsTable,
  stampsTable,
  wantedTable,
} from './commons/schema.generated';
export type {
  BadgesRow,
  BootBlocksRow,
  ChainMetaRow,
  CompletionsRow,
  MetaRow,
  RigLinksRow,
  RigsRow,
  StampsRow,
  WantedRow,
} from './commons/schema.generated';
// endregion

// region commons — registration DML
export { buildRegistrationDML } from './commons/registration';
export type { RegistrationInput } from './commons/registration';
// endregion
