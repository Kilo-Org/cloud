import { PylonChatView } from '@pylon/react-native-chat';
import { useQuery } from '@tanstack/react-query';
import * as Application from 'expo-application';
import { type ComponentRef, useRef, useState } from 'react';
import { ActivityIndicator, Platform, View, type ViewStyle } from 'react-native';
import { toast } from 'sonner-native';

import { useAuth } from '@/lib/auth/auth-context';
import { PYLON_APP_ID } from '@/lib/config';
import { useTRPC } from '@/lib/trpc';

// PylonChatView is a native component without className support, so a style object it is.
const OVERLAY_STYLE: ViewStyle = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 };

function usePylonIdentity() {
  const { token } = useAuth();
  const trpc = useTRPC();
  const { data } = useQuery({
    ...trpc.user.getPylonIdentity.queryOptions(),
    enabled: token != null,
  });
  return data?.identity;
}

/** Whether support chat can be offered (identity available). */
export function useSupportChatAvailable(): boolean {
  return usePylonIdentity() != null;
}

/** Fullscreen Pylon chat overlay. Mount it to open the chat; it calls onClose
 *  when the user closes the widget (or it fails to load), at which point the
 *  owner should unmount it. */
export function SupportChatOverlay({ onClose }: { readonly onClose: () => void }) {
  const identity = usePylonIdentity();
  const [open, setOpen] = useState(false);
  const chatRef = useRef<ComponentRef<typeof PylonChatView>>(null);

  if (!identity) {
    return null;
  }

  return (
    <>
      {!open && (
        <View
          pointerEvents="none"
          className="absolute inset-0 items-center justify-center"
          accessibilityLabel="Loading support chat"
        >
          <View className="rounded-2xl bg-neutral-200 p-5 dark:bg-neutral-700">
            <ActivityIndicator size="large" />
          </View>
        </View>
      )}
      <PylonChatView
        ref={chatRef}
        config={{ appId: PYLON_APP_ID }}
        user={identity}
        style={OVERLAY_STYLE}
        listener={{
          onPylonReady: () => {
            chatRef.current?.hideChatBubble();
            chatRef.current?.setNewIssueCustomFields({
              platform: Platform.OS,
              app_version: `${Application.nativeApplicationVersion} (${Application.nativeBuildVersion})`,
            });
            chatRef.current?.openChat();
          },
          onChatOpened: () => {
            setOpen(true);
          },
          onChatClosed: wasOpen => {
            // The widget fires spurious close events while initializing.
            if (wasOpen) {
              onClose();
            }
          },
          onPylonError: error => {
            toast.error(`Could not load support chat: ${error}`);
            onClose();
          },
        }}
      />
    </>
  );
}
