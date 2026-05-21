/**
 * `WlClient` — top-level entry point for the wl-sdk.
 *
 * The class is a thin facade over the `ops/*` layer. It owns the
 * `MutationContext` (auth + upstream + fork + rig handle + injected
 * `fetch` / `now` / hooks) so callers don't have to thread it through
 * every call themselves.
 *
 * Each method delegates to the matching free function in `ops/*` and
 * unwraps the `WlResult` envelope: on `ok: true` it returns the data;
 * on `ok: false` it throws the contained {@link WlError} so callers
 * can write linear async code with try/catch.
 *
 * The class catches no errors itself — anything thrown by the ops
 * (network/HTTP from `dolthub/*`, validation from `commons/*`,
 * explicit `WlError`s) bubbles up unchanged.
 *
 * `onRequest` and `onError` hooks are passed straight through to the
 * underlying `dolthub/api.doltFetch`, so they fire for every DoltHub
 * call and every non-2xx response respectively.
 */

import {
  type MutationContext,
  type MutationOutcome,
  type PostOutcome,
  type DoneOutcome,
  type AcceptOutcome,
  type WlResult,
  WlError,
} from './ops/types';
import type { DoltFetchHooks, DoltHubAuth } from './dolthub/api';
import { join, type JoinOptions, type JoinResult } from './ops/join';
import { leave, type LeaveResult } from './ops/leave';
import { browse, type BrowseEntry, type BrowseFilter } from './ops/browse';
import { post, type PostOptions } from './ops/post';
import { edit, type EditOptions } from './ops/edit';
import { claim } from './ops/claim';
import { unclaim } from './ops/unclaim';
import { done } from './ops/done';
import { accept, type AcceptOptions } from './ops/accept';
import { acceptUpstream, type AcceptUpstreamOptions } from './ops/accept-upstream';
import { reject, type RejectOptions } from './ops/reject';
import { close } from './ops/close';
import { publish, type PublishOptions } from './ops/publish';
import { unpublish } from './ops/unpublish';
import { listMyBranches, discardBranch, type MyBranchEntry } from './ops/workshop';
import { makeWlBranch } from './ops/branch';
import { listPulls, type Pull, type PullState } from './dolthub/pulls';

/**
 * Configuration for {@link WlClient}.
 *
 * `upstream` is the `owner/db` of the canonical wasteland (e.g.
 * `"hop/wl-commons"`). `forkOrg` is the caller's DoltHub username (or
 * org) that owns the fork — fork DB name is always the same as
 * `upstream` because DoltHub doesn't allow renaming forks.
 *
 * `token` is a DoltHub OAuth or PAT token; it is used both to read
 * upstream (when signed-in reads are needed) and to write to the
 * fork. Tests can pass `fetch` and `now` to make behavior
 * deterministic.
 */
export type WlClientConfig = {
  /** Upstream `owner/db`, e.g. `"hop/wl-commons"`. */
  upstream: string;
  /** Caller's DoltHub username/org that owns the fork. */
  forkOrg: string;
  /** Caller's rig handle within this wasteland. */
  rigHandle: string;
  /** DoltHub OAuth token or PAT. */
  token: string;
  /** Fires before every DoltHub HTTP request. Receives method + URL (no auth). */
  onRequest?: (req: { method: string; url: string }) => void;
  /** Fires on any DoltHub non-2xx response or `WlError` returned from ops. */
  onError?: (err: WlError | { method: string; url: string; status: number; body: unknown }) => void;
  /** Inject a fetch implementation (defaults to `globalThis.fetch`). */
  fetch?: typeof fetch;
  /** Inject a now-source for timestamp-sensitive DML. */
  now?: () => Date;
};

/** Plain inputs accepted by {@link WlClient.post}. */
export type PostInput = Omit<PostOptions, 'ctx'>;

/** Plain inputs accepted by {@link WlClient.edit}. */
export type EditInput = Omit<EditOptions, 'ctx'>;

/**
 * Plain inputs accepted by {@link WlClient.done}.
 *
 * `completionId` is optional — if omitted the client generates one
 * matching the Go reference format (`c-<wantedId>-<rigHandle>-<short hash>`).
 */
export type DoneInput = {
  evidence: string;
  hopUri?: string;
  completionId?: string;
};

/** Plain inputs accepted by {@link WlClient.accept}. */
export type AcceptInput = Omit<AcceptOptions, 'ctx' | 'wantedId'>;

export type AcceptUpstreamClientInput = Omit<AcceptUpstreamOptions, 'ctx' | 'wantedId'>;

/** Plain inputs accepted by {@link WlClient.reject}. */
export type RejectInput = Omit<RejectOptions, 'ctx' | 'wantedId'>;

/** Plain inputs accepted by {@link WlClient.publish}. */
export type PublishInput = Omit<
  PublishOptions,
  'auth' | 'upstream' | 'fork' | 'rigHandle' | 'wantedId' | 'fetch' | 'hooks'
>;

/** Plain inputs accepted by {@link WlClient.join}. */
export type JoinInput = Omit<
  JoinOptions,
  'auth' | 'upstream' | 'dolthubOrg' | 'rigHandle' | 'fetch' | 'hooks'
>;

/** Result of {@link WlClient.publish}. */
export type PublishOutcome = {
  prUrl: string;
  prId: string;
};

function parseUpstreamRef(spec: string): { owner: string; db: string } {
  const slash = spec.indexOf('/');
  if (slash <= 0 || slash === spec.length - 1) {
    throw new WlError(`WlClient: invalid upstream "${spec}" — expected "owner/db"`, 'internal');
  }
  return { owner: spec.slice(0, slash), db: spec.slice(slash + 1) };
}

/**
 * Generate a completion id matching the Go reference format:
 * `c-<wantedId>-<rigHandle>-<short hash>`. The short hash is six
 * lowercase hex characters of randomness — enough entropy to avoid
 * collisions for the same `(wantedId, rigHandle)` pair.
 */
function makeCompletionId(wantedId: string, rigHandle: string): string {
  // Use bare `crypto` (rather than `globalThis.crypto`) so this
  // module typechecks downstream against `lib: ["es2024"]` configs
  // that don't carry the webworker `globalThis` augmentation.
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `c-${wantedId}-${rigHandle}-${hex}`;
}

function unwrap<T>(result: WlResult<T>, onError?: WlClientConfig['onError']): T {
  if (result.ok) return result.data;
  onError?.(result.error);
  throw result.error;
}

export class WlClient {
  readonly #config: WlClientConfig;
  readonly #upstream: { owner: string; db: string };
  readonly #fork: { forkOwner: string; forkDb: string };
  readonly #auth: DoltHubAuth;
  readonly #hooks: DoltFetchHooks;

  constructor(config: WlClientConfig) {
    if (!config.upstream) throw new WlError('WlClient: upstream is required', 'internal');
    if (!config.forkOrg) throw new WlError('WlClient: forkOrg is required', 'internal');
    if (!config.rigHandle) throw new WlError('WlClient: rigHandle is required', 'internal');
    if (!config.token) throw new WlError('WlClient: token is required', 'internal');

    this.#config = config;
    this.#upstream = parseUpstreamRef(config.upstream);
    this.#fork = { forkOwner: config.forkOrg, forkDb: this.#upstream.db };
    this.#auth = { token: config.token };
    this.#hooks = {
      onRequest: config.onRequest,
      onError: info => config.onError?.(info),
    };
  }

  /** The parsed `{ owner, db }` of the upstream wasteland. */
  get upstream(): { owner: string; db: string } {
    return this.#upstream;
  }

  /** The parsed `{ forkOwner, forkDb }` for the caller's fork. */
  get fork(): { forkOwner: string; forkDb: string } {
    return this.#fork;
  }

  /** The configured rig handle. */
  get rigHandle(): string {
    return this.#config.rigHandle;
  }

  #ctx(): MutationContext {
    return {
      auth: this.#auth,
      upstream: this.#upstream,
      fork: this.#fork,
      rigHandle: this.#config.rigHandle,
      fetch: this.#config.fetch,
      now: this.#config.now,
      hooks: this.#hooks,
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  async join(input: JoinInput): Promise<JoinResult> {
    return unwrap(
      await join({
        auth: this.#auth,
        upstream: this.#upstream,
        dolthubOrg: this.#config.forkOrg,
        rigHandle: this.#config.rigHandle,
        displayName: input.displayName,
        ownerEmail: input.ownerEmail,
        version: input.version,
        forkTimeoutMs: input.forkTimeoutMs,
        sleep: input.sleep,
        fetch: this.#config.fetch,
        hooks: this.#hooks,
      }),
      this.#config.onError
    );
  }

  async leave(): Promise<LeaveResult> {
    return unwrap(
      await leave({
        auth: this.#auth,
        fork: this.#fork,
        rigHandle: this.#config.rigHandle,
        fetch: this.#config.fetch,
        hooks: this.#hooks,
      }),
      this.#config.onError
    );
  }

  // ── Reads ──────────────────────────────────────────────────────

  async browse(filter?: BrowseFilter): Promise<BrowseEntry[]> {
    return unwrap(
      await browse({
        auth: this.#auth,
        upstream: this.#upstream,
        fork: this.#fork,
        rigHandle: this.#config.rigHandle,
        filter,
        fetch: this.#config.fetch,
        hooks: this.#hooks,
      }),
      this.#config.onError
    );
  }

  // ── Mutations ──────────────────────────────────────────────────

  async post(input: PostInput): Promise<PostOutcome> {
    return unwrap(await post({ ...input, ctx: this.#ctx() }), this.#config.onError);
  }

  async edit(input: EditInput): Promise<MutationOutcome> {
    return unwrap(await edit({ ...input, ctx: this.#ctx() }), this.#config.onError);
  }

  async claim(wantedId: string): Promise<MutationOutcome> {
    return unwrap(await claim({ ctx: this.#ctx(), wantedId }), this.#config.onError);
  }

  async unclaim(wantedId: string): Promise<MutationOutcome> {
    return unwrap(await unclaim({ ctx: this.#ctx(), wantedId }), this.#config.onError);
  }

  async done(wantedId: string, evidenceOrInput: string | DoneInput): Promise<DoneOutcome> {
    const input: DoneInput =
      typeof evidenceOrInput === 'string' ? { evidence: evidenceOrInput } : evidenceOrInput;
    const completionId = input.completionId ?? makeCompletionId(wantedId, this.#config.rigHandle);
    return unwrap(
      await done({
        ctx: this.#ctx(),
        wantedId,
        evidence: input.evidence,
        hopUri: input.hopUri,
        completionId,
      }),
      this.#config.onError
    );
  }

  async accept(wantedId: string, input: AcceptInput): Promise<AcceptOutcome> {
    return unwrap(await accept({ ...input, ctx: this.#ctx(), wantedId }), this.#config.onError);
  }

  async acceptUpstream(wantedId: string, input: AcceptUpstreamClientInput): Promise<AcceptOutcome> {
    return unwrap(
      await acceptUpstream({ ...input, ctx: this.#ctx(), wantedId }),
      this.#config.onError
    );
  }

  async reject(wantedId: string, input: RejectInput = {}): Promise<MutationOutcome> {
    return unwrap(
      await reject({ ctx: this.#ctx(), wantedId, reason: input.reason }),
      this.#config.onError
    );
  }

  async close(wantedId: string): Promise<MutationOutcome> {
    return unwrap(await close({ ctx: this.#ctx(), wantedId }), this.#config.onError);
  }

  // ── Publishing ─────────────────────────────────────────────────

  async publish(wantedId: string, input: PublishInput = {}): Promise<PublishOutcome> {
    const result = unwrap(
      await publish({
        auth: this.#auth,
        upstream: this.#upstream,
        fork: this.#fork,
        rigHandle: this.#config.rigHandle,
        wantedId,
        title: input.title,
        description: input.description,
        fetch: this.#config.fetch,
        hooks: this.#hooks,
      }),
      this.#config.onError
    );
    return { prUrl: result.prUrl, prId: result.pullId };
  }

  async unpublish(wantedId: string): Promise<void> {
    unwrap(
      await unpublish({
        auth: this.#auth,
        upstream: this.#upstream,
        fork: this.#fork,
        rigHandle: this.#config.rigHandle,
        wantedId,
        fetch: this.#config.fetch,
        hooks: this.#hooks,
      }),
      this.#config.onError
    );
  }

  // ── Workshop introspection ─────────────────────────────────────

  async listMyBranches(opts?: { includeOpenPrs?: boolean }): Promise<MyBranchEntry[]> {
    return unwrap(
      await listMyBranches({
        auth: this.#auth,
        upstream: this.#upstream,
        fork: this.#fork,
        rigHandle: this.#config.rigHandle,
        includeOpenPrs: opts?.includeOpenPrs,
        fetch: this.#config.fetch,
        hooks: this.#hooks,
      }),
      this.#config.onError
    );
  }

  async discardBranch(wantedId: string): Promise<void> {
    unwrap(
      await discardBranch({
        auth: this.#auth,
        upstream: this.#upstream,
        fork: this.#fork,
        branchName: makeWlBranch(this.#config.rigHandle, wantedId),
        fetch: this.#config.fetch,
        hooks: this.#hooks,
      }),
      this.#config.onError
    );
  }

  // ── Maintainer ops (against upstream) ──────────────────────────

  async listPulls(state: PullState = 'open'): Promise<Pull[]> {
    return listPulls({
      auth: this.#auth,
      owner: this.#upstream.owner,
      db: this.#upstream.db,
      state,
      fetch: this.#config.fetch,
      hooks: this.#hooks,
    });
  }
}
