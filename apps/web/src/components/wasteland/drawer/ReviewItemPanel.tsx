'use client';

import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  GitMerge,
  Hand,
  HelpCircle,
  Loader2,
  MessageSquare,
  Pencil,
  ScrollText,
  ShieldCheck,
  Star,
  UserPlus,
  XCircle,
} from 'lucide-react';
import type { DrawerStackHelpers } from '@/components/drawer';
import { MarkdownProse } from '@/components/security-agent/MarkdownProse';
import type { AcceptFormInput, InboxItem, ReviewPanelActions, WastelandDrawerRef } from './types';
import { RigLink, WantedItemLink } from './CrossRefs';

type InboxKind = InboxItem['kind'];

type PanelProps = {
  wastelandId: string;
  item: InboxItem;
  /** `null` means the panel was pushed as a cross-reference — render read-only. */
  actions: ReviewPanelActions | null;
  push: DrawerStackHelpers<WastelandDrawerRef>['push'];
};

/** Header slot for a review-item drawer. Rendered by the primitive's
 *  header row, inline with the back/close buttons. */
export function reviewItemHeader(item: InboxItem) {
  const Icon = iconFor(item.kind);
  return (
    <>
      <Icon className="size-4 shrink-0 text-white/60" />
      <h3 className="truncate text-sm font-semibold text-white/90">{cardHeading(item)}</h3>
      <Badge
        variant="outline"
        className="shrink-0 border-white/[0.08] font-mono text-[10px] text-white/50"
      >
        #{item.pull_id}
      </Badge>
    </>
  );
}

export function ReviewItemPanel({ wastelandId, item, actions, push }: PanelProps) {
  return (
    <div className="space-y-4 p-4">
      <CardBody item={item} wastelandId={wastelandId} push={push} />

      <div className="space-y-1.5 border-t border-white/[0.06] pt-3">
        {item.from_branch && <DetailRow label="Branch" value={item.from_branch} mono />}
        {item.submitter && (
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="shrink-0 text-white/30">Submitter</span>
            <RigLink handle={item.submitter} wastelandId={wastelandId} push={push} />
          </div>
        )}
        {item.creator_name && <DetailRow label="Creator" value={item.creator_name} />}
        <DetailRow label="Created" value={formatTimestamp(item.created_at)} />
        <DetailRow label="Updated" value={formatTimestamp(item.updated_at)} />
      </div>

      {actions && <ActionRegion item={item} actions={actions} />}
    </div>
  );
}

/**
 * Renders the right action surface for the inbox row's `kind`. For
 * work-submissions we surface the inline AcceptForm (the canonical
 * `wl accept-upstream` workflow — stamp + adoption commit + merge +
 * close worker's PR) as the primary action. For everything else we
 * surface the legacy Merge/Close/Comment trio.
 */
function ActionRegion({ item, actions }: { item: InboxItem; actions: ReviewPanelActions }) {
  if (item.kind === 'work-submission') {
    return (
      <div className="space-y-3 border-t border-white/[0.06] pt-3">
        <AcceptForm item={item} actions={actions} />
        <SecondaryActions item={item} actions={actions} variant="work-submission" />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 border-t border-white/[0.06] pt-3">
      <button
        type="button"
        onClick={() => actions.onMerge(item)}
        disabled={actions.busy}
        className="inline-flex items-center justify-center gap-1.5 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-400 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
      >
        <GitMerge className="size-3.5" />
        Merge PR
      </button>
      <SecondaryActions item={item} actions={actions} variant="default" />
    </div>
  );
}

/**
 * Inline accept form for a work-submission inbox row. Mirrors the
 * canonical `wl accept-upstream` flag set 1:1: quality, reliability,
 * severity, skill tags, message. Calls `actions.onAccept` which the
 * hosting page wires to the `acceptWantedItem` mutation.
 */
function AcceptForm({
  item,
  actions,
}: {
  item: Extract<InboxItem, { kind: 'work-submission' }>;
  actions: ReviewPanelActions;
}) {
  const [quality, setQuality] = useState<AcceptFormInput['quality']>('good');
  const [reliability, setReliability] = useState<AcceptFormInput['reliability']>('good');
  const [severity, setSeverity] = useState<AcceptFormInput['severity']>('leaf');
  const [skillTags, setSkillTags] = useState('');
  const [message, setMessage] = useState('');

  // The accept flow needs the worker's evidence to be present — without
  // it the server's `acceptUpstream` will fail with PRECONDITION_FAILED
  // (no completion / no evidence). Surface this in the form so the
  // admin sees why Accept is disabled before they fill in the form.
  const canAccept = Boolean(item.has_done && item.evidence_url);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canAccept) return;
    const tags = skillTags
      .split(',')
      .map(t => t.trim())
      .filter(Boolean);
    actions.onAccept(item, {
      quality,
      reliability,
      severity,
      skillTags: tags.length > 0 ? tags : undefined,
      message: message.trim() || undefined,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="flex items-center gap-1.5">
        <ShieldCheck className="size-3.5 text-emerald-400/80" />
        <p className="text-[10px] font-semibold tracking-[0.08em] text-emerald-300/80 uppercase">
          Accept &amp; stamp
        </p>
      </div>
      <p className="text-[11px] leading-relaxed text-white/45">
        Issue a reputation stamp, write the adoption commit on your branch, merge it to{' '}
        <span className="font-mono text-white/65">main</span>, and close the worker&apos;s PR — in
        one step.
      </p>

      <div>
        <label
          htmlFor={`accept-quality-${item.pull_id}`}
          className="mb-1.5 block text-xs font-medium text-white/60"
        >
          Quality
        </label>
        <select
          id={`accept-quality-${item.pull_id}`}
          value={quality}
          onChange={e => setQuality(e.target.value as typeof quality)}
          disabled={!canAccept || actions.busy}
          className="w-full rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm text-white/80 outline-none focus:border-white/20 disabled:opacity-50"
        >
          <option value="excellent">Excellent</option>
          <option value="good">Good</option>
          <option value="fair">Fair</option>
          <option value="poor">Poor</option>
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label
            htmlFor={`accept-reliability-${item.pull_id}`}
            className="mb-1.5 block text-xs font-medium text-white/60"
          >
            Reliability
          </label>
          <select
            id={`accept-reliability-${item.pull_id}`}
            value={reliability}
            onChange={e => setReliability(e.target.value as typeof reliability)}
            disabled={!canAccept || actions.busy}
            className="w-full rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm text-white/80 outline-none focus:border-white/20 disabled:opacity-50"
          >
            <option value="excellent">Excellent</option>
            <option value="good">Good</option>
            <option value="fair">Fair</option>
            <option value="poor">Poor</option>
          </select>
        </div>
        <div>
          <label
            htmlFor={`accept-severity-${item.pull_id}`}
            className="mb-1.5 block text-xs font-medium text-white/60"
          >
            Severity
          </label>
          <select
            id={`accept-severity-${item.pull_id}`}
            value={severity}
            onChange={e => setSeverity(e.target.value as typeof severity)}
            disabled={!canAccept || actions.busy}
            className="w-full rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm text-white/80 outline-none focus:border-white/20 disabled:opacity-50"
          >
            <option value="leaf">Leaf</option>
            <option value="branch">Branch</option>
            <option value="root">Root</option>
          </select>
        </div>
      </div>

      <div>
        <label
          htmlFor={`accept-skills-${item.pull_id}`}
          className="mb-1.5 block text-xs font-medium text-white/60"
        >
          Skill tags <span className="font-normal text-white/30">(optional, comma-separated)</span>
        </label>
        <input
          id={`accept-skills-${item.pull_id}`}
          value={skillTags}
          onChange={e => setSkillTags(e.target.value)}
          placeholder="go, federation"
          disabled={!canAccept || actions.busy}
          className="w-full rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm text-white/80 outline-none placeholder:text-white/25 focus:border-white/20 disabled:opacity-50"
        />
      </div>

      <div>
        <label
          htmlFor={`accept-message-${item.pull_id}`}
          className="mb-1.5 block text-xs font-medium text-white/60"
        >
          Stamp message <span className="font-normal text-white/30">(optional)</span>
        </label>
        <textarea
          id={`accept-message-${item.pull_id}`}
          rows={3}
          value={message}
          onChange={e => setMessage(e.target.value)}
          placeholder="Leave a note on the stamp…"
          disabled={!canAccept || actions.busy}
          className="w-full resize-none rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-sm text-white/80 outline-none placeholder:text-white/25 focus:border-white/20 disabled:opacity-50"
        />
      </div>

      <button
        type="submit"
        disabled={!canAccept || actions.busy}
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
      >
        {actions.busy ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <CheckCircle2 className="size-3.5" />
        )}
        Accept &amp; merge
      </button>

      {!canAccept && (
        <ScrutinyHint
          tone="amber"
          text={
            item.has_done
              ? "This PR doesn't have an evidence URL — the worker's `wl done` either didn't land cleanly or this isn't a completed submission. Use Comment to ask the contributor to retry, or Close to dismiss."
              : "This is a claim-only PR — the worker hasn't submitted evidence yet. Wait for the `wl done` PR before accepting."
          }
        />
      )}
    </form>
  );
}

/**
 * The non-primary actions (Close / Comment / Open on DoltHub). Shared
 * between the work-submission and default action regions; rendered as
 * a quieter row below whichever primary action the kind expects.
 */
function SecondaryActions({
  item,
  actions,
  variant,
}: {
  item: InboxItem;
  actions: ReviewPanelActions;
  variant: 'work-submission' | 'default';
}) {
  const closeLabel = variant === 'work-submission' ? 'Reject (close PR)' : 'Close (no merge)';
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => actions.onCloseAction(item)}
        disabled={actions.busy}
        className="inline-flex items-center justify-center gap-1.5 rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/20 disabled:opacity-50"
      >
        <XCircle className="size-3.5" />
        {closeLabel}
      </button>
      <button
        type="button"
        onClick={() => actions.onComment(item)}
        className="inline-flex items-center justify-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-xs font-medium text-white/60 transition-colors hover:bg-white/[0.06]"
      >
        <MessageSquare className="size-3.5" />
        Comment on PR
      </button>
      {actions.upstream && (
        <a
          href={`https://www.dolthub.com/repositories/${actions.upstream}/pulls/${item.pull_id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-xs font-medium text-white/60 transition-colors hover:bg-white/[0.06]"
        >
          <ExternalLink className="size-3.5" />
          Open on DoltHub
        </a>
      )}
    </div>
  );
}

// ── Per-kind body ────────────────────────────────────────────────────────

type BodyProps = Pick<PanelProps, 'wastelandId' | 'push'>;

function CardBody({ item, wastelandId, push }: { item: InboxItem } & BodyProps) {
  switch (item.kind) {
    case 'rig-registration':
      return <RigRegistrationBody item={item} wastelandId={wastelandId} push={push} />;
    case 'wanted-post':
      return <WantedPostBody item={item} wastelandId={wastelandId} push={push} />;
    case 'wanted-edit':
      return <WantedEditBody item={item} wastelandId={wastelandId} push={push} />;
    case 'work-submission':
      return <WorkSubmissionBody item={item} wastelandId={wastelandId} push={push} />;
    case 'admin-action':
      return <AdminActionBody item={item} wastelandId={wastelandId} push={push} />;
    case 'unknown':
      return <UnknownBody item={item} />;
  }
}

function RigRegistrationBody({
  item,
  wastelandId,
  push,
}: { item: Extract<InboxItem, { kind: 'rig-registration' }> } & BodyProps) {
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => push({ type: 'rig', wastelandId, handle: item.handle })}
        className="group/link flex w-full items-center gap-3 rounded-md border border-white/[0.04] bg-white/[0.02] px-3 py-2 text-left transition-colors hover:bg-white/[0.04]"
      >
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 ring-1 ring-emerald-500/20">
          <UserPlus className="size-4 text-emerald-400" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-sm text-white/85">{item.handle}</p>
          {item.display_name && <p className="text-xs text-white/50">{item.display_name}</p>}
        </div>
        <span className="text-[10px] text-white/30 group-hover/link:text-white/60">View rig →</span>
      </button>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-[11px]">
        {item.owner_email && (
          <MetaRow label="Owner">
            <span className="font-mono">{item.owner_email}</span>
          </MetaRow>
        )}
        {item.dolthub_org && (
          <MetaRow label="DoltHub org">
            <span className="font-mono">{item.dolthub_org}</span>
          </MetaRow>
        )}
        {item.hop_uri && (
          <MetaRow label="Hop URI">
            <span className="font-mono break-all">{item.hop_uri}</span>
          </MetaRow>
        )}
        {item.gt_version && (
          <MetaRow label="wl version">
            <span className="font-mono">{item.gt_version}</span>
          </MetaRow>
        )}
      </dl>
      <ScrutinyHint text="Verify the handle matches the DoltHub org (spam/sybil risk). New rigs land with trust_level=1." />
    </div>
  );
}

function WantedPostBody({
  item,
  wastelandId,
  push,
}: { item: Extract<InboxItem, { kind: 'wanted-post' }> } & BodyProps) {
  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-medium text-white/85">{item.item_title}</p>
        <div className="mt-0.5">
          <WantedItemLink
            itemId={item.item_id}
            wastelandId={wastelandId}
            push={push}
            variant="mono"
          />
        </div>
      </div>
      {item.description && (
        <div className="max-h-40 overflow-y-auto rounded-md border border-white/[0.04] bg-white/[0.02] px-3 py-2">
          <MarkdownProse markdown={item.description} className="prose-xs text-xs text-white/55" />
        </div>
      )}
      <div className="flex flex-wrap gap-1.5 text-[10px]">
        {item.type && <TagPill>{`type: ${item.type}`}</TagPill>}
        {item.priority && <TagPill>{`priority: ${item.priority}`}</TagPill>}
        {item.effort_level && <TagPill>{`effort: ${item.effort_level}`}</TagPill>}
      </div>
      {item.posted_by && (
        <div className="flex items-center gap-2 text-[11px] text-white/40">
          <span>posted by</span>
          <RigLink handle={item.posted_by} wastelandId={wastelandId} push={push} />
        </div>
      )}
      {item.tags && <p className="font-mono text-[10px] text-white/35">tags: {item.tags}</p>}
    </div>
  );
}

const EDIT_SUBKIND_LABEL: Record<'update' | 'delete' | 'unclaim', string> = {
  update: 'Update',
  delete: 'Withdraw',
  unclaim: 'Unclaim',
};

function WantedEditBody({
  item,
  wastelandId,
  push,
}: { item: Extract<InboxItem, { kind: 'wanted-edit' }> } & BodyProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="rounded border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
          {EDIT_SUBKIND_LABEL[item.subkind]}
        </span>
        <p className="truncate text-sm text-white/80">{item.item_title}</p>
      </div>
      <WantedItemLink itemId={item.item_id} wastelandId={wastelandId} push={push} variant="mono" />
      {item.status_transition && (
        <p className="font-mono text-[11px] text-white/50">{item.status_transition}</p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-[11px]">
        {item.posted_by && (
          <MetaRow label="Posted by">
            <RigLink handle={item.posted_by} wastelandId={wastelandId} push={push} />
          </MetaRow>
        )}
        {item.submitter_is_poster !== null && (
          <MetaRow label="Submitter">
            {item.submitter_is_poster ? (
              <span className="text-emerald-400">is the original poster ✓</span>
            ) : (
              <span className="text-amber-400">
                is <em>not</em> the original poster ⚠
              </span>
            )}
          </MetaRow>
        )}
      </dl>
      {item.submitter_is_poster === false && (
        <ScrutinyHint text="Edit submitted by someone other than the original poster. Verify they should be able to modify this item." />
      )}
    </div>
  );
}

function WorkSubmissionBody({
  item,
  wastelandId,
  push,
}: { item: Extract<InboxItem, { kind: 'work-submission' }> } & BodyProps) {
  return (
    <div className="space-y-2">
      <div>
        <WantedItemLink
          itemId={item.item_id}
          label={item.item_title}
          wastelandId={wastelandId}
          push={push}
          variant="row"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="inline-flex items-center gap-1 rounded border border-violet-500/20 bg-violet-500/10 px-1.5 py-0.5 text-violet-300">
          <Hand className="size-3" />
          Claimed
        </span>
        {item.has_done ? (
          <span className="inline-flex items-center gap-1 rounded border border-sky-500/20 bg-sky-500/10 px-1.5 py-0.5 text-sky-300">
            <CheckCircle2 className="size-3" />
            Evidence submitted
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-white/50">
            Claim only — waiting on evidence
          </span>
        )}
        <span className="inline-flex items-center gap-1 text-white/40">
          by
          <RigLink handle={item.claimer} wastelandId={wastelandId} push={push} />
        </span>
      </div>
      {item.evidence_url ? (
        <EvidenceCard evidence={item.evidence_url} />
      ) : (
        item.has_done && (
          <ScrutinyHint
            tone="amber"
            text="No evidence URL recorded on the worker's branch. The DML may have silently no-op'd (stale fork, mismatched rig handle, missing claim, etc.). Inspect on DoltHub before accepting."
          />
        )
      )}
      {item.completion_id && (
        <p className="font-mono text-[10px] text-white/25">completion {item.completion_id}</p>
      )}
    </div>
  );
}

const ADMIN_SUBKIND_LABEL: Record<
  'accept' | 'accept-upstream' | 'reject' | 'close' | 'close-upstream',
  { label: string; tone: 'emerald' | 'red' | 'white' }
> = {
  accept: { label: 'Accept + stamp', tone: 'emerald' },
  'accept-upstream': { label: 'Accept upstream + stamp', tone: 'emerald' },
  reject: { label: 'Reject', tone: 'red' },
  close: { label: 'Close (no stamp)', tone: 'white' },
  'close-upstream': { label: 'Close upstream (no stamp)', tone: 'white' },
};

function AdminActionBody({
  item,
  wastelandId,
  push,
}: { item: Extract<InboxItem, { kind: 'admin-action' }> } & BodyProps) {
  const { label, tone } = ADMIN_SUBKIND_LABEL[item.subkind];
  const toneClass =
    tone === 'emerald'
      ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300'
      : tone === 'red'
        ? 'border-red-500/20 bg-red-500/5 text-red-300'
        : 'border-white/[0.08] bg-white/[0.03] text-white/70';

  const selfStamp = item.stamp && item.worker && item.acceptor && item.worker === item.acceptor;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${toneClass}`}>
          {label}
        </span>
        <p className="truncate text-sm text-white/80">{item.item_title}</p>
      </div>
      <WantedItemLink itemId={item.item_id} wastelandId={wastelandId} push={push} variant="mono" />
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-[11px]">
        {item.worker && (
          <MetaRow label="Worker">
            <RigLink handle={item.worker} wastelandId={wastelandId} push={push} />
          </MetaRow>
        )}
        {item.acceptor && (
          <MetaRow label="Actor">
            <RigLink handle={item.acceptor} wastelandId={wastelandId} push={push} />
          </MetaRow>
        )}
      </dl>
      {item.reject_reason && (
        <div className="rounded-md border border-red-500/10 bg-red-500/5 p-2">
          <p className="mb-1 text-[10px] font-medium tracking-wide text-red-400/70 uppercase">
            Rejection reason
          </p>
          <MarkdownProse markdown={item.reject_reason} className="prose-xs text-xs text-white/70" />
        </div>
      )}
      {item.stamp && (
        <div className="space-y-1 rounded-md border border-emerald-500/10 bg-emerald-500/5 p-2">
          <div className="flex items-center gap-2">
            <Star className="size-3 text-emerald-400" />
            <p className="text-[10px] font-medium tracking-wide text-emerald-400/80 uppercase">
              Stamp
            </p>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-[11px]">
            {item.stamp.quality && (
              <MetaRow label="Quality">
                <span>{item.stamp.quality}</span>
              </MetaRow>
            )}
            {item.stamp.severity && (
              <MetaRow label="Severity">
                <span>{item.stamp.severity}</span>
              </MetaRow>
            )}
            {item.stamp.skill_tags && (
              <MetaRow label="Skills">
                <span className="font-mono">{item.stamp.skill_tags}</span>
              </MetaRow>
            )}
          </dl>
          {item.stamp.message && (
            <div className="border-t border-emerald-500/10 pt-1.5">
              <p className="mb-1 text-[10px] font-medium tracking-wide text-emerald-400/70 uppercase">
                Message
              </p>
              <MarkdownProse
                markdown={item.stamp.message}
                className="prose-xs text-xs text-white/70"
              />
            </div>
          )}
        </div>
      )}
      {selfStamp && (
        <ScrutinyHint
          tone="red"
          text="Author and subject of this stamp are the same rig. wl rejects self-stamps at the CLI, so this PR was likely hand-crafted — do not merge without understanding who authored it."
        />
      )}
      {item.subkind === 'reject' && !item.reject_reason && (
        <ScrutinyHint
          tone="red"
          text="Rejection has no reason — the contributor will see an empty reject commit. Consider asking the actor to resubmit with --reason."
        />
      )}
    </div>
  );
}

function UnknownBody({ item }: { item: Extract<InboxItem, { kind: 'unknown' }> }) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-white/80">{item.title}</p>
      {item.commit_subjects.length > 0 && (
        <div className="rounded-md border border-white/[0.06] bg-white/[0.02] p-2">
          <p className="mb-1 text-[10px] font-medium tracking-wide text-white/40 uppercase">
            Commits
          </p>
          <ul className="space-y-0.5 font-mono text-[11px] text-white/60">
            {item.commit_subjects.map((subject, idx) => (
              <li key={idx} className="truncate">
                {subject}
              </li>
            ))}
          </ul>
        </div>
      )}
      <ScrutinyHint text="This PR wasn't produced by the wl CLI. Inspect it on DoltHub before merging — there's no typed context to compare against." />
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Render a worker's submitted evidence. The wasteland protocol stores
 * `completions.evidence` as a free-form string — the canonical CLI
 * encourages a URL but doesn't enforce one, and historically our
 * mayor tool also accepted prose. Two render paths:
 *
 *  - Cleanly parseable as a single URL → click-to-open card with an
 *    external-link icon (the happy path).
 *  - Anything else (prose, "PR submitted: <url>", commit SHA, etc.) →
 *    pass it through as plain text inside the same card so the admin
 *    can still read it. If we can recover an embedded URL via
 *    `extractFirstUrl`, we surface a separate "Open URL" affordance
 *    at the bottom of the card so the admin doesn't have to copy-paste.
 *
 * Either way the card renders — we never silently drop the value.
 */
function EvidenceCard({ evidence }: { evidence: string }) {
  const trimmed = evidence.trim();
  const url = parseAsUrl(trimmed);

  // Cleanly parseable URL → the original click-target card.
  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="group/evidence flex items-start gap-2 rounded-md border border-sky-500/20 bg-sky-500/5 p-2.5 transition-colors hover:border-sky-500/40 hover:bg-sky-500/10"
      >
        <ExternalLink className="mt-0.5 size-3.5 shrink-0 text-sky-400 transition-colors group-hover/evidence:text-sky-300" />
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-medium tracking-wide text-sky-400/80 uppercase">
            Evidence
          </p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-sky-300 group-hover/evidence:text-sky-200">
            {url}
          </p>
        </div>
      </a>
    );
  }

  // Otherwise pass the value through as plain text. If we can dig a URL
  // out of the surrounding prose (e.g. "PR submitted: https://…"),
  // surface it as a recovery action so reviewers don't get stuck.
  const embedded = extractFirstUrl(trimmed);
  return (
    <div className="rounded-md border border-white/[0.08] bg-white/[0.03] p-2.5">
      <p className="text-[10px] font-medium tracking-wide text-white/40 uppercase">Evidence</p>
      <p className="mt-0.5 font-mono text-[11px] break-words text-white/70">{trimmed}</p>
      {embedded && (
        <a
          href={embedded}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300"
        >
          <ExternalLink className="size-3" />
          Open URL
        </a>
      )}
    </div>
  );
}

/** Strict URL check: returns the URL string if it parses cleanly with an http(s) scheme. */
function parseAsUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Pull the first http(s) URL out of a free-form string, or null. */
function extractFirstUrl(value: string): string | null {
  const match = value.match(/https?:\/\/\S+/);
  if (!match) return null;
  return parseAsUrl(match[0]);
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-white/30">{label}</dt>
      <dd className="truncate text-white/70">{children}</dd>
    </>
  );
}

function TagPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-white/55">
      {children}
    </span>
  );
}

function ScrutinyHint({ text, tone = 'amber' }: { text: string; tone?: 'amber' | 'red' }) {
  const toneClass =
    tone === 'red'
      ? 'border-red-500/20 bg-red-500/5 text-red-300/80'
      : 'border-amber-500/20 bg-amber-500/5 text-amber-200/80';
  return (
    <div className={`flex items-start gap-2 rounded-md border px-2 py-1.5 ${toneClass}`}>
      <AlertTriangle className="mt-0.5 size-3 shrink-0" />
      <p className="text-[11px] leading-snug">{text}</p>
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <span className="shrink-0 text-white/30">{label}</span>
      <span className={`truncate text-white/60 ${mono ? 'font-mono text-[10px]' : ''}`}>
        {value}
      </span>
    </div>
  );
}

function iconFor(kind: InboxKind) {
  switch (kind) {
    case 'rig-registration':
      return UserPlus;
    case 'wanted-post':
      return ScrollText;
    case 'wanted-edit':
      return Pencil;
    case 'work-submission':
      return Hand;
    case 'admin-action':
      return ShieldCheck;
    case 'unknown':
      return HelpCircle;
  }
}

function cardHeading(item: InboxItem): string {
  switch (item.kind) {
    case 'rig-registration':
      return 'Rig registration';
    case 'wanted-post':
      return 'New wanted post';
    case 'wanted-edit':
      return `Wanted ${item.subkind}`;
    case 'work-submission':
      return item.has_done ? 'Work submitted' : 'Claim';
    case 'admin-action':
      return `Admin — ${item.subkind}`;
    case 'unknown':
      return 'Foreign PR';
  }
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}
