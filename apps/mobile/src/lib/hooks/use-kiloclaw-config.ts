import { useQuery } from '@tanstack/react-query';

import { resolveContext } from '@/lib/hooks/use-context-query';
import { useTRPC } from '@/lib/trpc';

export function useKiloClawGoogleSetup(organizationId?: string | null, enabled = true) {
  const trpc = useTRPC();
  const { isOrg, personalEnabled, orgEnabled, orgInput } = resolveContext(organizationId, enabled);
  const personal = useQuery(
    trpc.kiloclaw.getGoogleSetupCommand.queryOptions(undefined, {
      enabled: personalEnabled,
      staleTime: 50 * 60_000,
    })
  );
  const org = useQuery(
    trpc.organizations.kiloclaw.getGoogleSetupCommand.queryOptions(orgInput, {
      enabled: orgEnabled,
      staleTime: 50 * 60_000,
    })
  );
  return isOrg ? org : personal;
}

export function useKiloClawChannelCatalog(organizationId?: string | null) {
  const trpc = useTRPC();
  const { isOrg, personalEnabled, orgEnabled, orgInput } = resolveContext(organizationId);
  const personal = useQuery(
    trpc.kiloclaw.getChannelCatalog.queryOptions(undefined, {
      enabled: personalEnabled,
      staleTime: 5 * 60_000,
    })
  );
  const org = useQuery(
    trpc.organizations.kiloclaw.getChannelCatalog.queryOptions(orgInput, {
      enabled: orgEnabled,
      staleTime: 5 * 60_000,
    })
  );
  return isOrg ? org : personal;
}

export function useKiloClawSecretCatalog(organizationId?: string | null) {
  const trpc = useTRPC();
  const { isOrg, personalEnabled, orgEnabled, orgInput } = resolveContext(organizationId);
  const personal = useQuery(
    trpc.kiloclaw.getSecretCatalog.queryOptions(undefined, {
      enabled: personalEnabled,
      staleTime: 5 * 60_000,
    })
  );
  const org = useQuery(
    trpc.organizations.kiloclaw.getSecretCatalog.queryOptions(orgInput, {
      enabled: orgEnabled,
      staleTime: 5 * 60_000,
    })
  );
  return isOrg ? org : personal;
}

export function useStreamChatCredentials(organizationId?: string | null, enabled = true) {
  const trpc = useTRPC();
  const { isOrg, personalEnabled, orgEnabled, orgInput } = resolveContext(organizationId, enabled);
  const personal = useQuery(
    trpc.kiloclaw.getStreamChatCredentials.queryOptions(undefined, {
      enabled: personalEnabled,
      staleTime: 5 * 60_000,
    })
  );
  const org = useQuery(
    trpc.organizations.kiloclaw.getStreamChatCredentials.queryOptions(orgInput, {
      enabled: orgEnabled,
      staleTime: 5 * 60_000,
    })
  );
  return isOrg ? org : personal;
}

export function useKiloClawConfig(organizationId?: string | null) {
  const trpc = useTRPC();
  const { isOrg, personalEnabled, orgEnabled, orgInput } = resolveContext(organizationId);
  const personal = useQuery(
    trpc.kiloclaw.getConfig.queryOptions(undefined, {
      enabled: personalEnabled,
      staleTime: 60_000,
    })
  );
  const org = useQuery(
    trpc.organizations.kiloclaw.getConfig.queryOptions(orgInput, {
      enabled: orgEnabled,
      staleTime: 60_000,
    })
  );
  return isOrg ? org : personal;
}
