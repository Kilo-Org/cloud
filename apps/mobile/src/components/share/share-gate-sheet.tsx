/* eslint-disable max-lines -- Share gate owns commit, destination admission, and CLI-spawn orchestration in one formSheet body. */
import { useQuery } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { GitPullRequest, Plus, X } from '@/components/ui/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, View } from 'react-native';
import { toast } from 'sonner-native';

import {
  getAgentSessionPath,
  getSpawnedAgentSessionPath,
} from '@/components/agents/session-detail-routes';
import { expandPlatformFilter } from '@/components/agents/session-list-helpers';
import { getNewAgentSessionPath } from '@/components/agents/session-list-routes';
import { DestinationOptionRow } from '@/components/destination-option-row';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { FEATURE_FLAG_PR_REVIEW, useFeatureFlag } from '@/lib/analytics/posthog';
import { useAgentSessions } from '@/lib/hooks/use-agent-sessions';
import { useRemoteInstanceSpawn } from '@/lib/hooks/use-remote-instance-spawn';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useOrganization } from '@/lib/organization-context';
import { useHoistedOperationKey } from '@/lib/operation-key';
import { getPrReviewPath } from '@/lib/profile-agent-navigation';
import { resolveRemoteSubmitOutcome } from '@/lib/remote-submit-outcome';
import { appendShareParams, setPendingShareNavigation } from '@/lib/share-navigation';
import { clearSharePayload, peekSharePayload, type ShareId } from '@/lib/share-payload';
import { shouldShowRunOnSelector } from '@/lib/should-show-run-on-selector';
import { useTRPC } from '@/lib/trpc';

import {
  resolveShareDestinationAdmission,
  resolveShareHasFiles,
  type ShareDestinationAdmission,
} from './share-cli-admission';
import {
  selectShareCliSpawnRows,
  type ShareCliSpawnRow,
  shouldCommitShareSpawnReady,
} from './share-cli-spawn';
import { selectShareDestinations, type ShareDestinationRow } from './share-destinations';
import { ShareDestinationList } from './share-destination-list';
import { isShareCommitEnabled, selectShareGateState } from './share-gate-state';
import { SharePayloadPreview } from './share-payload-preview';
import { type SharePayloadValidation, validateSharePayload } from './share-payload-validation';
import { selectShareReviewPr } from './share-review-pr';

type ShareGateSheetProps = {
  shareId: string | undefined;
};

/**
 * Share gate formSheet body. Exactly two direct children of the screen
 * content: a collapsable={false} header block and the FlatList.
 */
export function ShareGateSheet({ shareId }: Readonly<ShareGateSheetProps>) {
  const router = useRouter();
  const colors = useThemeColors();
  const trpc = useTRPC();
  const { organizationId, isLoaded: orgLoaded } = useOrganization();
  // Org-scoped stored page only (cloud-agent + cli). Active list is an
  // id/capability lookup — never a row source.
  const sessions = useAgentSessions({
    createdOnPlatform: expandPlatformFilter(['cloud-agent', 'cli']),
    organizationId,
    enabled: orgLoaded,
  });

  const { spawn } = useRemoteInstanceSpawn();
  const [spawningConnectionId, setSpawningConnectionId] = useState<string | null>(null);
  // P1-A-08b: one `operationKey` per share-spawn intent (share + instance), so
  // a retryable failure keeps the key and the relay dedupes the retry.
  const { getKey, rotateKey } = useHoistedOperationKey();
  // Per-attempt token so a stale spawn's finally cannot clear a newer lock
  // (share replace mid-flight, or same-connection re-tap after replace).
  const spawnAttemptRef = useRef(0);
  const isSpawning = spawningConnectionId !== null;

  const { data: instancesData, refetch: refetchInstances } = useQuery({
    ...trpc.activeSessions.listInstances.queryOptions(undefined, {
      refetchOnWindowFocus: true,
      staleTime: 5000,
    }),
    enabled: orgLoaded && shouldShowRunOnSelector(organizationId),
  });

  // Committed id survives param replace + dismiss animation; only that id
  // is exempt from clear on param change / unmount.
  const committedShareIdRef = useRef<ShareId | null>(null);
  // Track the shareId this instance owns so unmount clears only that id.
  const ownedShareIdRef = useRef(shareId);
  const previousShareIdRef = useRef(shareId);
  ownedShareIdRef.current = shareId;

  // When S1 replaces an open gate with a newer shareId, clear the older id
  // only if it was not committed. A committed previous id must survive the
  // dismiss animation while a newer shareId is focused. Also drop the spawn
  // lock so a stale in-flight spawn cannot leave the new gate's commit
  // affordances disabled until it settles.
  useEffect(() => {
    const previous = previousShareIdRef.current;
    if (previous && previous !== shareId) {
      if (previous !== committedShareIdRef.current) {
        clearSharePayload(previous);
      }
      setSpawningConnectionId(null);
    }
    previousShareIdRef.current = shareId;
  }, [shareId]);

  const payload = useMemo(() => (shareId ? peekSharePayload(shareId) : null), [shareId]);

  const [validation, setValidation] = useState<SharePayloadValidation | null>(null);

  useEffect(() => {
    let cancelled = false;
    setValidation(null);

    async function run(): Promise<void> {
      if (!payload) {
        return;
      }
      const result = await validateSharePayload(payload);
      if (!cancelled) {
        setValidation(result);
      }
    }

    void run();

    return () => {
      cancelled = true;
    };
  }, [payload, shareId]);

  const destinations = useMemo(
    () => selectShareDestinations(sessions.storedSessions, sessions.activeSessionIds),
    [sessions.storedSessions, sessions.activeSessionIds]
  );

  const attachmentsCapableBySessionId = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const session of sessions.activeSessions) {
      map.set(session.id, session.capabilities?.attachments === true);
    }
    return map;
  }, [sessions.activeSessions]);

  const state = useMemo(
    () =>
      selectShareGateState({
        shareId,
        payload,
        validation,
        storedIsError: sessions.storedIsError,
        storedIsSuccess: sessions.storedIsSuccess,
        activeIsError: sessions.activeIsError,
        storedRowCount: destinations.length,
        isLoading: sessions.isLoading || !orgLoaded,
      }),
    [
      shareId,
      payload,
      validation,
      sessions.storedIsError,
      sessions.storedIsSuccess,
      sessions.activeIsError,
      sessions.isLoading,
      destinations.length,
      orgLoaded,
    ]
  );

  const prReviewEnabled = useFeatureFlag(FEATURE_FLAG_PR_REVIEW, true);
  const reviewPr = useMemo(
    () =>
      selectShareReviewPr({
        text: payload?.text ?? '',
        prReviewEnabled,
        showNewSession: state.showNewSession,
      }),
    [payload?.text, prReviewEnabled, state.showNewSession]
  );

  const instanceRows = useMemo(
    () =>
      selectShareCliSpawnRows({
        instances: instancesData?.instances ?? [],
        organizationId,
        orgLoaded,
        gateShowsNewSession: state.showNewSession,
      }),
    [instancesData?.instances, organizationId, orgLoaded, state.showNewSession]
  );

  const abandon = useCallback(() => {
    const id = ownedShareIdRef.current;
    // Committed ids survive every gate-side clear; delivery owns consumption.
    if (id && id !== committedShareIdRef.current) {
      clearSharePayload(id);
    }
    // Never resetShareIntent here — a newly arriving intent is the layout
    // effect's to read.
  }, []);

  const dismiss = useCallback(() => {
    abandon();
    router.back();
  }, [abandon, router]);

  const handleReviewPr = useCallback(() => {
    if (!reviewPr) {
      return;
    }
    void Haptics.selectionAsync();
    setPendingShareNavigation({
      href: getPrReviewPath(reviewPr.owner, reviewPr.repo, reviewPr.number) as string,
      shareId: null,
    });
    dismiss();
  }, [dismiss, reviewPr]);

  useEffect(
    () => () => {
      const id = ownedShareIdRef.current;
      // Never resetShareIntent — layout ingest owns intent reset.
      if (id && id !== committedShareIdRef.current) {
        clearSharePayload(id);
      }
    },
    []
  );

  const commit = useCallback(
    (href: string) => {
      if (!shareId) {
        return;
      }
      void Haptics.selectionAsync();
      committedShareIdRef.current = shareId;
      setPendingShareNavigation({ href, shareId });
      router.back();
    },
    [router, shareId]
  );

  const handleNewSession = useCallback(() => {
    if (!shareId || isSpawning) {
      return;
    }
    const base = getNewAgentSessionPath(organizationId);
    commit(appendShareParams(base, shareId));
  }, [commit, isSpawning, organizationId, shareId]);

  const commitEnabled = isShareCommitEnabled({ orgLoaded, validation });
  const instanceRowsDisabled = !commitEnabled || isSpawning;
  const newSessionDisabled = !commitEnabled || isSpawning;

  const handleSelectDestination = useCallback(
    (row: ShareDestinationRow) => {
      if (!shareId || isSpawning) {
        return;
      }
      const admission: ShareDestinationAdmission = resolveShareDestinationAdmission({
        createdOnPlatform: row.created_on_platform,
        live: row.live,
        attachmentsCapable: attachmentsCapableBySessionId.get(row.session_id) ?? false,
        hasFiles: resolveShareHasFiles(validation, payload?.files.length ?? 0),
      });
      if (!admission.ok) {
        // Keep the gate open and the payload staged so the user can pick
        // another destination.
        Alert.alert(admission.title, admission.message);
        return;
      }
      const org = row.organization_id ?? undefined;
      const base = getAgentSessionPath(row.session_id, org) as string;
      commit(appendShareParams(base, shareId));
    },
    [attachmentsCapableBySessionId, commit, isSpawning, payload, shareId, validation]
  );

  const handleSpawnInstance = useCallback(
    (instance: ShareCliSpawnRow) => {
      if (!shareId || !commitEnabled || isSpawning) {
        return;
      }

      const admission = resolveShareDestinationAdmission({
        createdOnPlatform: 'cli',
        live: true,
        attachmentsCapable: instance.capabilities?.attachments === true,
        hasFiles: resolveShareHasFiles(validation, payload?.files.length ?? 0),
      });
      if (!admission.ok) {
        Alert.alert(admission.title, admission.message);
        return;
      }

      void (async () => {
        spawnAttemptRef.current += 1;
        const attempt = spawnAttemptRef.current;
        setSpawningConnectionId(instance.connectionId);
        const operationKey = getKey(
          JSON.stringify({ connectionId: instance.connectionId, shareId })
        );
        try {
          const outcome = await spawn(instance.connectionId, undefined, { operationKey });
          // Gate has no "Run on" selection; ignore selection-reset flags.
          const action = resolveRemoteSubmitOutcome({
            outcome,
            refetchedInstances: [],
            selectedConnectionId: instance.connectionId,
          });

          if (action.kind === 'navigate') {
            // Rotate before the suppressed-navigation early return, so a later
            // eligible spawn cannot reuse the settled key.
            rotateKey();
            if (
              !shouldCommitShareSpawnReady({
                committedShareId: committedShareIdRef.current,
                payloadStillStaged: peekSharePayload(shareId) !== null,
              })
            ) {
              return;
            }
            commit(
              appendShareParams(getSpawnedAgentSessionPath(action.sessionID) as string, shareId)
            );
            return;
          }

          if (action.kind === 'retryable') {
            toast.error(action.toast);
            try {
              await refetchInstances();
            } catch {
              // Stay open with the staged payload; user can retry.
            }
            return;
          }

          // A typed non-retryable rejection ends the intent.
          rotateKey();
          toast.error(action.toast);
        } finally {
          // Only the attempt that still owns the lock may clear it.
          if (spawnAttemptRef.current === attempt) {
            setSpawningConnectionId(null);
          }
        }
      })();
    },
    [
      commit,
      commitEnabled,
      getKey,
      isSpawning,
      payload,
      refetchInstances,
      rotateKey,
      shareId,
      spawn,
      validation,
    ]
  );

  const handleRetry = useCallback(() => {
    void sessions.refetch();
  }, [sessions]);

  const showNewSession = state.showNewSession;
  const showTerminalMessage =
    state.kind === 'stale-share' || state.kind === 'non-retryable-classification';
  const previewPayload = payload !== null && state.kind !== 'stale-share' ? payload : null;

  // Header block: title+close, preview, New session. collapsable={false} is
  // required so react-native-screens finds it as the formSheet header.
  const header = (
    <View collapsable={false} className="border-b border-border bg-background pt-4">
      <View className="h-11 flex-row items-center justify-center px-4">
        <Text className="text-lg font-semibold text-foreground" accessibilityRole="header">
          Share to Kilo
        </Text>
        <Button
          size="icon"
          variant="ghost"
          accessibilityLabel="Close"
          onPress={dismiss}
          className="absolute right-2"
        >
          <X size={20} color={colors.foreground} />
        </Button>
      </View>

      {previewPayload ? (
        <SharePayloadPreview payload={previewPayload} validation={validation} />
      ) : null}

      {showTerminalMessage ? (
        <View className="items-center px-6 pb-6 pt-4">
          <Text className="text-center text-sm text-muted-foreground">{state.message}</Text>
        </View>
      ) : null}

      {reviewPr ? (
        <DestinationOptionRow
          icon={GitPullRequest}
          title="Review PR"
          subtitle={`${reviewPr.owner}/${reviewPr.repo} #${reviewPr.number}`}
          accessibilityLabel="Review PR"
          onPress={handleReviewPr}
        />
      ) : null}

      {showNewSession ? (
        <Pressable
          onPress={newSessionDisabled ? undefined : handleNewSession}
          disabled={newSessionDisabled}
          accessibilityRole="button"
          accessibilityLabel="New session"
          accessibilityState={{ disabled: newSessionDisabled }}
          className={`flex-row items-center gap-3 border-t border-border px-4 py-3.5 ${
            newSessionDisabled ? 'opacity-50' : 'active:opacity-70'
          }`}
        >
          <View className="h-9 w-9 items-center justify-center rounded-full bg-primary">
            <Plus size={18} color={colors.primaryForeground} />
          </View>
          <Text className="text-base font-semibold text-foreground">New session</Text>
        </Pressable>
      ) : null}
    </View>
  );

  // Always pair the collapsable header with a FlatList (formSheet constraint).
  return (
    <>
      {header}
      <ShareDestinationList
        state={state}
        destinations={destinations}
        onSelect={handleSelectDestination}
        onRetry={handleRetry}
        instances={instanceRows}
        spawningConnectionId={spawningConnectionId}
        instanceRowsDisabled={instanceRowsDisabled}
        destinationsDisabled={isSpawning}
        onSpawnInstance={handleSpawnInstance}
      />
    </>
  );
}
