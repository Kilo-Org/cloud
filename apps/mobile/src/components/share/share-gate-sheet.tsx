import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useShareIntentContext } from 'expo-share-intent';
import { Plus, X } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, View } from 'react-native';

import { getAgentSessionPath } from '@/components/agents/session-detail-routes';
import { expandPlatformFilter } from '@/components/agents/session-list-helpers';
import { getNewAgentSessionPath } from '@/components/agents/session-list-routes';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useAgentSessions } from '@/lib/hooks/use-agent-sessions';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useOrganization } from '@/lib/organization-context';
import { setPendingShareNavigation } from '@/lib/share-navigation';
import { clearSharePayload, peekSharePayload, type ShareId } from '@/lib/share-payload';

import {
  resolveShareDestinationAdmission,
  type ShareDestinationAdmission,
} from './share-cli-admission';
import { selectShareDestinations, type ShareDestinationRow } from './share-destinations';
import { ShareDestinationList } from './share-destination-list';
import { isShareCommitEnabled, selectShareGateState } from './share-gate-state';
import { SharePayloadPreview } from './share-payload-preview';
import { type SharePayloadValidation, validateSharePayload } from './share-payload-validation';

function appendShareId(base: string, shareId: ShareId): string {
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}shareId=${encodeURIComponent(shareId)}`;
}

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
  const { resetShareIntent } = useShareIntentContext();
  const { organizationId, isLoaded: orgLoaded } = useOrganization();
  // Org-scoped stored page only (cloud-agent + cli). Active list is an
  // id/capability lookup — never a row source (no organizationId filter).
  const sessions = useAgentSessions({
    createdOnPlatform: expandPlatformFilter(['cloud-agent', 'cli']),
    organizationId,
    enabled: orgLoaded,
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
  // dismiss animation while a newer shareId is focused.
  useEffect(() => {
    const previous = previousShareIdRef.current;
    if (previous && previous !== shareId && previous !== committedShareIdRef.current) {
      clearSharePayload(previous);
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

  const abandon = useCallback(() => {
    const id = ownedShareIdRef.current;
    if (id) {
      clearSharePayload(id);
    }
    resetShareIntent();
  }, [resetShareIntent]);

  const dismiss = useCallback(() => {
    abandon();
    router.back();
  }, [abandon, router]);

  useEffect(
    () => () => {
      const id = ownedShareIdRef.current;
      if (id !== committedShareIdRef.current) {
        if (id) {
          clearSharePayload(id);
        }
        resetShareIntent();
      }
    },
    [resetShareIntent]
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
    if (!shareId) {
      return;
    }
    const base = getNewAgentSessionPath(organizationId);
    commit(appendShareId(base, shareId));
  }, [commit, organizationId, shareId]);

  const handleSelectDestination = useCallback(
    (row: ShareDestinationRow) => {
      if (!shareId) {
        return;
      }
      const admission: ShareDestinationAdmission = resolveShareDestinationAdmission({
        createdOnPlatform: row.created_on_platform,
        live: row.live,
        attachmentsCapable: attachmentsCapableBySessionId.get(row.session_id) ?? false,
        hasFiles: (payload?.files.length ?? 0) > 0,
      });
      if (!admission.ok) {
        // Keep the gate open and the payload staged so the user can pick
        // another destination.
        Alert.alert(admission.title, admission.message);
        return;
      }
      const org = row.organization_id ?? undefined;
      const base = getAgentSessionPath(row.session_id, org) as string;
      commit(appendShareId(base, shareId));
    },
    [attachmentsCapableBySessionId, commit, payload, shareId]
  );

  const handleRetry = useCallback(() => {
    void sessions.refetch();
  }, [sessions]);

  const showNewSession = state.showNewSession;
  const showTerminalMessage =
    state.kind === 'stale-share' || state.kind === 'non-retryable-classification';
  const previewPayload = payload !== null && state.kind !== 'stale-share' ? payload : null;
  const commitEnabled = isShareCommitEnabled({ orgLoaded, validation });

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

      {showNewSession ? (
        <Pressable
          onPress={commitEnabled ? handleNewSession : undefined}
          disabled={!commitEnabled}
          accessibilityRole="button"
          accessibilityLabel="New session"
          accessibilityState={{ disabled: !commitEnabled }}
          className={`flex-row items-center gap-3 border-t border-border px-4 py-3.5 ${
            commitEnabled ? 'active:opacity-70' : 'opacity-50'
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
      />
    </>
  );
}
