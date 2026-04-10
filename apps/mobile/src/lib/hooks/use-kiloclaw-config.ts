import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/lib/trpc';

function orgInput(organizationId?: string | null) {
  return { organizationId: organizationId ?? '' };
}

export function useKiloClawGoogleSetup(organizationId?: string | null, enabled = true) {
  const trpc = useTRPC();
  const isOrg = Boolean(organizationId);
  const personal = useQuery(
    trpc.kiloclaw.getGoogleSetupCommand.queryOptions(undefined, {
      enabled: enabled && !isOrg,
      staleTime: 50 * 60_000,
    })
  );
  const org = useQuery(
    trpc.organizations.kiloclaw.getGoogleSetupCommand.queryOptions(orgInput(organizationId), {
      enabled: enabled && isOrg,
      staleTime: 50 * 60_000,
    })
  );
  return isOrg ? org : personal;
}

export function useKiloClawChannelCatalog(organizationId?: string | null) {
  const trpc = useTRPC();
  const isOrg = Boolean(organizationId);
  const personal = useQuery(
    trpc.kiloclaw.getChannelCatalog.queryOptions(undefined, {
      enabled: !isOrg,
      staleTime: 5 * 60_000,
    })
  );
  const org = useQuery(
    trpc.organizations.kiloclaw.getChannelCatalog.queryOptions(orgInput(organizationId), {
      enabled: isOrg,
      staleTime: 5 * 60_000,
    })
  );
  return isOrg ? org : personal;
}

export function useKiloClawSecretCatalog(organizationId?: string | null) {
  const trpc = useTRPC();
  const isOrg = Boolean(organizationId);
  const personal = useQuery(
    trpc.kiloclaw.getSecretCatalog.queryOptions(undefined, {
      enabled: !isOrg,
      staleTime: 5 * 60_000,
    })
  );
  const org = useQuery(
    trpc.organizations.kiloclaw.getSecretCatalog.queryOptions(orgInput(organizationId), {
      enabled: isOrg,
      staleTime: 5 * 60_000,
    })
  );
  return isOrg ? org : personal;
}

export function useStreamChatCredentials(organizationId?: string | null, enabled = true) {
  const trpc = useTRPC();
  const isOrg = Boolean(organizationId);
  const personal = useQuery(
    trpc.kiloclaw.getStreamChatCredentials.queryOptions(undefined, {
      enabled: enabled && !isOrg,
      staleTime: 5 * 60_000,
    })
  );
  const org = useQuery(
    trpc.organizations.kiloclaw.getStreamChatCredentials.queryOptions(orgInput(organizationId), {
      enabled: enabled && isOrg,
      staleTime: 5 * 60_000,
    })
  );
  return isOrg ? org : personal;
}

export function useKiloClawConfig(organizationId?: string | null) {
  const trpc = useTRPC();
  const isOrg = Boolean(organizationId);
  const personal = useQuery(
    trpc.kiloclaw.getConfig.queryOptions(undefined, { enabled: !isOrg, staleTime: 60_000 })
  );
  const org = useQuery(
    trpc.organizations.kiloclaw.getConfig.queryOptions(orgInput(organizationId), {
      enabled: isOrg,
      staleTime: 60_000,
    })
  );
  return isOrg ? org : personal;
}
