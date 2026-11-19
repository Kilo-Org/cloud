import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import {
  useBriefingDismissals,
  useBriefingInvalidation,
  useBriefingPreferences,
} from '@/lib/agent-briefing';
import {
  briefingAccessDenied,
  briefingReportMissing,
  briefingSyncDelayMs,
  readableBriefingOrganizationIds,
} from '@/lib/agent-briefing-state';
import { purgeInaccessibleBriefingCache } from '@/lib/agent-briefing-cache';
import { type BriefingDismissal } from '@/lib/agent-briefing-dismissals';
import { useAuth } from '@/lib/auth/auth-context';
import { isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { useAppLifecycle } from '@/lib/hooks/use-app-lifecycle';
import { useSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { useOfflineBannerState } from '@/lib/hooks/use-offline-banner-state';
import { useOrganizationsList } from '@/lib/hooks/use-organizations-list';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useTRPC } from '@/lib/trpc';

/** The dismissal drain could not finish a step; the ladder owns the retry. */
type DrainFailure = { readonly kind: 'sync-failed' };

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
  const { feedback: drainPhase, begin: beginDrain } = useSurfaceFeedback<DrainFailure>();
  const [failures, setFailures] = useState(0);
  // Hidden briefs whose failed dismissal the user already heard about. The
  // background retry ladder owns the recovery, so each report gets one
  // announcement, not one per attempt.
  const announcedDismissFailures = useRef<Set<string>>(new Set());
  const { mutateAsync: dismiss } = useMutation(trpc.agentBriefing.dismiss.mutationOptions({}));

  useEffect(() => {
    if (!memberships.isSuccess || !userId || isSigningOut) {
      return;
    }
    const organizationIds = readableBriefingOrganizationIds(memberships.data);
    void (async () => {
      try {
        await purgeInaccessibleBriefingCache(client, { userId, authEpoch }, organizationIds);
      } catch {
        // Best-effort cleanup; the preferences refetch already shows its own
        // error state, so a failed purge adds nothing the user can act on.
      }
    })();
  }, [authEpoch, client, isSigningOut, memberships.data, memberships.isSuccess, userId]);

  useEffect(() => {
    setFailures(0);
  }, [isActive, offline, userId, authEpoch]);

  useEffect(() => {
    if (
      drainPhase.status === 'pending' ||
      savingJournal ||
      offline ||
      !isActive ||
      isSigningOut ||
      !data
    ) {
      return undefined;
    }
    const pending = data.filter(item => !item.synced && Date.parse(item.expiresAt) > Date.now());
    const delay = briefingSyncDelayMs(failures);
    if (pending.length === 0 || delay === null) {
      return undefined;
    }
    /**
     * Post the next pending dismissal and the journal entry it settles.
     * `retry` is every unsuccessful server attempt — a rejected dismissal and a
     * failed journal write both advance the ladder — while a denial or a report
     * that is gone is dropped locally, as it always was. The failed report id
     * keys the once-per-report announcement below.
     */
    async function drainOnce(): Promise<
      'posted' | { kind: 'retry'; reportId: string } | 'neutral'
    > {
      const latest =
        client.getQueryData<BriefingDismissal[]>(['agent-briefing-dismissals', userId]) ?? [];
      const item = latest.find(entry => !entry.synced && Date.parse(entry.expiresAt) > Date.now());
      if (!item || !isCurrentAuthEpoch(authEpoch)) {
        return 'neutral';
      }
      try {
        await dismiss({ reportId: item.reportId });
      } catch (error) {
        if (!briefingAccessDenied(error) && !briefingReportMissing(error)) {
          return { kind: 'retry', reportId: item.reportId };
        }
      }
      if (!isCurrentAuthEpoch(authEpoch)) {
        return 'neutral';
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
      try {
        await saveJournal(settled);
      } catch {
        return { kind: 'retry', reportId: item.reportId };
      }
      return 'posted';
    }
    const timer = setTimeout(() => {
      const attempt = beginDrain();
      if (attempt === null) {
        return;
      }
      void (async () => {
        const outcome = await drainOnce();
        if (outcome === 'posted') {
          setFailures(0);
          attempt.succeed();
        } else if (outcome !== 'neutral') {
          setFailures(count => count + 1);
          attempt.fail({ kind: 'sync-failed' });
          if (!announcedDismissFailures.current.has(outcome.reportId)) {
            announcedDismissFailures.current.add(outcome.reportId);
            toast.error(i18n.t('agentBriefing.dismissFailed'));
          }
          return;
        } else {
          attempt.abandon();
        }
        // The settled list already reached the cache through the journal's
        // optimistic write; this only refreshes the server's view of it.
        await client.invalidateQueries({ queryKey: trpc.agentBriefing.list.pathKey() });
      })();
    }, delay);
    return () => {
      clearTimeout(timer);
    };
  }, [
    authEpoch,
    beginDrain,
    client,
    data,
    dismiss,
    drainPhase.status,
    failures,
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
