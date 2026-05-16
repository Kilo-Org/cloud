/**
 * Public surface for the wl-sdk ops layer.
 *
 * Each op is a free function returning a `WlResult<T>` envelope.
 * Callers wire a `MutationContext` once (auth + upstream + fork +
 * rig handle) and reuse it across calls.
 */

export type {
  BranchName,
  ForkRef,
  MutationContext,
  MutationOutcome,
  PostOutcome,
  DoneOutcome,
  AcceptOutcome,
  RigHandle,
  WastelandRef,
  WlErrorCode,
  WlResult,
} from './types';
export { WlError } from './types';

export { makeRegisterBranch, makeWlBranch, parseWlBranch, rigBranchPrefix } from './branch';
export type { ParsedBranch } from './branch';

export { browse } from './browse';
export type { BrowseEntry, BrowseFilter, BrowseOptions } from './browse';

export { join } from './join';
export type { JoinOptions, JoinResult } from './join';

export { post } from './post';
export type { PostOptions } from './post';

export { claim } from './claim';
export type { ClaimOptions } from './claim';

export { unclaim } from './unclaim';
export type { UnclaimOptions } from './unclaim';

export { done } from './done';
export type { DoneOptions } from './done';

export { accept } from './accept';
export type { AcceptOptions } from './accept';

export { reject } from './reject';
export type { RejectOptions } from './reject';

export { close } from './close';
export type { CloseOptions } from './close';

export { publish } from './publish';
export type { PublishOptions, PublishResult } from './publish';

export { unpublish } from './unpublish';
export type { UnpublishOptions, UnpublishResult } from './unpublish';

export { listMyBranches, discardBranch } from './workshop';
export type { DiscardBranchOptions, ListMyBranchesOptions, MyBranchEntry } from './workshop';

export { leave } from './leave';
export type { LeaveOptions, LeaveResult } from './leave';
