import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import {
  briefingAccessDenied,
  useBriefingDismissals,
  useBriefingInvalidation,
  useBriefingPreferences,
} from '@/lib/agent-briefing';
import { readableBriefingOrganizationIds } from '@/lib/agent-briefing-state';
import { purgeInaccessibleBriefingCache } from '@/lib/agent-briefing-cache';
import { type BriefingDismissal } from '@/lib/agent-briefing-dismissals';
import { useAuth } from '@/lib/auth/auth-context';
import { isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { useAppLifecycle } from '@/lib/hooks/use-app-lifecycle';
import { useOfflineBannerState } from '@/lib/hooks/use-offline-banner-state';
import { useOrganizationsList } from '@/lib/hooks/use-organizations-list';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useTRPC } from '@/lib/trpc';

export function BriefingSyncMount() {
  const trpc = useTRPC();
  const client = useQueryClient();
  const { authEpoch, isSigningOut } = useAuth();
  const { userId } = useCurrentUserId();
  const { isActive } = useAppLifecycle();
  const offline = useOfflineBannerState();
  const preferences = useBriefingPreferences();
  useBriefingInvalidation(preferences.error);
  const { data, save } = useBriefingDismissals();
  const { mutateAsync: saveJournal, isPending: savingJournal } = save;
  const memberships = useOrganizationsList();
  const running = useRef(false);
  const { mutateAsync: dismiss } = useMutation(
    trpc.agentBriefing.dismiss.mutationOptions({
      onError: () => {
        toast.error(i18n.t('common.couldNotSaveSetting'));
      },
    })
  );

  useEffect(() => {
    if (!memberships.isSuccess || !userId || isSigningOut) {
      return;
    }
    const organizationIds = readableBriefingOrganizationIds(memberships.data);
    void (async () => {
      try {
        await purgeInaccessibleBriefingCache(client, { userId, authEpoch }, organizationIds);
      } catch {
        toast.error(i18n.t('common.couldNotSaveSetting'));
      }
    })();
  }, [authEpoch, client, isSigningOut, memberships.data, memberships.isSuccess, userId]);

  useEffect(() => {
    if (running.current || savingJournal || offline || !isActive || isSigningOut || !data) {
      return;
    }
    const pending = data.filter(item => !item.synced && Date.parse(item.expiresAt) > Date.now());
    if (pending.length === 0) {
      return;
    }
    running.current = true;
    async function syncNextDismissal(): Promise<void> {
      const latest =
        client.getQueryData<BriefingDismissal[]>(['agent-briefing-dismissals', userId]) ?? [];
      const item = latest.find(entry => !entry.synced && Date.parse(entry.expiresAt) > Date.now());
      if (!item || !isCurrentAuthEpoch(authEpoch)) {
        return;
      }
      try {
        await dismiss({ reportId: item.reportId });
      } catch (error) {
        if (!briefingAccessDenied(error)) {
          return;
        }
      }
      if (!isCurrentAuthEpoch(authEpoch)) {
        return;
      }
      const current =
        client.getQueryData<BriefingDismissal[]>(['agent-briefing-dismissals', userId]) ?? [];
      const settled = current.map(entry =>
        entry.reportId === item.reportId
          ? {
              reportId: entry.reportId,
              organizationId: entry.organizationId,
              expiresAt: entry.expiresAt,
              synced: true,
            }
          : entry
      );
      await saveJournal(settled);
      await syncNextDismissal();
    }
    void (async () => {
      try {
        await syncNextDismissal();
        await client.invalidateQueries({ queryKey: trpc.agentBriefing.list.pathKey() });
      } catch {
        // The journal mutation reports storage errors and retains the pending dismissal.
      } finally {
        running.current = false;
      }
    })();
  }, [
    authEpoch,
    client,
    data,
    dismiss,
    isActive,
    isSigningOut,
    offline,
    saveJournal,
    savingJournal,
    trpc,
    userId,
  ]);

  useEffect(() => {
    if (isActive && !offline) {
      void client.invalidateQueries({ queryKey: trpc.agentBriefing.pathKey() });
    }
  }, [client, isActive, offline, trpc]);

  return null;
}
