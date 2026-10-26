import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import {
  briefingAccessDenied,
  canReadBriefingContext,
  readableBriefingOrganizationIds,
} from '@/lib/agent-briefing-state';
import {
  BRIEFING_DISMISSALS_KEY,
  type BriefingDismissal,
  readBriefingDismissals,
} from '@/lib/agent-briefing-dismissals';
import { useAuth } from '@/lib/auth/auth-context';
import { isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive } from '@/lib/auth/sign-out-state';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { getResolvedLanguage } from '@/lib/hooks/use-language-preference';
import { useOrganizationsList } from '@/lib/hooks/use-organizations-list';
import { dateTimeFormat } from '@/lib/intl-cache';
import { readCacheScope } from '@/lib/persist/cache-scope';
import * as encryptedKv from '@/lib/persist/encrypted-kv';
import { useTRPC } from '@/lib/trpc';

export type BriefingReport = inferRouterOutputs<MobileRouter>['agentBriefing']['get'];
export type BriefingPreferences = inferRouterOutputs<MobileRouter>['agentBriefing']['preferences'];
export const BRIEFING_PATH = '/(app)/agent-briefing' as const;

export function useBriefingAccess() {
  const { token, isSigningOut } = useAuth();
  const memberships = useOrganizationsList();
  const enabled = token != null && !isSigningOut;
  const organizationIds = briefingAccessDenied(memberships.error)
    ? []
    : readableBriefingOrganizationIds(memberships.data ?? []);
  return {
    enabled,
    canRead: (organizationId: string | null) =>
      canReadBriefingContext(organizationId, enabled, organizationIds),
  };
}

export function useBriefings(organizationId: string | null) {
  const trpc = useTRPC();
  const access = useBriefingAccess();
  const query = useQuery({
    ...trpc.agentBriefing.list.queryOptions({
      scope: organizationId === null ? 'personal' : 'organization',
      organizationId: organizationId ?? undefined,
      currentOnly: true,
      limit: 1,
    }),
    enabled: access.canRead(organizationId),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
  useBriefingInvalidation(query.error);
  return {
    ...query,
    reports: briefingAccessDenied(query.error)
      ? []
      : (query.data?.reports.filter(report => access.canRead(report.context.organizationId)) ?? []),
  };
}

export function useBriefingDismissals() {
  const client = useQueryClient();
  const { userId } = useCurrentUserId();
  const { authEpoch } = useAuth();
  const queryKey = [BRIEFING_DISMISSALS_KEY, userId] as const;
  const query = useQuery({
    queryKey,
    enabled: Boolean(userId) && !isSignOutActive(),
    networkMode: 'always',
    staleTime: Infinity,
    queryFn: async () => {
      if (!userId) {
        return [];
      }
      const dismissals = await readBriefingDismissals(userId, authEpoch);
      return dismissals;
    },
  });
  const save = useMutation({
    networkMode: 'always',
    mutationFn: async (items: BriefingDismissal[]) => {
      if (!userId || !isCurrentAuthEpoch(authEpoch) || isSignOutActive()) {
        return;
      }
      await encryptedKv.setItem(
        readCacheScope(userId),
        BRIEFING_DISMISSALS_KEY,
        JSON.stringify(items)
      );
      if (!isCurrentAuthEpoch(authEpoch) || isSignOutActive()) {
        await encryptedKv.removeItem(readCacheScope(userId), BRIEFING_DISMISSALS_KEY);
      }
    },
    onMutate: async items => {
      await client.cancelQueries({ queryKey });
      const previous = client.getQueryData<BriefingDismissal[]>(queryKey);
      client.setQueryData(queryKey, items);
      return { previous };
    },
    onError: (_error, _items, context) => {
      client.setQueryData(queryKey, context?.previous);
      toast.error(i18n.t('common.couldNotSaveSetting'));
    },
  });
  return {
    ...query,
    save,
    dismiss: (report: BriefingReport) => {
      save.mutate([
        ...(client.getQueryData<BriefingDismissal[]>(queryKey) ?? []).filter(
          item => item.reportId !== report.id
        ),
        {
          reportId: report.id,
          organizationId: report.context.organizationId,
          expiresAt: new Date(
            Date.parse(report.morningEndAt) + 30 * 24 * 60 * 60 * 1000
          ).toISOString(),
          synced: false,
        },
      ]);
    },
  };
}

export function useBriefingPreferences(readOnly = false) {
  const trpc = useTRPC();
  const access = useBriefingAccess();
  const input = {
    timezone: dateTimeFormat(undefined, {}).resolvedOptions().timeZone,
    language: getResolvedLanguage(),
  };
  const options = readOnly
    ? trpc.agentBriefing.oneOffPreferences.queryOptions(input)
    : trpc.agentBriefing.preferences.queryOptions(input);
  return useQuery({
    ...options,
    enabled: access.enabled,
    staleTime: 60_000,
  });
}

export function useBriefingInvalidation(error: unknown) {
  const client = useQueryClient();
  const trpc = useTRPC();
  const { userId } = useCurrentUserId();
  useEffect(() => {
    if (!briefingAccessDenied(error)) {
      return;
    }
    client.removeQueries({ queryKey: trpc.agentBriefing.pathKey() });
    if (userId) {
      void (async () => {
        try {
          await encryptedKv.removeItem(readCacheScope(userId), 'read-cache');
        } catch {
          toast.error(i18n.t('common.couldNotSaveSetting'));
        }
      })();
    }
  }, [client, error, trpc, userId]);
}
