'use client';

import { formatDistanceToNow } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  GitMerge,
  Hand,
  HelpCircle,
  MessageSquare,
  Pencil,
  ScrollText,
  ShieldCheck,
  Star,
  UserPlus,
  XCircle,
} from 'lucide-react';
import type { InboxItem, ReviewPanelActions } from './types';

type InboxKind = InboxItem['kind'];

export function ReviewItemPanel({
  item,
  actions,
}: {
  item: InboxItem;
  actions: ReviewPanelActions;
}) {
  const { upstream, busy, onMerge, onCloseAction, onComment } = actions;
  const Icon = iconFor(item.kind);

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-white/60" />
        <h3 className="text-sm font-semibold text-white/90">{cardHeading(item)}</h3>
        <Badge
          variant="outline"
          className="border-white/[0.08] font-mono text-[10px] text-white/50"
        >
          #{item.pull_id}
        </Badge>
      </div>

      <CardBody item={item} />

      <div className="space-y-1.5 border-t border-white/[0.06] pt-3">
        {item.from_branch && <DetailRow label="Branch" value={item.from_branch} mono />}
        {item.creator_name && <DetailRow label="Creator" value={item.creator_name} />}
        <DetailRow label="Created" value={formatTimestamp(item.created_at)} />
        <DetailRow label="Updated" value={formatTimestamp(item.updated_at)} />
      </div>

      <div className="flex flex-col gap-2 border-t border-white/[0.06] pt-3">
        <button
          type="button"
          onClick={() => onMerge(item)}
          disabled={busy}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-400 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
        >
          <GitMerge className="size-3.5" />
          Merge PR
        </button>
        <button
          type="button"
          onClick={() => onCloseAction(item)}
          disabled={busy}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/20 disabled:opacity-50"
        >
          <XCircle className="size-3.5" />
          Close (no merge)
        </button>
        <button
          type="button"
          onClick={() => onComment(item)}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-xs font-medium text-white/60 transition-colors hover:bg-white/[0.06]"
        >
          <MessageSquare className="size-3.5" />
          Comment on PR
        </button>
        {upstream && (
          <a
            href={`https://www.dolthub.com/repositories/${upstream}/pulls/${item.pull_id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-xs font-medium text-white/60 transition-colors hover:bg-white/[0.06]"
          >
            <ExternalLink className="size-3.5" />
            Open on DoltHub
          </a>
        )}
      </div>
    </div>
  );
}

// ── Per-kind body ────────────────────────────────────────────────────────

function CardBody({ item }: { item: InboxItem }) {
  switch (item.kind) {
    case 'rig-registration':
      return <RigRegistrationBody item={item} />;
    case 'wanted-post':
      return <WantedPostBody item={item} />;
    case 'wanted-edit':
      return <WantedEditBody item={item} />;
    case 'work-submission':
      return <WorkSubmissionBody item={item} />;
    case 'admin-action':
      return <AdminActionBody item={item} />;
    case 'unknown':
      return <UnknownBody item={item} />;
  }
}

function RigRegistrationBody({ item }: { item: Extract<InboxItem, { kind: 'rig-registration' }> }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 ring-1 ring-emerald-500/20">
          <UserPlus className="size-4 text-emerald-400" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-sm text-white/85">{item.handle}</p>
          {item.display_name && <p className="text-xs text-white/50">{item.display_name}</p>}
        </div>
      </div>
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

function WantedPostBody({ item }: { item: Extract<InboxItem, { kind: 'wanted-post' }> }) {
  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-medium text-white/85">{item.item_title}</p>
        <p className="mt-0.5 font-mono text-[10px] text-white/30">{item.item_id}</p>
      </div>
      {item.description && (
        <p className="line-clamp-6 text-xs whitespace-pre-wrap text-white/55">{item.description}</p>
      )}
      <div className="flex flex-wrap gap-1.5 text-[10px]">
        {item.type && <TagPill>{`type: ${item.type}`}</TagPill>}
        {item.priority && <TagPill>{`priority: ${item.priority}`}</TagPill>}
        {item.effort_level && <TagPill>{`effort: ${item.effort_level}`}</TagPill>}
        {item.posted_by && <TagPill>{`by: ${item.posted_by}`}</TagPill>}
      </div>
      {item.tags && <p className="font-mono text-[10px] text-white/35">tags: {item.tags}</p>}
    </div>
  );
}

const EDIT_SUBKIND_LABEL: Record<'update' | 'delete' | 'unclaim', string> = {
  update: 'Update',
  delete: 'Withdraw',
  unclaim: 'Unclaim',
};

function WantedEditBody({ item }: { item: Extract<InboxItem, { kind: 'wanted-edit' }> }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="rounded border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
          {EDIT_SUBKIND_LABEL[item.subkind]}
        </span>
        <p className="truncate text-sm text-white/80">{item.item_title}</p>
      </div>
      <p className="font-mono text-[10px] text-white/30">{item.item_id}</p>
      {item.status_transition && (
        <p className="font-mono text-[11px] text-white/50">{item.status_transition}</p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-[11px]">
        {item.posted_by && (
          <MetaRow label="Posted by">
            <span className="font-mono">{item.posted_by}</span>
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

function WorkSubmissionBody({ item }: { item: Extract<InboxItem, { kind: 'work-submission' }> }) {
  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-medium text-white/85">{item.item_title}</p>
        <p className="mt-0.5 font-mono text-[10px] text-white/30">{item.item_id}</p>
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
        <span className="text-white/40">
          by <span className="font-mono text-white/70">{item.claimer}</span>
        </span>
      </div>
      {item.evidence_url && (
        <div className="rounded-md border border-white/[0.06] bg-white/[0.02] p-2">
          <p className="mb-1 text-[10px] font-medium tracking-wide text-white/40 uppercase">
            Evidence
          </p>
          <a
            href={item.evidence_url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-[11px] break-all text-sky-400 hover:text-sky-300"
          >
            {item.evidence_url}
          </a>
        </div>
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

function AdminActionBody({ item }: { item: Extract<InboxItem, { kind: 'admin-action' }> }) {
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
      <p className="font-mono text-[10px] text-white/30">{item.item_id}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-[11px]">
        {item.worker && (
          <MetaRow label="Worker">
            <span className="font-mono">{item.worker}</span>
          </MetaRow>
        )}
        {item.acceptor && (
          <MetaRow label="Actor">
            <span className="font-mono">{item.acceptor}</span>
          </MetaRow>
        )}
      </dl>
      {item.reject_reason && (
        <div className="rounded-md border border-red-500/10 bg-red-500/5 p-2">
          <p className="mb-1 text-[10px] font-medium tracking-wide text-red-400/70 uppercase">
            Rejection reason
          </p>
          <p className="text-xs text-white/70">{item.reject_reason}</p>
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
            {item.stamp.message && (
              <MetaRow label="Message">
                <span>{item.stamp.message}</span>
              </MetaRow>
            )}
          </dl>
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
