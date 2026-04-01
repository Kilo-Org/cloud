'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

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

const DOLTHUB_UPSTREAM_PATTERN = /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/;
const NAME_MAX_LENGTH = 100;

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
  const [dolthubUpstream, setDolthubUpstream] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('private');

  const orgsQuery = useQuery(mainTrpc.organizations.list.queryOptions());

  const createMutation = useMutation(
    trpc.wasteland.createWasteland.mutationOptions({
      onSuccess: (data) => {
        router.push(`/wasteland/${data.wasteland_id}`);
      },
      onError: (err) => {
        toast.error(err.message);
      },
    })
  );

  // Validation
  const nameError = getNameError(name);
  const dolthubError = getDolthubError(dolthubUpstream);
  const orgError = getOrgError(ownership, selectedOrgId, orgsQuery.data);

  const isValid = !nameError && !dolthubError && !orgError && name.trim().length > 0;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid || createMutation.isPending) return;

    createMutation.mutate({
      name: name.trim(),
      ownerType: ownership === 'organization' ? 'org' : 'user',
      organizationId: ownership === 'organization' ? selectedOrgId : undefined,
      dolthubUpstream: dolthubUpstream.trim() || undefined,
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
            onChange={(e) => setName(e.target.value)}
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
            onValueChange={(v) => {
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
              <RadioGroupItem
                value="organization"
                id="ownership-org"
                disabled={!!lockedOrgId}
              />
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
                    {orgsQuery.data?.find((o) => o.organizationId === lockedOrgId)
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
                      ?.filter((o) => o.role !== 'billing_manager')
                      .map((org) => (
                        <SelectItem key={org.organizationId} value={org.organizationId}>
                          {org.organizationName}
                        </SelectItem>
                      ))}
                    {orgsQuery.data && orgsQuery.data.filter((o) => o.role !== 'billing_manager').length === 0 && (
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

        {/* DoltHub Upstream */}
        <div className="space-y-2">
          <Label htmlFor="dolthub-upstream">
            DoltHub upstream{' '}
            <span className="text-muted-foreground font-normal">(optional)</span>
          </Label>
          <Input
            id="dolthub-upstream"
            placeholder="org/repo"
            value={dolthubUpstream}
            onChange={(e) => setDolthubUpstream(e.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            The DoltHub repository path. Can be configured later in settings.
          </p>
          {dolthubError && <p className="text-destructive text-xs">{dolthubError}</p>}
        </div>

        {/* Visibility */}
        <div className="space-y-2">
          <Label>Visibility</Label>
          <RadioGroup
            value={visibility}
            onValueChange={(v) => setVisibility(v as Visibility)}
          >
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
  if (name.trim().length > NAME_MAX_LENGTH) return `Name must be ${NAME_MAX_LENGTH} characters or fewer`;
  return null;
}

function getDolthubError(value: string): string | null {
  if (!value.trim()) return null;
  if (!DOLTHUB_UPSTREAM_PATTERN.test(value.trim())) {
    return 'Must be in the format org/repo';
  }
  return null;
}

function getOrgError(
  ownership: OwnershipType,
  selectedOrgId: string,
  orgs: { organizationId: string; role: string }[] | undefined
): string | null {
  if (ownership !== 'organization') return null;
  if (!selectedOrgId) return 'Please select an organization';
  if (orgs && !orgs.find((o) => o.organizationId === selectedOrgId && o.role !== 'billing_manager')) {
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
