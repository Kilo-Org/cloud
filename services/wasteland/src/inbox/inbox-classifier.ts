/**
 * Classifies open upstream pull requests into typed "inbox items" for the
 * admin Review page. Each PR represents one proposed mutation to the
 * wasteland commons database (`wanted`, `completions`, `stamps`, `rigs`).
 *
 * The classifier keys on two signals from the PR:
 *   1. The branch name (`wl/register/<handle>` vs `wl/<handle>/<item-id>`)
 *   2. The first commit's subject line (`wl post: w-abc`, `Register rig: x`, …)
 *
 * For wanted-item PRs we additionally run one small SQL query against the
 * PR's source branch to fetch row-level context (title, claimed_by,
 * evidence URL, etc.) so each card can render submitter-relevant detail
 * without the reviewer needing to click through to DoltHub.
 */

import { z } from 'zod';
import {
  buildPullWebUrl,
  getPull,
  listPulls,
  mapWithLimit,
  parseWlBranch,
  runUnsafeSql,
  DoltHubApiError,
} from '../util/dolthub-api.util';

// ── Commit subject parser ────────────────────────────────────────────────

const WL_VERBS = [
  'post',
  'claim',
  'unclaim',
  'done',
  'update',
  'delete',
  'accept',
  'accept-upstream',
  'reject',
  'close',
  'close-upstream',
] as const;

type WlVerb = (typeof WL_VERBS)[number];

type ParsedCommit =
  | { kind: 'wl'; verb: WlVerb; itemId: string; reason?: string }
  | { kind: 'register'; handle: string }
  | { kind: 'unknown'; subject: string };

/**
 * Parse a commit subject against the closed grammar produced by the `wl` CLI
 * AND by our cloud SDK (which sends DML statements through DoltHub's write
 * API; DoltHub auto-prefixes them with "Run SQL query: " and our SDK appends
 * a `-- wl <verb>: <id>` trailer for traceability).
 *
 * Recognized shapes, in priority order:
 *   - `wl {verb}: {wanted-id}[ — {reason}]`  — bare CLI commit subject
 *   - `Register rig: {handle}`               — `wl join` via federation.go
 *   - `Run SQL query: ... -- wl {verb}: {wanted-id}`
 *                                            — cloud-SDK write via DoltHub
 *
 * Anything else returns `{ kind: 'unknown' }` so the card renders as foreign.
 */
export function parseCommitSubject(subject: string): ParsedCommit {
  const trimmed = subject.trim();

  // Rig registration — produced by `wl join` via federation.go
  const regMatch = trimmed.match(/^Register rig:\s+([a-zA-Z0-9_-]+)\s*$/);
  if (regMatch) {
    return { kind: 'register', handle: regMatch[1] };
  }

  // Bare `wl <verb>: <item-id>[ — <reason>]` — what the local CLI emits.
  const wlMatch = trimmed.match(/^wl\s+([a-z-]+):\s+([a-zA-Z0-9_-]+)(?:\s+—\s+(.*))?$/);
  if (wlMatch) {
    const verb = wlMatch[1];
    if ((WL_VERBS as readonly string[]).includes(verb)) {
      return {
        kind: 'wl',
        verb: verb as WlVerb,
        itemId: wlMatch[2],
        reason: wlMatch[3]?.trim(),
      };
    }
  }

  // SQL-trailer form — what the cloud SDK produces. DoltHub wraps each
  // statement we send with "Run SQL query: <sql>" and our SDK appends
  // ` -- wl <verb>: <id>[ — <reason>]` (see applyMutation in mutate.ts).
  // The trailer can land on any line of the wrapped commit message
  // (single-statement UPDATEs put it on line 1; multi-line INSERTs push
  // it to a later line), so we scan with the `m` flag and a non-anchored
  // pattern that ends at end-of-line or end-of-string.
  const trailerMatch = trimmed.match(
    /--\s+wl\s+([a-z-]+):\s+([a-zA-Z0-9_-]+)(?:\s+—\s+([^\n]*?))?\s*(?:\n|$)/m
  );
  if (trailerMatch) {
    const verb = trailerMatch[1];
    if ((WL_VERBS as readonly string[]).includes(verb)) {
      return {
        kind: 'wl',
        verb: verb as WlVerb,
        itemId: trailerMatch[2],
        reason: trailerMatch[3]?.trim(),
      };
    }
  }

  return { kind: 'unknown', subject: trimmed };
}

// ── Branch-tip SQL enrichment ───────────────────────────────────────────

/**
 * Permissive wanted-item id guard. The `wanted` table declares `id` as
 * `VARCHAR(64)` with no structural check (see `wasteland/schema/commons.sql`)
 * so in practice ids are anything up to 64 characters. The `wl` CLI's
 * `GenerateWantedID` produces `w-<10 hex>` as a convention, but older
 * entries and hand-rolled inserts can be anything, so we can't gate on that
 * shape without silently dropping real rows.
 *
 * The pattern below lets through every character the upstream mysql column
 * will accept in practice (letters, digits, `-`, `_`, `.`, `:`) while
 * blocking anything that could break out of a single-quoted SQL literal —
 * quotes, backslashes, semicolons, whitespace, SQL comment markers, etc.
 * Combined with the 64-char length bound, this is safe to interpolate into
 * `runUnsafeSql`.
 */
const WANTED_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Rig handles are free-form identifiers. Bound the length to stop absurd inputs. */
const RIG_HANDLE_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

const WantedRow = z
  .object({
    id: z.string(),
    title: z.string().default(''),
    description: z.string().nullable().default(null),
    status: z.string().default(''),
    claimed_by: z.string().nullable().default(null),
    posted_by: z.string().nullable().default(null),
    evidence_url: z.string().nullable().default(null),
    type: z.string().nullable().default(null),
    priority: z.union([z.string(), z.number()]).nullable().default(null),
    effort_level: z.union([z.string(), z.number()]).nullable().default(null),
    tags: z.string().nullable().default(null),
  })
  .passthrough();

const CompletionRow = z
  .object({
    id: z.string().default(''),
    wanted_id: z.string().default(''),
    completed_by: z.string().nullable().default(null),
    evidence: z.string().nullable().default(null),
    hop_uri: z.string().nullable().default(null),
    validated_by: z.string().nullable().default(null),
    stamp_id: z.string().nullable().default(null),
  })
  .passthrough();

const StampRow = z
  .object({
    id: z.string().default(''),
    author: z.string().default(''),
    subject: z.string().default(''),
    valence: z.string().nullable().default(null),
    confidence: z.union([z.string(), z.number()]).nullable().default(null),
    severity: z.string().nullable().default(null),
    skill_tags: z.string().nullable().default(null),
    message: z.string().nullable().default(null),
    context_id: z.string().nullable().default(null),
    context_type: z.string().nullable().default(null),
  })
  .passthrough();

const RigRow = z
  .object({
    handle: z.string(),
    display_name: z.string().nullable().default(null),
    dolthub_org: z.string().nullable().default(null),
    owner_email: z.string().nullable().default(null),
    trust_level: z.union([z.string(), z.number()]).nullable().default(null),
    hop_uri: z.string().nullable().default(null),
    gt_version: z.string().nullable().default(null),
  })
  .passthrough();

async function fetchWantedRow(
  upstream: string,
  token: string,
  branch: string,
  itemId: string
): Promise<z.infer<typeof WantedRow> | null> {
  if (!WANTED_ID_PATTERN.test(itemId)) return null;
  try {
    const result = await runUnsafeSql(
      upstream,
      token,
      branch,
      `SELECT id, title, description, status, claimed_by, posted_by, evidence_url, type, priority, effort_level, tags FROM wanted WHERE id = '${itemId}' LIMIT 1`
    );
    const rows = z.array(WantedRow).safeParse(result.rows ?? []);
    return rows.success && rows.data[0] ? rows.data[0] : null;
  } catch {
    return null;
  }
}

async function fetchCompletionRow(
  upstream: string,
  token: string,
  branch: string,
  itemId: string
): Promise<z.infer<typeof CompletionRow> | null> {
  if (!WANTED_ID_PATTERN.test(itemId)) return null;
  try {
    const result = await runUnsafeSql(
      upstream,
      token,
      branch,
      `SELECT id, wanted_id, completed_by, evidence, hop_uri, validated_by, stamp_id FROM completions WHERE wanted_id = '${itemId}' ORDER BY completed_at DESC LIMIT 1`
    );
    const rows = z.array(CompletionRow).safeParse(result.rows ?? []);
    return rows.success && rows.data[0] ? rows.data[0] : null;
  } catch {
    return null;
  }
}

async function fetchStampRow(
  upstream: string,
  token: string,
  branch: string,
  itemId: string
): Promise<z.infer<typeof StampRow> | null> {
  if (!WANTED_ID_PATTERN.test(itemId)) return null;
  try {
    const result = await runUnsafeSql(
      upstream,
      token,
      branch,
      `SELECT s.id, s.author, s.subject, s.valence, s.confidence, s.severity, s.skill_tags, s.message, s.context_id, s.context_type FROM stamps s JOIN completions c ON s.context_id = c.id WHERE c.wanted_id = '${itemId}' ORDER BY s.id DESC LIMIT 1`
    );
    const rows = z.array(StampRow).safeParse(result.rows ?? []);
    return rows.success && rows.data[0] ? rows.data[0] : null;
  } catch {
    return null;
  }
}

async function fetchRigRow(
  upstream: string,
  token: string,
  branch: string,
  handle: string
): Promise<z.infer<typeof RigRow> | null> {
  if (!RIG_HANDLE_PATTERN.test(handle)) return null;
  try {
    const result = await runUnsafeSql(
      upstream,
      token,
      branch,
      `SELECT handle, display_name, dolthub_org, owner_email, trust_level, hop_uri, gt_version FROM rigs WHERE handle = '${handle}' LIMIT 1`
    );
    const rows = z.array(RigRow).safeParse(result.rows ?? []);
    return rows.success && rows.data[0] ? rows.data[0] : null;
  } catch {
    return null;
  }
}

// ── InboxItem discriminated union ───────────────────────────────────────

type InboxCardBase = {
  pull_id: string;
  title: string;
  state: string;
  from_branch: string | null;
  submitter: string | null;
  /**
   * DoltHub owner of the fork that hosts `from_branch`. For same-owner
   * PRs (admin pushing on the upstream itself) this matches
   * `ctx.upstream`'s owner; for cross-fork PRs (the common case for
   * worker submissions) this is the contributor's fork. Used by admin
   * accept flows to read the submitter's `wl/<rig>/<id>` branch from
   * the correct fork.
   */
  fork_owner: string | null;
  creator_name: string | null;
  created_at: string | null;
  updated_at: string | null;
  /** Web URL of the upstream PR on DoltHub. Always set. */
  dolthub_url: string;
};

export type InboxItem = InboxCardBase &
  (
    | {
        kind: 'rig-registration';
        handle: string;
        display_name: string | null;
        dolthub_org: string | null;
        owner_email: string | null;
        hop_uri: string | null;
        gt_version: string | null;
      }
    | {
        kind: 'wanted-post';
        item_id: string;
        item_title: string;
        description: string | null;
        type: string | null;
        priority: string | null;
        effort_level: string | null;
        tags: string | null;
        posted_by: string | null;
      }
    | {
        kind: 'wanted-edit';
        subkind: 'update' | 'delete' | 'unclaim';
        item_id: string;
        item_title: string;
        submitter_is_poster: boolean | null;
        posted_by: string | null;
        status_transition: string | null;
      }
    | {
        kind: 'work-submission';
        item_id: string;
        item_title: string;
        claimer: string;
        has_done: boolean;
        evidence_url: string | null;
        completion_id: string | null;
      }
    | {
        kind: 'admin-action';
        subkind: 'accept' | 'accept-upstream' | 'reject' | 'close' | 'close-upstream';
        item_id: string;
        item_title: string;
        worker: string | null;
        acceptor: string | null;
        reject_reason: string | null;
        stamp: {
          quality: string | null;
          severity: string | null;
          skill_tags: string | null;
          message: string | null;
        } | null;
      }
    | {
        kind: 'unknown';
        commit_subjects: string[];
      }
  );

// ── Per-PR classifier ───────────────────────────────────────────────────

type ClassifyContext = {
  upstream: string;
  token: string;
};

type PullSummary = {
  pull_id: string;
  title: string;
  state: string;
  creator_name: string | null;
  created_at: string | null;
  updated_at: string | null;
};

async function classifyOne(ctx: ClassifyContext, pull: PullSummary): Promise<InboxItem> {
  // Fetch detail first — it tells us the branch AND the fork repo that
  // hosts the branch. Branch-tip queries must run against the fork
  // (where the branch actually exists); the canonical wl CLI creates
  // branches on origin/fork, not upstream, so querying upstream for
  // `wl/<rig>/<id>` returns nothing.
  const detail = await safeGetPull(ctx, pull.pull_id);
  const fromBranch = detail?.from_branch_name ?? null;
  const forkUpstream = forkRepoFromDetail(detail, ctx.upstream);
  const commits = await safeGetCommits(forkUpstream, ctx.token, fromBranch);

  // A commit's `message` field includes subject + body separated by blank
  // lines. We keep both the subject (first line, used for verb parsing)
  // and the full message (used to extract reject reasons from the body).
  //
  // The cloud SDK's `applyMutation` appends a `-- wl <verb>: <id>` trailer
  // to every DML it sends via DoltHub's write API. DoltHub wraps the SQL
  // with "Run SQL query: " and the trailer ends up on the same line as the
  // closing semicolon — usually the subject for single-statement UPDATEs,
  // but `wl post` produces a multi-line INSERT so the trailer lands on a
  // later line. Pass the full message into `parseCommitSubject` so its
  // trailer regex can find the marker regardless of which line it's on.
  const commitFull = commits.length > 0 ? commits.map(c => c.message) : [pull.title];
  const commitSubjects = commitFull.map(m => m.split('\n')[0]);
  const parsedCommits = commitFull.map(parseCommitSubject);

  const base: InboxCardBase = {
    pull_id: pull.pull_id,
    title: pull.title,
    state: pull.state,
    from_branch: fromBranch,
    submitter: parseWlBranch(fromBranch)?.rigHandle ?? null,
    fork_owner: detail?.from_branch_owner_name ?? null,
    creator_name: pull.creator_name,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    dolthub_url: buildPullWebUrl(ctx.upstream, pull.pull_id),
  };

  // Rig registration — branch `wl/register/<handle>` OR first commit matches
  if (fromBranch?.startsWith('wl/register/') || parsedCommits[0]?.kind === 'register') {
    const handle =
      parsedCommits[0]?.kind === 'register'
        ? parsedCommits[0].handle
        : (fromBranch?.split('/')[2] ?? 'unknown');
    const rig = fromBranch ? await fetchRigRow(forkUpstream, ctx.token, fromBranch, handle) : null;
    return {
      ...base,
      kind: 'rig-registration',
      handle,
      display_name: rig?.display_name ?? null,
      dolthub_org: rig?.dolthub_org ?? null,
      owner_email: rig?.owner_email ?? null,
      hop_uri: rig?.hop_uri ?? null,
      gt_version: rig?.gt_version ?? null,
    };
  }

  // Wanted-item PRs: walk the parsed commit list. The branch naming
  // convention pins the item id even when the commit log is empty.
  const branchInfo = parseWlBranch(fromBranch);
  const itemId = branchInfo?.itemId ?? parsedCommits.find(c => c.kind === 'wl')?.itemId ?? null;

  if (!itemId) {
    return {
      ...base,
      kind: 'unknown',
      commit_subjects: commitSubjects,
    };
  }

  // Fetch item context on the branch tip (fork side) and on main
  // (upstream) in parallel.
  const [branchRow, mainRow] = await Promise.all([
    fromBranch
      ? fetchWantedRow(forkUpstream, ctx.token, fromBranch, itemId)
      : Promise.resolve(null),
    fetchWantedRow(ctx.upstream, ctx.token, 'main', itemId),
  ]);
  const displayRow = branchRow ?? mainRow;
  const itemTitle = displayRow?.title ?? `(unknown item ${itemId})`;

  // Collect verbs from commit subjects (when available) AND infer from
  // branch-tip row state (when commits aren't). `wl claim` sets
  // status='claimed' and `claimed_by`; `wl done` sets status='in_review'
  // and inserts a completion row. These state signals let us classify
  // reliably even when dolt_log fails or isn't supported.
  const wlCommits = parsedCommits.flatMap(c => (c.kind === 'wl' ? [c] : []));
  const inferredVerbs = inferVerbsFromRows(mainRow, branchRow);
  // Precedence order picks the "most significant" verb in a multi-commit
  // PR. Claim+done → work-submission. Accept/reject/close → admin-action.
  // A standalone post/update/delete/unclaim → wanted-post / wanted-edit.
  const verbs = new Set<WlVerb>([...wlCommits.map(c => c.verb), ...inferredVerbs]);

  // Resolve the worker (stamp subject / rejected contributor) once for any
  // admin action. `completions.completed_by` is the source of truth — it
  // survives accept/reject/close transitions where `wanted.claimed_by` may
  // be null or reset. Fall back to `claimed_by` only if no completion row
  // is present (shouldn't happen post-done, but tolerated).
  const completionForWorker =
    verbs.has('accept') ||
    verbs.has('accept-upstream') ||
    verbs.has('reject') ||
    verbs.has('close') ||
    verbs.has('close-upstream')
      ? await fetchCompletionRow(ctx.upstream, ctx.token, 'main', itemId)
      : null;
  const workerHandle = completionForWorker?.completed_by ?? displayRow?.claimed_by ?? null;

  if (verbs.has('accept') || verbs.has('accept-upstream')) {
    const subkind = verbs.has('accept-upstream') ? 'accept-upstream' : 'accept';
    const stamp = fromBranch
      ? await fetchStampRow(forkUpstream, ctx.token, fromBranch, itemId)
      : null;
    return {
      ...base,
      kind: 'admin-action',
      subkind,
      item_id: itemId,
      item_title: itemTitle,
      worker: workerHandle,
      acceptor: base.submitter,
      reject_reason: null,
      stamp: stamp
        ? {
            quality: extractValenceField(stamp.valence, 'quality'),
            severity: stamp.severity,
            skill_tags: stamp.skill_tags,
            message: stamp.message,
          }
        : null,
    };
  }

  if (verbs.has('reject')) {
    const rejectCommit = wlCommits.find(c => c.verb === 'reject');
    // `wl reject` produces subjects like `wl reject: <id> — <reason>`
    // (see wasteland/internal/sdk/mutations.go:327-333). The em-dash
    // parser above extracts `reason` from that subject. Fall back to
    // the full commit body in case a future `wl` version moves the
    // reason there.
    const fullRejectMessage = findRejectBody(commitFull);
    return {
      ...base,
      kind: 'admin-action',
      subkind: 'reject',
      item_id: itemId,
      item_title: itemTitle,
      worker: workerHandle,
      acceptor: base.submitter,
      reject_reason: rejectCommit?.reason ?? fullRejectMessage,
      stamp: null,
    };
  }

  if (verbs.has('close') || verbs.has('close-upstream')) {
    const subkind = verbs.has('close-upstream') ? 'close-upstream' : 'close';
    return {
      ...base,
      kind: 'admin-action',
      subkind,
      item_id: itemId,
      item_title: itemTitle,
      worker: workerHandle,
      acceptor: base.submitter,
      reject_reason: null,
      stamp: null,
    };
  }

  if (verbs.has('claim') || verbs.has('done')) {
    const completion = fromBranch
      ? await fetchCompletionRow(forkUpstream, ctx.token, fromBranch, itemId)
      : null;
    return {
      ...base,
      kind: 'work-submission',
      item_id: itemId,
      item_title: itemTitle,
      claimer: branchInfo?.rigHandle ?? branchRow?.claimed_by ?? 'unknown',
      has_done: verbs.has('done'),
      evidence_url: branchRow?.evidence_url ?? completion?.evidence ?? null,
      completion_id: completion?.id ?? null,
    };
  }

  if (verbs.has('post')) {
    return {
      ...base,
      kind: 'wanted-post',
      item_id: itemId,
      item_title: itemTitle,
      description: branchRow?.description ?? null,
      type: branchRow?.type ?? null,
      priority: branchRow?.priority != null ? String(branchRow.priority) : null,
      effort_level: branchRow?.effort_level != null ? String(branchRow.effort_level) : null,
      tags: branchRow?.tags ?? null,
      posted_by: branchRow?.posted_by ?? null,
    };
  }

  if (verbs.has('update') || verbs.has('delete') || verbs.has('unclaim')) {
    const subkind = verbs.has('delete') ? 'delete' : verbs.has('unclaim') ? 'unclaim' : 'update';
    const statusTransition =
      subkind === 'delete'
        ? `${mainRow?.status ?? '?'} → withdrawn`
        : subkind === 'unclaim'
          ? `${mainRow?.status ?? '?'} → open`
          : null;
    return {
      ...base,
      kind: 'wanted-edit',
      subkind,
      item_id: itemId,
      item_title: itemTitle,
      submitter_is_poster:
        mainRow?.posted_by && base.submitter ? mainRow.posted_by === base.submitter : null,
      posted_by: mainRow?.posted_by ?? null,
      status_transition: statusTransition,
    };
  }

  // Fell through — branch name parsed but commit verbs didn't match.
  return {
    ...base,
    kind: 'unknown',
    commit_subjects: commitSubjects,
  };
}

// ── Public entrypoint ───────────────────────────────────────────────────

export async function listInboxItems(upstream: string, token: string): Promise<InboxItem[]> {
  const pulls = await listPulls(upstream, token, { state: 'Open' });
  const summaries: PullSummary[] = pulls.map(p => ({
    pull_id: p.pull_id,
    title: p.title,
    state: p.state,
    creator_name: p.creator_name,
    created_at: p.created_at,
    updated_at: p.updated_at,
  }));
  return mapWithLimit(summaries, 4, summary => classifyOne({ upstream, token }, summary));
}

// ── Helpers ─────────────────────────────────────────────────────────────

const CommitLogRow = z
  .object({
    commit_hash: z.string().default(''),
    message: z.string().default(''),
    committer: z.string().nullable().default(null),
    date: z.string().nullable().default(null),
  })
  .passthrough();

async function safeGetPull(ctx: ClassifyContext, pullId: string) {
  try {
    return await getPull(ctx.upstream, ctx.token, pullId);
  } catch (err) {
    if (err instanceof DoltHubApiError) return null;
    throw err;
  }
}

/**
 * Return the `<owner>/<db>` string for the repo that hosts the PR's
 * source branch. For same-owner PRs (admin on their own wasteland) this
 * is the same as the upstream. For cross-fork PRs it's the contributor's
 * fork. Falls back to the upstream when the detail endpoint doesn't
 * expose fork info (treat as same-repo PR).
 */
function forkRepoFromDetail(
  detail: { from_branch_owner_name: string | null; from_branch_repo_name: string | null } | null,
  upstream: string
): string {
  const owner = detail?.from_branch_owner_name;
  const db = detail?.from_branch_repo_name;
  if (owner && db) return `${owner}/${db}`;
  return upstream;
}

/**
 * Infer wl verbs from branch-tip state when the commit log isn't
 * available (dolt_log unsupported, repo not yet indexed, branch deleted,
 * etc.). Not perfect — a PR that has BOTH claim and done stacked on one
 * branch looks the same to row-state inspection as done alone — but
 * catches the common case where commit parsing yields nothing.
 *
 * Signals:
 *   - branch row status == 'claimed' → `claim` (worker hasn't submitted done yet)
 *   - branch row status == 'in_review' → `claim` + `done` (done implies claim)
 *   - branch row status == 'open' + main is claimed → `unclaim`
 *   - branch row status == 'completed' (admin-authored PR) → `accept` or `close`
 *   - branch row exists but main doesn't → `post`
 *   - branch row status == 'withdrawn' → `delete`
 */
function inferVerbsFromRows(
  mainRow: z.infer<typeof WantedRow> | null,
  branchRow: z.infer<typeof WantedRow> | null
): WlVerb[] {
  if (!branchRow) return [];
  const branchStatus = branchRow.status;
  if (!mainRow) {
    // Row exists on the branch but not on main → fresh post.
    return ['post'];
  }
  const mainStatus = mainRow.status;

  switch (branchStatus) {
    case 'claimed':
      // claim (pre-done)
      return ['claim'];
    case 'in_review':
      // claim + done stacked. Both verbs so work-submission renders as "has_done".
      return ['claim', 'done'];
    case 'open':
      // Branch moves status back to open — typically `wl unclaim`.
      if (mainStatus === 'claimed' || mainStatus === 'in_review') {
        return ['unclaim'];
      }
      return [];
    case 'completed':
      // Someone transitioned in_review → completed. Could be accept or close;
      // we'll refine once we know whether a stamp was inserted. Default to
      // accept since that's the more common path; the admin-action branch
      // already upgrades to close if no stamp is present.
      return ['accept'];
    case 'withdrawn':
      return ['delete'];
    default:
      return [];
  }
}

// Branch names that dolthub's wl toolchain produces are restricted to
// `wl/(register/<handle>|<handle>/<item-id>)`. Validate here so we can
// safely interpolate into the `dolt_log('main..<branch>')` SQL below.
// The char class allows everything `wl` actually uses (alphanumerics,
// `-`, `_`, `/`) plus `.` for tags/refs; anything else bails out.
const SAFE_BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

async function safeGetCommits(
  upstream: string,
  token: string,
  branch: string | null
): Promise<Array<z.infer<typeof CommitLogRow>>> {
  // DoltHub has no GET /pulls/:id/commits endpoint; we use dolt_log on the
  // PR's source branch. The query MUST run against the repo that hosts
  // the branch (the fork, when the PR is cross-repo). Failures are
  // tolerated — commit enrichment is best-effort; the classifier falls
  // back to state-based inference (`inferVerbsFromRows`) when empty.
  if (!branch || !SAFE_BRANCH_RE.test(branch)) return [];
  try {
    const result = await runUnsafeSql(
      upstream,
      token,
      branch,
      // `dolt_log('main..<branch>')` returns commits on the branch that
      // aren't on main — exactly the PR-specific commits. `branch` is
      // pre-validated by SAFE_BRANCH_RE so string interpolation is safe.
      `SELECT commit_hash, message, committer, date FROM dolt_log('main..${branch}') ORDER BY date ASC`
    );
    const rows = z.array(CommitLogRow).safeParse(result.rows ?? []);
    return rows.success ? rows.data : [];
  } catch {
    return [];
  }
}

/**
 * Find the reason text for a reject commit, preferring the subject
 * (extracted by the em-dash parser) and falling back to the commit body
 * in case the CLI ever moves it there. Returns null if no reject commit
 * is present.
 */
function findRejectBody(commitFull: readonly string[]): string | null {
  for (const message of commitFull) {
    const [subject, ...rest] = message.split('\n');
    const parsed = parseCommitSubject(subject);
    if (parsed.kind === 'wl' && parsed.verb === 'reject') {
      const body = rest.join('\n').trim();
      return body.length > 0 ? body : null;
    }
  }
  return null;
}

/**
 * `stamps.valence` is a JSON string like `{"quality":"good","reliability":"good"}`.
 * Pull out a single field without bringing in a full JSON parser for one value.
 */
function extractValenceField(valence: string | null, field: string): string | null {
  if (!valence) return null;
  try {
    const parsed: unknown = JSON.parse(valence);
    if (parsed && typeof parsed === 'object' && field in parsed) {
      const value = (parsed as Record<string, unknown>)[field];
      return typeof value === 'string' ? value : null;
    }
  } catch {
    // ignore
  }
  return null;
}
