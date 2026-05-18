'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Globe,
  Hammer,
  Link2,
  Loader2,
  RotateCw,
  ShieldCheck,
  Skull,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTRPC } from '@/lib/trpc/utils';

/**
 * The canonical Commons upstream — all "join The Commons" flows
 * land here. Single source of truth so we don't drift between surfaces.
 */
export const KILO_COMMONS_UPSTREAM = 'hop/wl-commons';

/**
 * `{owner}/{repo}` shape. Mirrors the regex on the wasteland service
 * input so client-side validation matches the eventual tRPC `.regex()`.
 */
const UPSTREAM_PATTERN = /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/;

/** A wasteland the caller already has credentials stored on, surfaced
 *  by the picker's "Reuse existing connection" card. The dialog passes
 *  these in via `reusableWastelands`; the picker only renders the card
 *  when the list is non-empty. */
export type ReusableWasteland = {
  wasteland_id: string;
  name: string;
  dolthub_upstream: string | null;
};

/** The user's intent for this wasteland's upstream. */
export type UpstreamIntent =
  | { kind: 'commons'; isUpstreamAdmin: boolean }
  | { kind: 'connect'; upstream: string; isUpstreamAdmin: boolean }
  | { kind: 'create'; upstream: string; isUpstreamAdmin: boolean }
  | {
      /** Reuse a wasteland the caller already has credentials on.
       *  No new wasteland record is created; the parent wires the
       *  selection straight into `connectKiloTown`. */
      kind: 'reuse';
      wastelandId: string;
    };

/**
 * Live verification state for the typed upstream. The picker only fires
 * the verify probe when the input parses against `UPSTREAM_PATTERN`, so
 * `idle` covers both "nothing typed" and "typed value is malformed."
 */
type VerifyState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'exists'; defaultBranch: string | null }
  | { status: 'missing'; reason: string };

type Kind = UpstreamIntent['kind'];

type Props = {
  /** Current intent. The parent owns the state. */
  value: UpstreamIntent;
  /** Called whenever the intent changes (kind toggle or per-card field edit). */
  onChange: (next: UpstreamIntent) => void;
  /** Pass through to the verify procedure for org-scoped installs. */
  organizationId?: string;
  /**
   * Optional pre-resolved DoltHub username (from
   * `dolthub.resolveUsername`). When present, Card 3's input prefills as
   * `<username>/...` to nudge users toward repos they actually own.
   */
  dolthubUsername?: string | null;
  /** Per-field disabled state — used when a parent submission is in flight. */
  disabled?: boolean;
  /** Disable the fixed commons card when the caller is already connected. */
  commonsDisabled?: boolean;
  /**
   * Wastelands the caller already has credentials stored on. When the
   * list is non-empty, the picker shows a "Reuse existing connection"
   * card at the top so users coming from Gastown can wire a town to a
   * wasteland they already set up without re-entering credentials.
   * Leave undefined (the default) to hide the reuse path entirely —
   * that's what the standalone "create wasteland" wizard wants.
   */
  reusableWastelands?: ReusableWasteland[];
};

/**
 * Upstream intent picker shared between the standalone "create wasteland"
 * wizard and the Gastown wasteland-connect dialog.
 *
 * Cards (the reuse card only renders when `reusableWastelands` is
 * non-empty — typically only the Gastown connect flow passes it):
 *
 *   0. Reuse existing connection    — wire to a wasteland already set up
 *   1. Join The Commons             — fixed upstream `hop/wl-commons`
 *   2. Connect to an existing repo  — typed `{owner}/{repo}` + verify probe
 *   3. Create a brand-new upstream  — typed `{owner}/{repo}` (must NOT exist)
 *
 * The "I own this upstream" toggle on cards 1–3 flips
 * `is_upstream_admin` server-side, gating direct writes vs fork+PR. We
 * default it OFF on cards 1/2 (most users won't own those repos) and ON
 * on card 3 (you always own a repo you just created), with copy that
 * explains the consequence. The reuse card has no toggle because the
 * stored credential already encodes the admin flag.
 */
export function UpstreamIntentPicker({
  value,
  onChange,
  organizationId,
  dolthubUsername,
  disabled,
  commonsDisabled,
  reusableWastelands,
}: Props) {
  const reuseList = reusableWastelands ?? [];
  const showReuse = reuseList.length > 0;

  const handleKindChange = (kind: Kind) => {
    if (kind === value.kind) return;
    if (kind === 'commons' && commonsDisabled) return;
    if (kind === 'commons') {
      onChange({ kind: 'commons', isUpstreamAdmin: false });
      return;
    }
    if (kind === 'connect') {
      const carriedOver =
        value.kind === 'create' ? value.upstream : value.kind === 'connect' ? value.upstream : '';
      onChange({ kind: 'connect', upstream: carriedOver, isUpstreamAdmin: false });
      return;
    }
    if (kind === 'reuse') {
      // Default to the first reusable entry so the card has a sensible
      // pre-selection when the user clicks it.
      const first = reuseList[0];
      if (!first) return;
      onChange({ kind: 'reuse', wastelandId: first.wasteland_id });
      return;
    }
    // create
    const seed =
      value.kind === 'create'
        ? value.upstream
        : value.kind === 'connect'
          ? value.upstream
          : dolthubUsername
            ? `${dolthubUsername}/`
            : '';
    onChange({ kind: 'create', upstream: seed, isUpstreamAdmin: true });
  };

  return (
    <div className="space-y-3">
      {showReuse && (
        <ReuseCard
          selected={value.kind === 'reuse'}
          intent={value.kind === 'reuse' ? value : null}
          onSelect={() => handleKindChange('reuse')}
          onChange={onChange}
          wastelands={reuseList}
          disabled={disabled}
        />
      )}
      <CommonsCard
        selected={value.kind === 'commons'}
        intent={value.kind === 'commons' ? value : null}
        onSelect={() => handleKindChange('commons')}
        onChange={onChange}
        disabled={disabled || commonsDisabled}
        disabledReason={
          commonsDisabled ? 'You already have a connection to The Commons.' : undefined
        }
      />
      <ConnectCard
        selected={value.kind === 'connect'}
        intent={value.kind === 'connect' ? value : null}
        onSelect={() => handleKindChange('connect')}
        onChange={onChange}
        organizationId={organizationId}
        disabled={disabled}
      />
      <CreateCard
        selected={value.kind === 'create'}
        intent={value.kind === 'create' ? value : null}
        onSelect={() => handleKindChange('create')}
        onChange={onChange}
        organizationId={organizationId}
        dolthubUsername={dolthubUsername}
        disabled={disabled}
      />
    </div>
  );
}

/**
 * Returns whether the current intent is submittable. Parents combine
 * this with their own form-level validity (e.g. wasteland name) to
 * gate the submit button.
 *
 * For Card 2 the parent should additionally check the verify state
 * (exposed via `useUpstreamVerification` below) and refuse to submit
 * while the probe is pending or `missing`.
 */
export function isUpstreamIntentValid(intent: UpstreamIntent): boolean {
  if (intent.kind === 'commons') return true;
  if (intent.kind === 'reuse') return intent.wastelandId.length > 0;
  return UPSTREAM_PATTERN.test(intent.upstream.trim());
}

/**
 * Resolve the final upstream string for an intent. `commons` always
 * yields `hop/wl-commons`; `connect` and `create` return the trimmed
 * user input. `reuse` has no inline upstream (the parent must look it
 * up from the wasteland record by id) and returns an empty string —
 * callers handling `reuse` should branch on `intent.kind` first
 * instead of relying on this helper.
 */
export function resolveUpstreamFromIntent(intent: UpstreamIntent): string {
  if (intent.kind === 'commons') return KILO_COMMONS_UPSTREAM;
  if (intent.kind === 'reuse') return '';
  return intent.upstream.trim();
}

// ── Verification hook ────────────────────────────────────────────────

/**
 * Debounced verify-exists probe shared by Card 2 (connect) and Card 3
 * (create). For `connect` we want `exists=true`; for `create` we want
 * `exists=false`. Returning the raw state lets each card render its
 * own messaging.
 *
 * `enabled=false` disables the underlying query without unmounting,
 * so toggling between cards doesn't tear down/refire requests
 * unnecessarily.
 */
export function useUpstreamVerification({
  upstream,
  organizationId,
  enabled,
}: {
  upstream: string;
  organizationId?: string;
  enabled: boolean;
}): VerifyState {
  const trpc = useTRPC();
  const trimmed = upstream.trim();
  const validShape = UPSTREAM_PATTERN.test(trimmed);
  const debounced = useDebouncedValue(trimmed, 350);

  const query = useQuery({
    ...trpc.dolthub.verifyUpstream.queryOptions({
      organizationId,
      upstream: debounced,
    }),
    enabled: enabled && validShape && debounced === trimmed && trimmed.length > 0,
    // Repos rarely vanish; cache resolved verifications for the dialog
    // session so toggling kinds doesn't refetch.
    staleTime: 5 * 60_000,
    retry: false,
  });

  if (!enabled || !validShape || trimmed.length === 0) {
    return { status: 'idle' };
  }
  if (query.isFetching || debounced !== trimmed) {
    return { status: 'pending' };
  }
  if (query.isError) {
    // Transport error — treat as idle (don't block submission). Most
    // common cause is "you're not signed in"; the actual create call
    // will surface a clearer error if there's a real problem.
    return { status: 'idle' };
  }
  if (query.data?.exists === true) {
    return { status: 'exists', defaultBranch: query.data.defaultBranch ?? null };
  }
  if (query.data?.exists === false) {
    return { status: 'missing', reason: query.data.reason };
  }
  return { status: 'idle' };
}

// ── Card components ──────────────────────────────────────────────────

type CardProps<T extends UpstreamIntent['kind']> = {
  selected: boolean;
  intent: Extract<UpstreamIntent, { kind: T }> | null;
  onSelect: () => void;
  onChange: (next: UpstreamIntent) => void;
  organizationId?: string;
  dolthubUsername?: string | null;
  disabled?: boolean;
};

function CardShell({
  selected,
  onSelect,
  icon,
  title,
  description,
  disabled,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  description: string;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={[
        'rounded-lg border transition-colors',
        selected
          ? 'border-[color:oklch(95%_0.15_108_/_0.5)] bg-[color:oklch(95%_0.15_108_/_0.04)]'
          : 'border-white/[0.08] bg-white/[0.02] hover:border-white/[0.14] hover:bg-white/[0.04]',
      ].join(' ')}
    >
      <button
        type="button"
        onClick={onSelect}
        disabled={disabled}
        className="flex w-full items-start gap-3 px-4 py-3 text-left disabled:cursor-not-allowed disabled:opacity-60"
        aria-pressed={selected}
      >
        <div
          className={[
            'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border',
            selected
              ? 'border-[color:oklch(95%_0.15_108_/_0.7)] bg-[color:oklch(95%_0.15_108_/_0.2)]'
              : 'border-white/20 bg-transparent',
          ].join(' ')}
          aria-hidden
        >
          {selected && (
            <span className="size-2 rounded-full bg-[color:oklch(95%_0.15_108_/_0.95)]" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-white/40">{icon}</span>
            <p className="text-sm font-medium text-white/85">{title}</p>
          </div>
          <p className="mt-1 text-[12px] text-white/45">{description}</p>
        </div>
      </button>
      {selected && children && (
        <div className="border-t border-white/[0.06] px-4 pb-4 pt-3">{children}</div>
      )}
    </div>
  );
}

function ReuseCard({
  selected,
  intent,
  onSelect,
  onChange,
  wastelands,
  disabled,
}: CardProps<'reuse'> & { wastelands: ReusableWasteland[] }) {
  // Default selection seeds with the first wasteland in the list so
  // the dropdown trigger always shows a meaningful label.
  const selectedId = intent?.wastelandId ?? wastelands[0]?.wasteland_id ?? '';
  const selectedWasteland = wastelands.find(w => w.wasteland_id === selectedId) ?? null;

  return (
    <CardShell
      selected={selected}
      onSelect={onSelect}
      icon={<RotateCw className="size-3.5" />}
      title="Reuse an existing connection"
      description="Wire this town to a wasteland you've already set up. No DoltHub credentials needed — we'll reuse the ones stored on that wasteland."
      disabled={disabled}
    >
      <div className="space-y-1.5">
        <Label className="text-xs text-white/55" htmlFor="reuse-wasteland-select">
          Wasteland
        </Label>
        <Select
          value={selectedId}
          onValueChange={value => onChange({ kind: 'reuse', wastelandId: value })}
          disabled={disabled}
        >
          <SelectTrigger
            id="reuse-wasteland-select"
            aria-label="Existing wasteland"
            className="border-white/[0.1] bg-white/[0.03] text-sm text-white/85"
          >
            <SelectValue placeholder="Pick a wasteland">
              {selectedWasteland && (
                <span className="flex min-w-0 items-center gap-2">
                  <Skull className="size-3.5 shrink-0 text-white/30" />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {selectedWasteland.name}
                    {selectedWasteland.dolthub_upstream && (
                      <span className="ml-2 font-mono text-[11px] text-white/35">
                        {selectedWasteland.dolthub_upstream}
                      </span>
                    )}
                  </span>
                </span>
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {wastelands.map(w => (
              <SelectItem key={w.wasteland_id} value={w.wasteland_id}>
                <span className="flex min-w-0 items-center gap-2">
                  <Skull className="size-3.5 shrink-0 text-white/30" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{w.name}</span>
                    {w.dolthub_upstream && (
                      <span className="block truncate font-mono text-[11px] text-white/45">
                        {w.dolthub_upstream}
                      </span>
                    )}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </CardShell>
  );
}

function CommonsCard({
  selected,
  intent,
  onSelect,
  onChange,
  disabled,
  disabledReason,
}: CardProps<'commons'> & { disabledReason?: string }) {
  return (
    <CardShell
      selected={selected}
      onSelect={onSelect}
      icon={<Globe className="size-3.5" />}
      title="Join The Commons"
      description="Contribute to the shared bounty board at hop/wl-commons. Your wasteland forks The Commons; contributions go upstream as pull requests."
      disabled={disabled}
    >
      {disabledReason && (
        <p className="mb-3 rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-[11px] text-white/45">
          {disabledReason}
        </p>
      )}
      <p className="mb-3 flex items-center gap-2 text-[11px] text-white/40">
        <span className="font-mono text-white/55">{KILO_COMMONS_UPSTREAM}</span>
      </p>
      <UpstreamAdminToggle
        checked={intent?.isUpstreamAdmin ?? false}
        onCheckedChange={admin => onChange({ kind: 'commons', isUpstreamAdmin: admin })}
        disabled={disabled}
        ownership="commons"
      />
    </CardShell>
  );
}

function ConnectCard({
  selected,
  intent,
  onSelect,
  onChange,
  organizationId,
  disabled,
}: CardProps<'connect'>) {
  const upstream = intent?.upstream ?? '';
  const isAdmin = intent?.isUpstreamAdmin ?? false;

  const verification = useUpstreamVerification({
    upstream,
    organizationId,
    enabled: selected,
  });

  return (
    <CardShell
      selected={selected}
      onSelect={onSelect}
      icon={<Link2 className="size-3.5" />}
      title="Connect to an existing upstream"
      description="Fork a public repo (or a private one your DoltHub account can read) and contribute back via pull requests."
      disabled={disabled}
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label className="text-xs text-white/55" htmlFor="upstream-connect-input">
            Upstream
          </Label>
          <Input
            id="upstream-connect-input"
            value={upstream}
            onChange={e =>
              onChange({ kind: 'connect', upstream: e.target.value, isUpstreamAdmin: isAdmin })
            }
            placeholder="owner/repo"
            spellCheck={false}
            autoCapitalize="off"
            disabled={disabled}
            className="border-white/[0.1] bg-white/[0.03] font-mono text-sm text-white/85 placeholder:text-white/20"
          />
          <VerificationLine state={verification} mode="connect" />
        </div>
        <UpstreamAdminToggle
          checked={isAdmin}
          onCheckedChange={admin => onChange({ kind: 'connect', upstream, isUpstreamAdmin: admin })}
          disabled={disabled}
          ownership="existing"
        />
      </div>
    </CardShell>
  );
}

function CreateCard({
  selected,
  intent,
  onSelect,
  onChange,
  organizationId,
  dolthubUsername,
  disabled,
}: CardProps<'create'>) {
  const upstream = intent?.upstream ?? '';
  const isAdmin = intent?.isUpstreamAdmin ?? true;

  const verification = useUpstreamVerification({
    upstream,
    organizationId,
    enabled: selected,
  });

  const placeholder = dolthubUsername ? `${dolthubUsername}/my-wasteland` : 'owner/my-wasteland';

  return (
    <CardShell
      selected={selected}
      onSelect={onSelect}
      icon={<Hammer className="size-3.5" />}
      title="Create a brand-new upstream"
      description="Bootstrap a fresh DoltHub repo with the wasteland schema. You'll be the admin from day one."
      disabled={disabled}
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label className="text-xs text-white/55" htmlFor="upstream-create-input">
            New upstream
          </Label>
          <Input
            id="upstream-create-input"
            value={upstream}
            onChange={e =>
              onChange({ kind: 'create', upstream: e.target.value, isUpstreamAdmin: isAdmin })
            }
            placeholder={placeholder}
            spellCheck={false}
            autoCapitalize="off"
            disabled={disabled}
            className="border-white/[0.1] bg-white/[0.03] font-mono text-sm text-white/85 placeholder:text-white/20"
          />
          <VerificationLine state={verification} mode="create" />
        </div>
        <UpstreamAdminToggle
          checked={isAdmin}
          onCheckedChange={admin => onChange({ kind: 'create', upstream, isUpstreamAdmin: admin })}
          disabled={disabled}
          ownership="created"
        />
      </div>
    </CardShell>
  );
}

// ── Atoms ────────────────────────────────────────────────────────────

function VerificationLine({
  state,
  mode,
}: {
  state: VerifyState;
  /** `connect` wants exists=true, `create` wants exists=false. */
  mode: 'connect' | 'create';
}) {
  if (state.status === 'idle') return null;
  if (state.status === 'pending') {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-white/40">
        <Loader2 className="size-3 animate-spin" />
        Checking DoltHub…
      </p>
    );
  }
  if (state.status === 'exists') {
    if (mode === 'create') {
      return (
        <p className="flex items-start gap-1.5 text-[11px] text-yellow-400">
          <XCircle className="mt-0.5 size-3 shrink-0" />
          That repo already exists on DoltHub. Pick a name that isn&apos;t taken yet.
        </p>
      );
    }
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-emerald-400">
        <Sparkles className="size-3" />
        Repo exists{state.defaultBranch ? ` (default branch: ${state.defaultBranch})` : ''}.
      </p>
    );
  }
  if (state.status === 'missing') {
    if (mode === 'create') {
      return (
        <p className="flex items-center gap-1.5 text-[11px] text-emerald-400">
          <Sparkles className="size-3" />
          Available — we&apos;ll create it for you.
        </p>
      );
    }
    return (
      <p className="flex items-start gap-1.5 text-[11px] text-red-400">
        <XCircle className="mt-0.5 size-3 shrink-0" />
        {state.reason || 'No such repository on DoltHub.'}
      </p>
    );
  }
  return null;
}

function UpstreamAdminToggle({
  checked,
  onCheckedChange,
  disabled,
  ownership,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  /** Drives the explanatory copy under the toggle. */
  ownership: 'commons' | 'existing' | 'created';
}) {
  const copy = useMemo(() => {
    switch (ownership) {
      case 'commons':
        return 'Only check this if you actually own hop/wl-commons. Almost everyone should leave this off — your contributions go upstream as pull requests.';
      case 'existing':
        return 'When checked, the wasteland writes directly to this upstream instead of forking. Requires push access on your DoltHub account.';
      case 'created':
        return "You're creating this repo, so you'll own it. Leave this on unless you specifically want a fork-and-PR workflow on your own repo.";
    }
  }, [ownership]);

  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={e => onCheckedChange(e.target.checked)}
        className="mt-0.5 size-3.5 shrink-0 cursor-pointer accent-[color:oklch(95%_0.15_108_/_0.95)]"
      />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-xs text-white/75">
          <ShieldCheck className="size-3 text-white/35" />I own this upstream
        </p>
        <p className="mt-0.5 text-[11px] text-white/40">{copy}</p>
      </div>
    </label>
  );
}

// ── Tiny debounce hook (no shared util exists today) ─────────────────

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
