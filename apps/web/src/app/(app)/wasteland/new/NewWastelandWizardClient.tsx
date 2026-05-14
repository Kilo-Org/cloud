'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Info, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  createWastelandTRPCClient,
} from '@/lib/wasteland/trpc';
import {
  UpstreamIntentPicker,
  isUpstreamIntentValid,
  resolveUpstreamFromIntent,
  useUpstreamVerification,
  type UpstreamIntent,
} from '@/components/wasteland/UpstreamIntent';

const NAME_MAX_LENGTH = 128;

type OwnershipType = 'personal' | 'organization';
type Visibility = 'public' | 'private';

type NewWastelandWizardFormProps = {
  /** When set, the form is accessed from an org-scoped route and ownership is locked. */
  lockedOrgId?: string;
};

function NewWastelandWizardForm({ lockedOrgId }: NewWastelandWizardFormProps) {
  const router = useRouter();
  const trpc = useWastelandTRPC();
  const mainTrpc = useTRPC();

  const [name, setName] = useState('');
  const [ownership, setOwnership] = useState<OwnershipType>(
    lockedOrgId ? 'organization' : 'personal'
  );
  const [selectedOrgId, setSelectedOrgId] = useState<string>(lockedOrgId ?? '');
  const [intent, setIntent] = useState<UpstreamIntent>({
    kind: 'commons',
    isUpstreamAdmin: false,
  });
  const [visibility, setVisibility] = useState<Visibility>('private');

  const orgsQuery = useQuery(mainTrpc.organizations.list.queryOptions());

  // Empty `selectedOrgId` (the placeholder before the user picks an
  // org) is coerced to `undefined` so we don't ship `''` through the
  // Zod uuid check on the verify / resolveUsername procedures.
  const verifyOrgId = ownership === 'organization' ? selectedOrgId || undefined : undefined;

  // Pre-resolve the DoltHub username when the OAuth integration is
  // installed so Card 3's input prefills as `<username>/...`. Best-effort
  // — the picker still works without it.
  const dolthubUsernameQuery = useQuery({
    ...mainTrpc.dolthub.resolveUsername.queryOptions(
      verifyOrgId ? { organizationId: verifyOrgId } : undefined
    ),
    // No need to refetch on focus — the username doesn't change mid-session.
    staleTime: Infinity,
  });

  // Verify the typed upstream against DoltHub. Reused so the submit
  // button refuses to advance while the probe is pending, or when the
  // result contradicts the intent (`connect` needs exists=true,
  // `create` needs exists=false).
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

  const createMutation = useMutation(
    trpc.wasteland.createWasteland.mutationOptions({
      onSuccess: data => {
        const wastelandPath = lockedOrgId
          ? `/organizations/${lockedOrgId}/wasteland/${data.wasteland_id}`
          : `/wasteland/${data.wasteland_id}`;
        // For the `create` intent we don't have credentials yet — surface
        // a one-time toast pointing the user to the settings page where
        // the OAuth-connect + createUpstream flow lives.
        if (intent.kind === 'create') {
          toast.message(
            'Wasteland created. Connect DoltHub on the settings page to bootstrap the upstream.',
            {
              duration: 8000,
            }
          );
        }
        router.push(wastelandPath);
      },
      onError: err => {
        toast.error(err.message);
      },
    })
  );

  // Validation
  const nameError = getNameError(name);
  const orgError = getOrgError(ownership, selectedOrgId, orgsQuery.data);
  const intentValid = isUpstreamIntentValid(intent);
  // For `connect` we need the upstream to exist (so the wasteland points at
  // a real repo); for `create` we need it NOT to exist (otherwise the
  // eventual `createUpstream` will fail with "repository already exists"
  // when the user wires up credentials from the settings page).
  const upstreamProbeBlocked =
    (intent.kind === 'connect' &&
      (connectVerification.status === 'pending' || connectVerification.status === 'missing')) ||
    (intent.kind === 'create' &&
      (createVerification.status === 'pending' || createVerification.status === 'exists'));

  const isValid =
    !nameError && !orgError && intentValid && !upstreamProbeBlocked && name.trim().length > 0;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid || createMutation.isPending) return;

    createMutation.mutate({
      name: name.trim(),
      ownerType: ownership === 'organization' ? 'org' : 'user',
      organizationId: ownership === 'organization' ? selectedOrgId : undefined,
      dolthubUpstream: resolveUpstreamFromIntent(intent),
      visibility,
    });
  }

  return (
    <div className="mx-auto w-full max-w-lg py-12 px-4">
      <h1 className="text-2xl font-bold tracking-tight mb-2">Create a new Wasteland</h1>
      <p className="text-muted-foreground text-sm mb-8">
        A Wasteland is a hosted bounty board powered by DoltHub.
      </p>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Name */}
        <div className="space-y-2">
          <Label htmlFor="wasteland-name">Name</Label>
          <Input
            id="wasteland-name"
            placeholder="My Wasteland"
            value={name}
            onChange={e => setName(e.target.value)}
            maxLength={NAME_MAX_LENGTH}
            autoFocus
          />
          {nameError && <p className="text-destructive text-xs">{nameError}</p>}
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
              <Label htmlFor="ownership-personal" className="font-normal cursor-pointer">
                Personal
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="organization" id="ownership-org" disabled={!!lockedOrgId} />
              <Label htmlFor="ownership-org" className="font-normal cursor-pointer">
                Organization
              </Label>
            </div>
          </RadioGroup>

          {ownership === 'organization' && (
            <div className="mt-2">
              {lockedOrgId ? (
                <p className="text-sm text-muted-foreground">
                  Organization:{' '}
                  <span className="text-foreground font-medium">
                    {orgsQuery.data?.find(o => o.organizationId === lockedOrgId)
                      ?.organizationName ?? lockedOrgId}
                  </span>
                </p>
              ) : (
                <Select value={selectedOrgId} onValueChange={setSelectedOrgId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select an organization" />
                  </SelectTrigger>
                  <SelectContent>
                    {orgsQuery.isLoading && (
                      <SelectItem value="__loading" disabled>
                        Loading...
                      </SelectItem>
                    )}
                    {orgsQuery.data
                      ?.filter(o => o.role !== 'billing_manager')
                      .map(org => (
                        <SelectItem key={org.organizationId} value={org.organizationId}>
                          {org.organizationName}
                        </SelectItem>
                      ))}
                    {orgsQuery.data &&
                      orgsQuery.data.filter(o => o.role !== 'billing_manager').length === 0 && (
                        <SelectItem value="__none" disabled>
                          No organizations available
                        </SelectItem>
                      )}
                  </SelectContent>
                </Select>
              )}
              {orgError && <p className="text-destructive text-xs mt-1">{orgError}</p>}
            </div>
          )}
        </div>

        {/* DoltHub upstream */}
        <div className="space-y-2">
          <Label>DoltHub upstream</Label>
          <UpstreamIntentPicker
            value={intent}
            onChange={setIntent}
            organizationId={ownership === 'organization' ? selectedOrgId || undefined : undefined}
            dolthubUsername={dolthubUsernameQuery.data?.username ?? null}
            disabled={createMutation.isPending}
          />
          {intent.kind === 'create' && (
            <div className="flex items-start gap-2 rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[11px] text-white/55">
              <Info className="mt-0.5 size-3 shrink-0 text-white/35" />
              <span>
                We&apos;ll save this intent on your wasteland. Connect DoltHub on the settings page
                to actually bootstrap the upstream.
              </span>
            </div>
          )}
        </div>

        {/* Visibility */}
        <div className="space-y-2">
          <Label>Visibility</Label>
          <RadioGroup value={visibility} onValueChange={v => setVisibility(v as Visibility)}>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="private" id="visibility-private" />
              <Label htmlFor="visibility-private" className="font-normal cursor-pointer">
                Private
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="public" id="visibility-public" />
              <Label htmlFor="visibility-public" className="font-normal cursor-pointer">
                Public
              </Label>
            </div>
          </RadioGroup>
        </div>

        {/* Submit */}
        <Button
          type="submit"
          variant="primary"
          className="w-full"
          disabled={!isValid || createMutation.isPending}
        >
          {createMutation.isPending ? (
            <>
              <Loader2 className="animate-spin" />
              Creating...
            </>
          ) : (
            'Create Wasteland'
          )}
        </Button>
      </form>
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
