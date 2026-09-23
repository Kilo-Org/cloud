import { type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { Portal } from '@rn-primitives/portal';
import { useQuery } from '@tanstack/react-query';
import { BlurView } from 'expo-blur';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BackHandler,
  Platform,
  Pressable,
  useColorScheme,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';

import { RenameModal } from '@/components/rename-modal';
import { Text } from '@/components/ui/text';
import { SESSION_TRANSCRIPT_STALE_TIME_MS } from '@/lib/agent-session-cache';
import { useTRPC } from '@/lib/trpc';
import { readTrpcErrorField } from '@/lib/trpc-error';

import { SessionPreviewActionPanel } from './session-preview-action-panel';
import { SessionPreviewHeaderMeta } from './session-preview-header';
import {
  closeSessionPreviewStore,
  releaseSessionPreviewStore,
  type SessionPreviewTarget,
  useSessionPreview,
} from './session-preview-state';
import {
  SessionPreviewTranscript,
  type SessionPreviewTranscriptState,
} from './session-preview-transcript';
import { SESSION_TITLE_MAX_LENGTH } from './session-detail-rename-state';
import {
  buildSessionActionMenuItems,
  copySessionId,
  showDeleteConfirm,
  showRenamePrompt,
} from './session-row-actions';

const OPEN_DURATION_MS = 180;
const CLOSE_DURATION_MS = 160;
/** Vertical travel on the header strip that dismisses the preview. */
const DRAG_DISMISS_THRESHOLD = 120;
/** The live transcript and the DB row poll on the same cadence. */
const LIVE_POLL_INTERVAL_MS = 2500;
/** Card and panel gutter from the safe-area edges. */
const EDGE_INSET = 12;
/** The card never grows past this share of the window, so the panel stays on screen. */
const CARD_MAX_HEIGHT_RATIO = 0.62;

const EMPTY_MESSAGES: readonly StoredMessage[] = [];

/**
 * The long-press session preview: a floating card with a read-only transcript,
 * and the session action menu in a rounded panel below it. Renders nothing
 * while the preview store is closed, so the app root pays only the store
 * subscription until a long-press opens a target.
 *
 * The whole overlay lives in a `Portal`, not an RN Modal: the app-root
 * `PortalHost` sits above the tab bar, so the dim/blur recedes the entire
 * screen the way the owner's reference shows.
 */
export function SessionPreviewOverlay() {
  const { target, visible } = useSessionPreview();
  if (!target) {
    return null;
  }
  // Keyed on the session: a preview opened over another one starts from a
  // fresh open animation and a clean rename state.
  return <SessionPreviewContent key={target.sessionId} target={target} visible={visible} />;
}

function SessionPreviewContent({
  target,
  visible,
}: Readonly<{ target: SessionPreviewTarget; visible: boolean }>) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const scheme = useColorScheme();
  const { sessionId, live } = target;

  const transcriptQuery = useQuery({
    ...trpc.cliSessionsV2.getSessionMessages.queryOptions({ session_id: sessionId }),
    // Shared with the gesture-start prefetch, so a reopen paints from cache.
    staleTime: SESSION_TRANSCRIPT_STALE_TIME_MS,
    // A failed read shows its error state; it is never retried without bound.
    retry: false,
    ...(live ? { refetchInterval: LIVE_POLL_INTERVAL_MS } : {}),
  });
  // The DB row carries the status and cost a live preview keeps updating. A
  // non-live target polls nothing.
  const liveRowQuery = useQuery({
    ...trpc.cliSessionsV2.get.queryOptions({ session_id: sessionId }),
    enabled: live,
    ...(live ? { refetchInterval: LIVE_POLL_INTERVAL_MS } : {}),
  });
  const liveRow = live ? liveRowQuery.data : undefined;

  // SAFETY: `getSessionMessages` answers with the raw ingest snapshot, whose
  // `messages` are the SDK's `StoredMessage` shape (`info` + `parts`); the rows
  // are only handed to `MessageBubble`, which reads exactly those two fields.
  const messages = (transcriptQuery.data?.messages ?? EMPTY_MESSAGES) as readonly StoredMessage[];
  const transcriptState: SessionPreviewTranscriptState = {
    sessionId,
    messages,
    isLoading: transcriptQuery.isLoading,
    isError: transcriptQuery.isError,
    errorCode: readTrpcErrorField(transcriptQuery.error, 'code'),
    onRetry: () => {
      void transcriptQuery.refetch();
    },
  };

  const progress = useSharedValue(0);
  const dragY = useSharedValue(0);
  const [renameVisible, setRenameVisible] = useState(false);
  const renameVisibleRef = useRef(false);
  const closeCompletedRef = useRef(false);

  const releaseAfterClose = useCallback(() => {
    closeCompletedRef.current = true;
    if (renameVisibleRef.current) {
      // The Android rename dialog is still on screen and owns the tree; its
      // close handler releases the preview instead.
      return;
    }
    releaseSessionPreviewStore();
  }, []);

  const closePreview = useCallback(closeSessionPreviewStore, []);

  // One prop drives both directions: `visible` starts true (open) and flips
  // false (close). The target stays mounted until the exit animation reports
  // back, which is what lets the card animate out before it is released.
  useEffect(() => {
    if (visible) {
      progress.value = withTiming(1, { duration: OPEN_DURATION_MS });
      return;
    }
    progress.value = withTiming(0, { duration: CLOSE_DURATION_MS }, finished => {
      if (finished) {
        scheduleOnRN(releaseAfterClose);
      }
    });
  }, [visible, progress, releaseAfterClose]);

  // Android back dismisses the preview before it can pop the screen.
  useEffect(() => {
    if (!visible) {
      return undefined;
    }
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      closePreview();
      return true;
    });
    return () => {
      subscription.remove();
    };
  }, [visible, closePreview]);

  const handleRename = useCallback(() => {
    if (!target.onRename) {
      return;
    }
    if (Platform.OS === 'ios') {
      showRenamePrompt(target.initialRenameValue, newTitle => {
        target.onRename?.(newTitle);
      });
      return;
    }
    // The rename dialog renders from this component, so the release has to wait
    // for it (see `releaseAfterClose`). The ref is set synchronously because the
    // close animation may finish before React commits the state.
    renameVisibleRef.current = true;
    setRenameVisible(true);
  }, [target]);

  const handleCloseRename = useCallback(() => {
    renameVisibleRef.current = false;
    setRenameVisible(false);
    if (closeCompletedRef.current) {
      releaseSessionPreviewStore();
    }
  }, []);

  const onDelete = target.onDelete;
  // One source for the panel's rows: the same builder the action sheet uses, so
  // order, copy and the destructive row cannot diverge.
  const menu = useMemo(
    () =>
      buildSessionActionMenuItems({
        onCopySessionId: () => {
          void copySessionId(sessionId);
        },
        onRename: target.onRename ? handleRename : undefined,
        onExit: target.onExit,
        onDelete: onDelete
          ? () => {
              showDeleteConfirm(onDelete);
            }
          : undefined,
      }),
    [sessionId, target.onRename, target.onExit, onDelete, handleRename]
  );

  // The header strip alone owns the pan, so the transcript keeps its own scroll.
  // eslint-disable-next-line new-cap -- RNGH's gesture builder API is Gesture.Pan().
  const pan = Gesture.Pan()
    .onUpdate(event => {
      dragY.value = event.translationY;
    })
    .onEnd(() => {
      if (Math.abs(dragY.value) > DRAG_DISMISS_THRESHOLD) {
        dragY.value = withTiming(0);
        scheduleOnRN(closePreview);
        return;
      }
      dragY.value = withTiming(0);
    });

  const backdropStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  const cardStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [
      { translateY: (1 - progress.value) * 12 + dragY.value },
      { scale: 0.96 + 0.04 * progress.value },
    ],
  }));
  const containerStyle = useMemo(
    () => ({
      paddingTop: insets.top + EDGE_INSET,
      paddingBottom: insets.bottom + EDGE_INSET,
      paddingLeft: EDGE_INSET,
      paddingRight: EDGE_INSET,
    }),
    [insets.top, insets.bottom]
  );
  // The card keeps the panel on screen by never growing past most of the
  // window; the transcript area inside it is the flex child that absorbs the
  // remaining height.
  //
  // `flexGrow` is what actually gives that transcript a bounded height: the
  // card is the column's only flexible child, so it takes the free space the
  // centered column leaves and the cap keeps the menu panel visible. Without
  // it the card would be content-sized, and a `flex-1` transcript (zero basis)
  // inside an auto-height card collapses to nothing — the FlashList would
  // never lay out.
  const cardHeightStyle = useMemo(
    () => ({
      maxHeight: windowHeight * CARD_MAX_HEIGHT_RATIO,
      flexGrow: 1,
      flexShrink: 1,
    }),
    [windowHeight]
  );

  return (
    <Portal name="session-preview">
      <Animated.View style={backdropStyle} className="absolute inset-0 bg-[#00000066]">
        {/* Android has no dependable BlurView: `expo-blur` is unreliable on
            low-end Android devices (see `components/ui/blur-bar.tsx`), so the
            backdrop is dim-only there and blurred on iOS. This is a hard
            platform constraint, not a preference. */}
        {Platform.OS === 'ios' ? (
          <BlurView
            intensity={20}
            tint={scheme === 'dark' ? 'dark' : 'light'}
            className="absolute inset-0"
          />
        ) : null}
        {/* The whole backdrop is the dismiss target: it sits behind the card
            and the panel, and the centered column above it is `box-none`, so a
            tap on any free space — above, below or beside either surface —
            reaches this Pressable. */}
        <Pressable
          className="flex-1"
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
          onPress={closePreview}
        />
        <View
          pointerEvents="box-none"
          className="absolute inset-0 justify-center"
          style={containerStyle}
        >
          <Animated.View
            className="overflow-hidden rounded-3xl bg-card"
            style={[cardStyle, cardHeightStyle]}
          >
            <GestureDetector gesture={pan}>
              <View className="flex-row items-center gap-3 px-4 py-3">
                <SessionPreviewHeaderMeta target={target} liveRow={liveRow} />
              </View>
            </GestureDetector>
            <View className="flex-1 justify-center">
              <Text
                accessible
                accessibilityLabel={t('agentChat.session.transcriptAccessibility')}
                pointerEvents="none"
                className="absolute inset-0 opacity-0"
              />
              <SessionPreviewTranscript {...transcriptState} />
            </View>
          </Animated.View>
          <SessionPreviewActionPanel
            menu={menu}
            onSelect={item => {
              // Dismiss first, then act: the menu belongs to the preview, and a
              // rename/delete prompt must not stack on top of it.
              closePreview();
              item.run();
            }}
            onCancel={closePreview}
          />
        </View>
      </Animated.View>
      {renameVisible ? (
        <RenameModal
          title={t('agentChat.session.renameSession')}
          placeholder={t('agentChat.session.renamePlaceholder')}
          initialValue={target.initialRenameValue}
          maxLength={SESSION_TITLE_MAX_LENGTH}
          onClose={handleCloseRename}
          onSave={async name => {
            // Resolve immediately so RenameModal closes like today's list flow;
            // mutation errors toast + roll back outside the modal.
            target.onRename?.(name);
            await Promise.resolve();
          }}
        />
      ) : null}
    </Portal>
  );
}
