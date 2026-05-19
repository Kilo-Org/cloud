'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  GitFork,
  Globe,
  Loader2,
  Sparkles,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { SecretTokenInput } from '@/components/ui/secret-token-input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTRPC } from '@/lib/trpc/utils';
import {
  WastelandTRPCProvider,
  useWastelandTRPC,
  useWastelandTRPCClient,
  createWastelandTRPCClient,
} from '@/lib/wasteland/trpc';
import {
  KILO_COMMONS_UPSTREAM,
  UpstreamIntentPicker,
  isUpstreamIntentValid,
  resolveUpstreamFromIntent,
  useUpstreamVerification,
  type UpstreamIntent,
} from '@/components/wasteland/UpstreamIntent';
import { parseDolthubUpstream } from '@/lib/wasteland/upstream';

/**
 * Build the canonical post-create URL for a wasteland.
 *
 * Personal-scope wastelands route to `/wasteland/{owner}/{repo}` (the
 * M2.2 path the rest of the product uses). The bare `/wasteland/{id}`
 * URL would otherwise hit the `[owner]/[repo]` route with the id as the
 * owner segment and 404. When the upstream string can't be parsed we
 * fall back to `/wasteland/by-id/{wastelandId}`, the redirect page that
 * resolves the upstream server-side.
 *
 * Org-scope wastelands keep their existing `/organizations/{orgId}/...`
 * URL — the org wasteland routes have their own id-based pages.
 */
function postCreateWastelandPath(args: {
  wastelandId: string;
  upstream: string;
  lockedOrgId: string | null | undefined;
}): string {
  if (args.lockedOrgId) {
    return `/organizations/${args.lockedOrgId}/wasteland/${args.wastelandId}`;
  }
  const parsed = parseDolthubUpstream(args.upstream);
  if (parsed) return `/wasteland/${parsed.owner}/${parsed.repo}`;
  return `/wasteland/by-id/${args.wastelandId}`;
}

const NAME_MAX_LENGTH = 128;

/**
 * Rig handle pattern. Mirrors the wasteland's `rigs.handle` constraint
 * and the server-side `joinWasteland` Zod regex: lowercase letters,
 * digits, `-`, and `_`. Length 1–64.
 */
const RIG_HANDLE_PATTERN = /^[a-z0-9_-]+$/;

type OwnershipType = 'personal' | 'organization';

/** Wizard steps. The exact set varies by intent — see {@link visibleSteps}. */
type Step = 'intent' | 'credentials' | 'rig' | 'preview' | 'work' | 'success';

/** Mirror of the `joinWasteland` tRPC output. */
type JoinResult = {
  forkOwner: string;
  forkRepo: string;
  forkUrl: string;
  rigHandle: string;
  registrationBranch: string;
  registrationPullId: string | null;
  registrationPullUrl: string | null;
  alreadyJoined: boolean;
};

type SuccessState = {
  wastelandId: string;
  wastelandPath: string;
  upstream: string;
  join: JoinResult | null;
};

type NewWastelandWizardFormProps = {
  /** When set, the form is accessed from an org-scoped route and ownership is locked. */
  lockedOrgId?: string;
};

/** Best-effort suggestion derived from a DoltHub username. */
function suggestRigHandle(username: string | null | undefined): string {
  if (!username) return '';
  const lower = username.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  return lower.slice(0, 64);
}

/** Validate the `rig` step's input against the upstream `rigs.handle` rules. */
function getRigHandleError(handle: string): string | null {
  const trimmed = handle.trim();
  if (trimmed.length === 0) return 'Rig handle is required';
  if (trimmed.length > 64) return 'Rig handle must be 64 characters or fewer';
  if (!RIG_HANDLE_PATTERN.test(trimmed)) {
    return 'Use lowercase letters, digits, hyphens, or underscores only';
  }
  return null;
}

function NewWastelandWizardForm({ lockedOrgId }: NewWastelandWizardFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const trpc = useWastelandTRPC();
  const wastelandClient = useWastelandTRPCClient();
  const queryClient = useQueryClient();
  const mainTrpc = useTRPC();

  // ── Form state ────────────────────────────────────────────────────

  const [name, setName] = useState('');
  const [ownership, setOwnership] = useState<OwnershipType>(
    lockedOrgId ? 'organization' : 'personal'
  );
  const [selectedOrgId, setSelectedOrgId] = useState<string>(lockedOrgId ?? '');
  const [intent, setIntent] = useState<UpstreamIntent>(() => {
    // Pre-fill from `?upstream=<owner>/<repo>` per M2.2: the
    // unconnected wasteland shell links here when the user wants to
    // connect a known upstream.
    const upstreamHint = searchParams.get('upstream')?.trim();
    if (upstreamHint && /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(upstreamHint)) {
      if (upstreamHint === KILO_COMMONS_UPSTREAM) {
        return { kind: 'commons', isUpstreamAdmin: false };
      }
      return { kind: 'connect', upstream: upstreamHint, isUpstreamAdmin: false };
    }
    return { kind: 'commons', isUpstreamAdmin: false };
  });
  // Credentials step state
  const [manualOpen, setManualOpen] = useState(false);
  const [dolthubToken, setDolthubToken] = useState('');
  const [dolthubOrg, setDolthubOrg] = useState('');

  // Rig step state — auto-prefilled from DoltHub username
  const [rigHandle, setRigHandle] = useState('');
  const [rigHandleTouched, setRigHandleTouched] = useState(false);

  // Wizard cursor + result
  const [step, setStep] = useState<Step>('intent');
  const [error, setError] = useState<string | null>(null);
  const [successState, setSuccessState] = useState<SuccessState | null>(null);
  // Track the wasteland created in `runProvision` so a retry
  // after a credential-store / join failure reuses the existing record
  // instead of creating a duplicate. Cleared if the user navigates
  // back to a step that could change the create payload.
  const [pendingWastelandId, setPendingWastelandId] = useState<string | null>(null);

  // ── Queries ───────────────────────────────────────────────────────

  const orgsQuery = useQuery(mainTrpc.organizations.list.queryOptions());
  const existingWastelandsQuery = useQuery(
    trpc.wasteland.listWastelands.queryOptions(lockedOrgId ? { organizationId: lockedOrgId } : {})
  );

  const verifyOrgId = ownership === 'organization' ? selectedOrgId || undefined : undefined;

  // OAuth installation + cached credentials. Used to skip the manual
  // token field when the integration is wired up.
  const installationQuery = useQuery({
    ...mainTrpc.dolthub.getInstallation.queryOptions(
      verifyOrgId ? { organizationId: verifyOrgId } : undefined
    ),
    refetchInterval: query => {
      const installed = query.state.data?.installed === true;
      return step === 'credentials' && !installed ? 3_000 : false;
    },
    refetchIntervalInBackground: true,
  });
  const installationCredentialsQuery = useQuery({
    ...mainTrpc.dolthub.getInstallationCredentials.queryOptions(
      verifyOrgId ? { organizationId: verifyOrgId } : undefined
    ),
    enabled: installationQuery.data?.installed === true,
  });
  const dolthubUsernameQuery = useQuery({
    ...mainTrpc.dolthub.resolveUsername.queryOptions(
      verifyOrgId ? { organizationId: verifyOrgId } : undefined
    ),
    staleTime: Infinity,
  });

  const isDolthubInstalled = installationQuery.data?.installed === true;
  const oauthDolthubToken = installationCredentialsQuery.data?.token ?? null;
  const cachedDolthubUsername =
    dolthubUsernameQuery.data?.username ??
    installationCredentialsQuery.data?.dolthubUsername ??
    null;

  // Upstream verification (Card 2 / Card 3 inside the picker).
  const connectVerification = useUpstreamVerification({
    upstream: intent.kind === 'connect' ? intent.upstream : '',
    organizationId: verifyOrgId,
    enabled: intent.kind === 'connect',
  });
  const createVerification = useUpstreamVerification({
    upstream: intent.kind === 'create' ? intent.upstream : '',
    organizationId: verifyOrgId,
    enabled: intent.kind === 'create',
  });

  // Auto-prefill the DoltHub org once the OAuth token + username are known.
  useEffect(() => {
    if (dolthubOrg) return;
    if (cachedDolthubUsername) setDolthubOrg(cachedDolthubUsername);
  }, [cachedDolthubUsername, dolthubOrg]);

  // If the user edits any of the createWasteland inputs after a record
  // was already provisioned (because join failed mid-retry), drop the
  // cached wastelandId so the next attempt creates a fresh record with
  // the updated values. The early return makes the body a no-op once
  // the id is cleared, so the effect can include `pendingWastelandId`
  // in its deps without looping.
  useEffect(() => {
    if (pendingWastelandId === null) return;
    setPendingWastelandId(null);
  }, [name, ownership, selectedOrgId, intent, pendingWastelandId]);

  // Auto-prefill the rig handle from the DoltHub username, but only
  // until the user explicitly edits it. Truncating non-conforming
  // characters so the suggestion already passes validation.
  useEffect(() => {
    if (rigHandleTouched) return;
    if (!cachedDolthubUsername) return;
    const suggested = suggestRigHandle(cachedDolthubUsername);
    if (suggested && suggested !== rigHandle) setRigHandle(suggested);
  }, [cachedDolthubUsername, rigHandle, rigHandleTouched]);

  // ── Validation ────────────────────────────────────────────────────

  const nameError = getNameError(name);
  const hasCommonsConnection =
    existingWastelandsQuery.data?.some(w => w.dolthub_upstream === KILO_COMMONS_UPSTREAM) ?? false;
  const commonsIntentBlocked = intent.kind === 'commons' && hasCommonsConnection;
  const orgError = getOrgError(ownership, selectedOrgId, orgsQuery.data);
  const intentValid = isUpstreamIntentValid(intent);
  const upstreamProbeBlocked =
    (intent.kind === 'connect' &&
      (connectVerification.status === 'pending' || connectVerification.status === 'missing')) ||
    (intent.kind === 'create' &&
      (createVerification.status === 'pending' || createVerification.status === 'exists'));
  const intentStepValid =
    !nameError &&
    !orgError &&
    intentValid &&
    !upstreamProbeBlocked &&
    !commonsIntentBlocked &&
    name.trim().length > 0;

  const oauthCredentialsValid =
    !manualOpen && Boolean(oauthDolthubToken) && dolthubOrg.trim().length > 0;
  const manualCredentialsValid =
    manualOpen && dolthubToken.trim().length > 0 && dolthubOrg.trim().length > 0;
  const credentialsValid = oauthCredentialsValid || manualCredentialsValid;

  const rigHandleError = getRigHandleError(rigHandle);
  const rigStepValid = rigHandleError === null;

  // Whether this intent runs the upstream-bootstrap path (`createUpstream`)
  // versus the explicit fork-and-register ceremony (`joinWasteland`). Both
  // paths now go through the same stepper — credentials and rig handle are
  // required for either flow because both call into a DoltHub-authenticated
  // mutation. `reuse` is N/A here (the standalone wizard never shows the
  // reuse card).
  const isCreateIntent = intent.kind === 'create';

  // The set of steps shown in the stepper, gated by intent. The work
  // step's label changes based on the action; everything else is shared.
  const visibleSteps = useMemo<{ key: Step; label: string }[]>(() => {
    return [
      { key: 'intent', label: 'Wasteland' },
      { key: 'credentials', label: 'DoltHub' },
      { key: 'rig', label: 'Rig handle' },
      { key: 'preview', label: 'Confirm' },
      { key: 'work', label: isCreateIntent ? 'Creating' : 'Joining' },
      { key: 'success', label: 'Done' },
    ];
  }, [isCreateIntent]);

  const stepIndex = visibleSteps.findIndex(s => s.key === step);

  // ── Mutations ─────────────────────────────────────────────────────

  const createMutation = useMutation(
    trpc.wasteland.createWasteland.mutationOptions({
      onError: err => toast.error(err.message),
    })
  );

  // ── Handlers ──────────────────────────────────────────────────────

  /** Resolve the token used for storeCredential. Mirrors the gastown wizard. */
  const resolveDolthubToken = (): string | null => {
    if (!manualOpen && oauthDolthubToken) return oauthDolthubToken;
    if (manualOpen && dolthubToken.trim()) return dolthubToken;
    return null;
  };

  /**
   * Run the full provision flow. Both branches start with `createWasteland`
   * + `storeCredential`; the join branch (commons/connect) finishes with
   * `joinWasteland`, while the create branch finishes with `createUpstream`
   * (which bootstraps a brand-new DoltHub repo and registers the caller as
   * the first rig). Wraps in a separate function so the "Retry" button on
   * a failure can re-invoke without reopening earlier steps.
   */
  const runProvision = async () => {
    setStep('work');
    setError(null);

    try {
      const upstream = resolveUpstreamFromIntent(intent);

      // 1. Create the wasteland record (auto-adds caller as owner member).
      // On retry, reuse the previously-created record instead of
      // creating a second one.
      let wastelandId = pendingWastelandId;
      if (!wastelandId) {
        const created = await wastelandClient.wasteland.createWasteland.mutate({
          name: name.trim(),
          ownerType: ownership === 'organization' ? 'org' : 'user',
          organizationId: ownership === 'organization' ? selectedOrgId : undefined,
          dolthubUpstream: upstream,
        });
        wastelandId = created.wasteland_id;
        setPendingWastelandId(wastelandId);
      }
      const wastelandPath = postCreateWastelandPath({
        wastelandId,
        upstream,
        lockedOrgId,
      });

      // 2. Persist DoltHub credentials so the downstream mutation
      //    (joinWasteland or createUpstream) can resolve them
      //    deterministically. For the create branch the caller is
      //    the upstream admin by definition; for commons/connect we
      //    honour the toggle on the corresponding picker card.
      const tokenToStore = resolveDolthubToken();
      if (!tokenToStore) {
        throw new Error('Connect your DoltHub account or paste an API token to continue.');
      }
      // The standalone wizard's picker never surfaces the `reuse` card,
      // so `intent.kind` is always `commons | connect | create` here. Pull
      // the admin flag explicitly per branch so TS narrows correctly.
      const isUpstreamAdmin =
        intent.kind === 'create'
          ? true
          : intent.kind === 'commons' || intent.kind === 'connect'
            ? intent.isUpstreamAdmin
            : false;
      await wastelandClient.wasteland.storeCredential.mutate({
        wastelandId,
        dolthubToken: tokenToStore,
        dolthubOrg: dolthubOrg.trim(),
        rigHandle: rigHandle.trim(),
        isUpstreamAdmin,
      });

      // 3. Bootstrap the DoltHub repo (create) OR run the explicit
      //    fork-and-register ceremony (commons/connect).
      let join: JoinResult | null = null;
      if (isCreateIntent) {
        await wastelandClient.wasteland.createUpstream.mutate({
          wastelandId,
          upstream,
          rigHandle: rigHandle.trim(),
        });
      } else {
        join = await wastelandClient.wasteland.joinWasteland.mutate({
          wastelandId,
          rigHandle: rigHandle.trim(),
        });
      }

      void queryClient.invalidateQueries({
        queryKey: trpc.wasteland.listWastelands.queryKey({}),
      });

      setSuccessState({
        wastelandId,
        wastelandPath,
        upstream,
        join,
      });
      setStep('success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set up the wasteland');
      setStep('preview');
    }
  };

  /**
   * Retry handler from the failure-state preview step.
   * `runProvision` reuses `pendingWastelandId` when set, so a retry
   * after a credential-store / join / create-upstream failure does not
   * create a duplicate wasteland record. `storeCredential`, `joinWasteland`,
   * and `createUpstream` are themselves idempotent.
   */
  const handleRetry = () => {
    void runProvision();
  };

  // ── Step transitions ──────────────────────────────────────────────

  const goToCredentials = () => {
    if (!intentStepValid) return;
    setStep('credentials');
  };

  const goToRig = () => {
    if (!credentialsValid) return;
    setStep('rig');
  };

  const goToPreview = () => {
    if (!rigStepValid) return;
    setStep('preview');
  };

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div className="mx-auto w-full max-w-2xl py-12 px-4">
      <div className="mb-8 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Connect a wasteland
        </h1>
        <p className="text-sm text-muted-foreground">
          Wastelands are hosted bounty boards backed by DoltHub. We&apos;ll fork the upstream into
          your account and register your rig before opening the door.
        </p>
      </div>

      <Stepper steps={visibleSteps} currentIndex={Math.max(stepIndex, 0)} />

      {step === 'intent' && (
        <IntentStep
          name={name}
          setName={setName}
          nameError={nameError}
          ownership={ownership}
          setOwnership={setOwnership}
          lockedOrgId={lockedOrgId}
          selectedOrgId={selectedOrgId}
          setSelectedOrgId={setSelectedOrgId}
          orgs={orgsQuery.data}
          orgsLoading={orgsQuery.isLoading}
          orgError={orgError}
          intent={intent}
          setIntent={setIntent}
          dolthubUsername={cachedDolthubUsername}
          canContinue={intentStepValid}
          continueLabel="Next"
          onContinue={goToCredentials}
          isPending={createMutation.isPending}
          commonsDisabled={hasCommonsConnection}
        />
      )}

      {step === 'credentials' && (
        <CredentialsStep
          isDolthubInstalled={isDolthubInstalled}
          installationLoading={installationQuery.isLoading}
          dolthubOrg={dolthubOrg}
          setDolthubOrg={setDolthubOrg}
          oauthCachedUsername={cachedDolthubUsername}
          manualOpen={manualOpen}
          setManualOpen={setManualOpen}
          dolthubToken={dolthubToken}
          setDolthubToken={setDolthubToken}
          canContinue={credentialsValid}
          onBack={() => setStep('intent')}
          onContinue={goToRig}
        />
      )}

      {step === 'rig' && (
        <RigStep
          rigHandle={rigHandle}
          setRigHandle={value => {
            setRigHandle(value);
            setRigHandleTouched(true);
          }}
          rigHandleError={rigHandleError}
          dolthubUsername={cachedDolthubUsername}
          onUseSuggested={() => {
            setRigHandle(suggestRigHandle(cachedDolthubUsername));
            setRigHandleTouched(false);
          }}
          canContinue={rigStepValid}
          onBack={() => setStep('credentials')}
          onContinue={goToPreview}
        />
      )}

      {step === 'preview' && (
        <PreviewStep
          intent={intent}
          rigHandle={rigHandle.trim()}
          dolthubOrg={dolthubOrg.trim()}
          name={name.trim()}
          error={error}
          onBack={() => {
            setError(null);
            setStep('rig');
          }}
          onJoin={() => void runProvision()}
          onRetry={handleRetry}
        />
      )}

      {step === 'work' && (
        <WorkStep intent={intent} rigHandle={rigHandle.trim()} dolthubOrg={dolthubOrg.trim()} />
      )}

      {step === 'success' && successState && (
        <SuccessStep
          state={successState}
          intent={intent}
          onDone={() => router.push(successState.wastelandPath)}
        />
      )}
    </div>
  );
}

// ── Stepper ──────────────────────────────────────────────────────────

function Stepper({
  steps,
  currentIndex,
}: {
  steps: { key: Step; label: string }[];
  currentIndex: number;
}) {
  return (
    <ol
      className="mb-8 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
      aria-label="Connect wasteland progress"
    >
      {steps.map((s, i) => {
        const active = i === currentIndex;
        const complete = i < currentIndex;
        return (
          <li key={s.key} className="flex items-center gap-2">
            <span
              className={[
                'flex size-5 items-center justify-center rounded-full border text-[10px]',
                complete
                  ? 'border-primary bg-primary/20 text-primary'
                  : active
                    ? 'border-primary text-primary'
                    : 'border-border text-muted-foreground/60',
              ].join(' ')}
              aria-current={active ? 'step' : undefined}
            >
              {complete ? <CheckCircle2 className="size-3" /> : i + 1}
            </span>
            <span
              className={
                active
                  ? 'text-foreground'
                  : complete
                    ? 'text-foreground/70'
                    : 'text-muted-foreground/60'
              }
            >
              {s.label}
            </span>
            {i < steps.length - 1 && <span className="text-muted-foreground/30">·</span>}
          </li>
        );
      })}
    </ol>
  );
}

// ── Step: Intent ─────────────────────────────────────────────────────

function IntentStep({
  name,
  setName,
  nameError,
  ownership,
  setOwnership,
  lockedOrgId,
  selectedOrgId,
  setSelectedOrgId,
  orgs,
  orgsLoading,
  orgError,
  intent,
  setIntent,
  dolthubUsername,
  canContinue,
  continueLabel,
  onContinue,
  isPending,
  commonsDisabled,
}: {
  name: string;
  setName: (v: string) => void;
  nameError: string | null;
  ownership: OwnershipType;
  setOwnership: (v: OwnershipType) => void;
  lockedOrgId?: string;
  selectedOrgId: string;
  setSelectedOrgId: (v: string) => void;
  orgs: { organizationId: string; organizationName: string; role: string }[] | undefined;
  orgsLoading: boolean;
  orgError: string | null;
  intent: UpstreamIntent;
  setIntent: (next: UpstreamIntent) => void;
  dolthubUsername: string | null;
  canContinue: boolean;
  continueLabel: string;
  onContinue: () => void;
  isPending: boolean;
  commonsDisabled: boolean;
}) {
  return (
    <div className="space-y-6">
      {/* Name */}
      <div className="space-y-2">
        <Label htmlFor="wasteland-name">Wasteland name</Label>
        <Input
          id="wasteland-name"
          placeholder="My Wasteland"
          value={name}
          onChange={e => setName(e.target.value)}
          maxLength={NAME_MAX_LENGTH}
          autoFocus
        />
        {nameError && <p className="text-xs text-destructive">{nameError}</p>}
      </div>

      {/* Ownership */}
      <div className="space-y-2">
        <Label>Ownership</Label>
        <RadioGroup
          value={ownership}
          onValueChange={v => {
            if (lockedOrgId) return;
            setOwnership(v as OwnershipType);
            if (v === 'personal') setSelectedOrgId('');
          }}
        >
          <div className="flex items-center gap-2">
            <RadioGroupItem value="personal" id="ownership-personal" disabled={!!lockedOrgId} />
            <Label htmlFor="ownership-personal" className="cursor-pointer font-normal">
              Personal
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="organization" id="ownership-org" disabled={!!lockedOrgId} />
            <Label htmlFor="ownership-org" className="cursor-pointer font-normal">
              Organization
            </Label>
          </div>
        </RadioGroup>
        {ownership === 'organization' && (
          <div className="mt-2">
            {lockedOrgId ? (
              <p className="text-sm text-muted-foreground">
                Organization:{' '}
                <span className="font-medium text-foreground">
                  {orgs?.find(o => o.organizationId === lockedOrgId)?.organizationName ??
                    lockedOrgId}
                </span>
              </p>
            ) : (
              <Select value={selectedOrgId} onValueChange={setSelectedOrgId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select an organization" />
                </SelectTrigger>
                <SelectContent>
                  {orgsLoading && (
                    <SelectItem value="__loading" disabled>
                      Loading…
                    </SelectItem>
                  )}
                  {orgs
                    ?.filter(o => o.role !== 'billing_manager')
                    .map(org => (
                      <SelectItem key={org.organizationId} value={org.organizationId}>
                        {org.organizationName}
                      </SelectItem>
                    ))}
                  {orgs && orgs.filter(o => o.role !== 'billing_manager').length === 0 && (
                    <SelectItem value="__none" disabled>
                      No organizations available
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            )}
            {orgError && <p className="mt-1 text-xs text-destructive">{orgError}</p>}
          </div>
        )}
      </div>

      {/* Upstream intent */}
      <div className="space-y-2">
        <Label>DoltHub upstream</Label>
        <UpstreamIntentPicker
          value={intent}
          onChange={setIntent}
          organizationId={ownership === 'organization' ? selectedOrgId || undefined : undefined}
          dolthubUsername={dolthubUsername}
          disabled={isPending}
          commonsDisabled={commonsDisabled}
        />
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button onClick={onContinue} disabled={!canContinue || isPending} variant="primary">
          {isPending && <Loader2 className="size-4 animate-spin" />}
          {continueLabel}
          <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

// ── Step: Credentials ────────────────────────────────────────────────

function CredentialsStep({
  isDolthubInstalled,
  installationLoading,
  dolthubOrg,
  setDolthubOrg,
  oauthCachedUsername,
  manualOpen,
  setManualOpen,
  dolthubToken,
  setDolthubToken,
  canContinue,
  onBack,
  onContinue,
}: {
  isDolthubInstalled: boolean;
  installationLoading: boolean;
  dolthubOrg: string;
  setDolthubOrg: (v: string) => void;
  oauthCachedUsername: string | null;
  manualOpen: boolean;
  setManualOpen: (v: boolean) => void;
  dolthubToken: string;
  setDolthubToken: (v: string) => void;
  canContinue: boolean;
  onBack: () => void;
  onContinue: () => void;
}) {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-medium text-foreground">DoltHub credentials</h2>
        <p className="text-sm text-muted-foreground">
          Connect your DoltHub account so we can fork the upstream and push contributions on your
          behalf.
        </p>
      </div>

      <div className="space-y-4">
        {installationLoading ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-4 py-3">
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Checking DoltHub integration…</span>
          </div>
        ) : isDolthubInstalled ? (
          <div className="space-y-3 rounded-lg border border-border bg-card px-4 py-3">
            <div className="flex items-start gap-2">
              <Sparkles className="mt-0.5 size-3.5 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-foreground">Use your connected DoltHub account</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  We&apos;ll forward your OAuth-issued token. Confirm your username so we can label
                  commits and contribution branches.
                </p>
              </div>
            </div>
            <FieldGroup
              label="Your DoltHub username"
              hint={
                oauthCachedUsername
                  ? 'Cached from your DoltHub install. Edit if needed.'
                  : 'Saved on the DoltHub integration after connect.'
              }
            >
              <Input
                name="dolthub-handle"
                value={dolthubOrg}
                onChange={e => setDolthubOrg(e.target.value)}
                placeholder="my-username"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-1p-ignore="true"
                data-lpignore="true"
                data-form-type="other"
                className="font-mono"
              />
            </FieldGroup>
          </div>
        ) : (
          <div className="space-y-2 rounded-lg border border-border bg-muted/40 px-4 py-3">
            <p className="text-sm text-foreground">Connect with DoltHub for the smoothest setup</p>
            <p className="text-xs text-muted-foreground">
              Install the DoltHub integration once and skip pasting tokens.
            </p>
            <a
              href="/integrations/dolthub"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
            >
              Install DoltHub integration
              <ArrowUpRight className="size-3" />
            </a>
          </div>
        )}

        <Collapsible open={manualOpen} onOpenChange={setManualOpen}>
          <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md px-1 py-1 text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground/80">
            <span>Advanced — paste an API token</span>
            <ChevronDown
              className={`size-3 transition-transform ${manualOpen ? 'rotate-180' : ''}`}
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 space-y-3">
            <form autoComplete="off" className="space-y-3" onSubmit={e => e.preventDefault()}>
              <FieldGroup
                label="DoltHub API token"
                hint="Create one at dolthub.com/settings/tokens"
              >
                <SecretTokenInput
                  name="dolthub-api-token"
                  value={dolthubToken}
                  onChange={e => setDolthubToken(e.target.value)}
                  placeholder="Paste a personal API token"
                  toggleLabel="Show DoltHub token"
                  className="font-mono"
                />
              </FieldGroup>
              <FieldGroup label="DoltHub username" hint="Your DoltHub username or org">
                <Input
                  name="dolthub-handle"
                  value={dolthubOrg}
                  onChange={e => setDolthubOrg(e.target.value)}
                  placeholder="my-username"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-1p-ignore="true"
                  data-lpignore="true"
                  data-form-type="other"
                  className="font-mono"
                />
              </FieldGroup>
            </form>
          </CollapsibleContent>
        </Collapsible>
      </div>

      <div className="flex items-center justify-between pt-2">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft className="size-4" />
          Back
        </Button>
        <Button onClick={onContinue} disabled={!canContinue} variant="primary">
          Next
          <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

// ── Step: Rig handle ─────────────────────────────────────────────────

function RigStep({
  rigHandle,
  setRigHandle,
  rigHandleError,
  dolthubUsername,
  onUseSuggested,
  canContinue,
  onBack,
  onContinue,
}: {
  rigHandle: string;
  setRigHandle: (v: string) => void;
  rigHandleError: string | null;
  dolthubUsername: string | null;
  onUseSuggested: () => void;
  canContinue: boolean;
  onBack: () => void;
  onContinue: () => void;
}) {
  const suggested = suggestRigHandle(dolthubUsername);
  const showSuggestion = suggested.length > 0 && suggested !== rigHandle;
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-medium text-foreground">Rig handle</h2>
        <p className="text-sm text-muted-foreground">
          This is how you&apos;ll show up on the wasteland — on commits, claims, and the rig
          registry. We default to your DoltHub username; pick something else if you&apos;d rather
          not.
        </p>
      </div>

      <FieldGroup
        label="Handle"
        hint="Lowercase letters, digits, hyphens, or underscores. Up to 64 characters."
      >
        <Input
          value={rigHandle}
          onChange={e => setRigHandle(e.target.value)}
          placeholder="my-rig"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={64}
          className="font-mono"
        />
        {showSuggestion && (
          <button
            type="button"
            onClick={onUseSuggested}
            className="mt-1 text-[11px] text-primary underline-offset-4 hover:underline"
          >
            Use suggested: <span className="font-mono">{suggested}</span>
          </button>
        )}
      </FieldGroup>

      {rigHandleError && rigHandle.length > 0 && (
        <p className="text-xs text-destructive">{rigHandleError}</p>
      )}

      <div className="flex items-center justify-between pt-2">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft className="size-4" />
          Back
        </Button>
        <Button onClick={onContinue} disabled={!canContinue} variant="primary">
          Next
          <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

// ── Step: Preview ────────────────────────────────────────────────────

function PreviewStep({
  intent,
  rigHandle,
  dolthubOrg,
  name,
  error,
  onBack,
  onJoin,
  onRetry,
}: {
  intent: UpstreamIntent;
  rigHandle: string;
  dolthubOrg: string;
  name: string;
  error: string | null;
  onBack: () => void;
  onJoin: () => void;
  onRetry: () => void;
}) {
  if (intent.kind === 'reuse') {
    // Defensive: the standalone wizard never offers the reuse card.
    return null;
  }
  const upstream = resolveUpstreamFromIntent(intent);
  const slash = upstream.indexOf('/');
  const repo = slash > 0 ? upstream.slice(slash + 1) : upstream;
  const fork = `${dolthubOrg}/${repo}`;
  const isCreate = intent.kind === 'create';

  const heading = isCreate ? 'Confirm new upstream' : 'Confirm fork target';
  const introText = isCreate ? (
    <>
      Bootstrapping <span className="font-mono text-foreground">{upstream}</span> on DoltHub will:
    </>
  ) : (
    <>
      Connecting to <span className="font-mono text-foreground">{upstream}</span> will:
    </>
  );
  const primaryActionLabel = isCreate ? 'Create wasteland' : 'Join wasteland';

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-medium text-foreground">{heading}</h2>
        <p className="text-sm text-muted-foreground">
          Here&apos;s what we&apos;re about to do. Nothing has been written yet.
        </p>
      </div>

      <div className="space-y-4 rounded-lg border border-border bg-card px-5 py-4 text-sm">
        <p className="text-foreground">{introText}</p>
        <ol className="space-y-3 text-muted-foreground">
          {isCreate ? (
            <li className="flex items-start gap-3">
              <GitFork className="mt-0.5 size-4 shrink-0 text-primary/80" />
              <span>
                Create the DoltHub repo{' '}
                <span className="font-mono text-foreground">{upstream}</span> with the wasteland
                schema applied.
              </span>
            </li>
          ) : (
            <li className="flex items-start gap-3">
              <GitFork className="mt-0.5 size-4 shrink-0 text-primary/80" />
              <span>
                Fork the upstream to <span className="font-mono text-foreground">{fork}</span> on
                your DoltHub account.
              </span>
            </li>
          )}
          <li className="flex items-start gap-3">
            <Sparkles className="mt-0.5 size-4 shrink-0 text-primary/80" />
            <span>
              {isCreate ? (
                <>
                  Register your rig <span className="font-mono text-foreground">{rigHandle}</span>{' '}
                  as the first upstream contributor.
                </>
              ) : (
                <>
                  Register your rig <span className="font-mono text-foreground">{rigHandle}</span>{' '}
                  in the upstream via a pull request.
                </>
              )}
            </span>
          </li>
          <li className="flex items-start gap-3">
            <Globe className="mt-0.5 size-4 shrink-0 text-primary/80" />
            <span>
              Set up the wasteland <span className="font-mono text-foreground">{name}</span> in Kilo
              to share the connection.
            </span>
          </li>
        </ol>
        <p className="border-t border-border pt-3 text-xs text-muted-foreground">
          {isCreate
            ? 'You\u2019re the upstream admin from day one. You can invite contributors from wasteland settings.'
            : 'Your fork is yours \u2014 work you do here stays on your fork until you explicitly publish a PR.'}
        </p>
      </div>

      {error && (
        <div className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3">
          <p className="text-sm font-medium text-destructive">We couldn&apos;t finish the setup.</p>
          <p className="text-xs text-destructive/90">{error}</p>
          <p className="text-xs text-muted-foreground">
            {/(^|\s)(401|403)(\s|:|$)/.test(error) || /unauthor|forbidden/i.test(error) ? (
              <>
                If DoltHub rejected the request, try{' '}
                <a
                  href={`https://dolthub.com/repositories/${upstream}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline-offset-4 hover:underline"
                >
                  {isCreate ? 'creating it manually' : 'forking it manually'}
                </a>{' '}
                first, then click Retry.
              </>
            ) : (
              <>Retry will reuse the wasteland record we already created.</>
            )}
          </p>
        </div>
      )}

      <div className="flex items-center justify-between pt-2">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft className="size-4" />
          Back
        </Button>
        {error ? (
          <Button onClick={onRetry} variant="primary">
            Retry
            <ArrowRight className="size-4" />
          </Button>
        ) : (
          <Button onClick={onJoin} variant="primary">
            {primaryActionLabel}
            <ArrowRight className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Step: Work ──────────────────────────────────────────────────────

function WorkStep({
  intent,
  rigHandle,
  dolthubOrg,
}: {
  intent: UpstreamIntent;
  rigHandle: string;
  dolthubOrg: string;
}) {
  const isCreate = intent.kind === 'create';
  const upstream = intent.kind === 'reuse' ? '' : resolveUpstreamFromIntent(intent);
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      <Loader2 className="size-8 animate-spin text-muted-foreground" />
      <p className="text-sm text-foreground">
        {isCreate ? 'Creating the upstream…' : 'Joining the wasteland…'}
      </p>
      <p className="max-w-md text-xs text-muted-foreground">
        {isCreate ? (
          <>
            Bootstrapping <span className="font-mono text-foreground">{upstream}</span> on DoltHub
            and registering rig <span className="font-mono text-foreground">{rigHandle}</span>. This
            usually takes under a minute.
          </>
        ) : (
          <>
            Forking <span className="font-mono text-foreground">{upstream}</span> to{' '}
            <span className="font-mono text-foreground">{dolthubOrg}</span> and registering rig{' '}
            <span className="font-mono text-foreground">{rigHandle}</span>. This usually takes under
            a minute.
          </>
        )}
      </p>
    </div>
  );
}

// ── Step: Success ───────────────────────────────────────────────────

function SuccessStep({
  state,
  intent,
  onDone,
}: {
  state: SuccessState;
  intent: UpstreamIntent;
  onDone: () => void;
}) {
  const { join } = state;
  const isCreate = intent.kind === 'create';
  const upstreamPath = state.upstream ? `/wasteland/${state.upstream}` : state.wastelandPath;
  const dolthubRepoUrl = state.upstream
    ? `https://www.dolthub.com/repositories/${state.upstream}`
    : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <CheckCircle2 className="size-10 text-primary" />
        <div>
          <h2 className="text-lg font-medium text-foreground">
            {join
              ? join.alreadyJoined
                ? 'Already joined'
                : 'Joined the wasteland'
              : isCreate
                ? 'Wasteland created'
                : 'Wasteland created'}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {join
              ? 'Your fork is live and your rig is registered upstream.'
              : isCreate
                ? 'Your DoltHub repo is live and your rig is registered as the first contributor.'
                : 'Wasteland record is in place.'}
          </p>
        </div>
      </div>

      {join && (
        <dl className="space-y-3 rounded-lg border border-border bg-card px-5 py-4 text-sm">
          <div className="flex items-start justify-between gap-3">
            <dt className="text-muted-foreground">Fork</dt>
            <dd className="text-right">
              <a
                href={join.forkUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-mono text-foreground underline-offset-4 hover:underline"
              >
                {join.forkOwner}/{join.forkRepo}
                <ArrowUpRight className="size-3" />
              </a>
            </dd>
          </div>
          <div className="flex items-start justify-between gap-3">
            <dt className="text-muted-foreground">Rig handle</dt>
            <dd className="font-mono text-foreground">{join.rigHandle}</dd>
          </div>
          <div className="flex items-start justify-between gap-3">
            <dt className="text-muted-foreground">Registration PR</dt>
            <dd className="text-right">
              {join.registrationPullUrl ? (
                <a
                  href={join.registrationPullUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                >
                  #{join.registrationPullId}
                  <ArrowUpRight className="size-3" />
                </a>
              ) : (
                <span className="text-xs text-muted-foreground">
                  Not opened — retry from settings if needed.
                </span>
              )}
            </dd>
          </div>
        </dl>
      )}

      {!join && isCreate && dolthubRepoUrl && (
        <dl className="space-y-3 rounded-lg border border-border bg-card px-5 py-4 text-sm">
          <div className="flex items-start justify-between gap-3">
            <dt className="text-muted-foreground">DoltHub repo</dt>
            <dd className="text-right">
              <a
                href={dolthubRepoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-mono text-foreground underline-offset-4 hover:underline"
              >
                {state.upstream}
                <ArrowUpRight className="size-3" />
              </a>
            </dd>
          </div>
        </dl>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
        {state.upstream && (
          <Link
            href={upstreamPath}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-sm text-foreground hover:bg-muted/40"
          >
            Browse the upstream
            <ArrowUpRight className="size-3.5" />
          </Link>
        )}
        <Button onClick={onDone} variant="primary">
          Visit wasteland
          <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

// ── Atoms ────────────────────────────────────────────────────────────

function FieldGroup({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function getNameError(name: string): string | null {
  if (name.length === 0) return null;
  if (name.trim().length === 0) return 'Name cannot be blank';
  if (name.trim().length > NAME_MAX_LENGTH)
    return `Name must be ${NAME_MAX_LENGTH} characters or fewer`;
  return null;
}

function getOrgError(
  ownership: OwnershipType,
  selectedOrgId: string,
  orgs: { organizationId: string; role: string }[] | undefined
): string | null {
  if (ownership !== 'organization') return null;
  if (!selectedOrgId) return 'Please select an organization';
  if (orgs && !orgs.find(o => o.organizationId === selectedOrgId && o.role !== 'billing_manager')) {
    return 'You do not have access to this organization';
  }
  return null;
}

/**
 * Wrapper that provides WastelandTRPCProvider for the form.
 * The provider is not available at the /wasteland/new layout level
 * (it's only in [wastelandId]/layout.tsx), so we set it up here.
 */
export function NewWastelandWizardClient({ lockedOrgId }: { lockedOrgId?: string }) {
  const queryClient = useQueryClient();
  const [trpcClient] = useState(() => createWastelandTRPCClient());

  return (
    <WastelandTRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
      <NewWastelandWizardForm lockedOrgId={lockedOrgId} />
    </WastelandTRPCProvider>
  );
}
