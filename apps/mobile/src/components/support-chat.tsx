import { PylonChatView } from '@pylon/react-native-chat';
import { useQuery } from '@tanstack/react-query';
import * as Application from 'expo-application';
import {
  type ComponentRef,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ActivityIndicator, Platform, View, type ViewStyle } from 'react-native';
import { toast } from 'sonner-native';

import { useAuth } from '@/lib/auth/auth-context';
import { PYLON_APP_ID } from '@/lib/config';
import { useTRPC } from '@/lib/trpc';

// PylonChatView is a native component without className support, so a style object it is.
const OVERLAY_STYLE: ViewStyle = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 };

type SupportChatState = 'idle' | 'loading' | 'open' | 'hidden';

type SupportChatContextValue = {
  /** Whether support chat can be offered (identity available). */
  available: boolean;
  state: SupportChatState;
  openSupportChat: () => void;
};

const SupportChatContext = createContext<SupportChatContextValue | undefined>(undefined);

export function useSupportChat(): SupportChatContextValue {
  const context = useContext(SupportChatContext);
  if (!context) {
    throw new Error('useSupportChat must be used within a SupportChatProvider');
  }
  return context;
}

/** Hosts the Pylon chat widget as an app-wide overlay. The widget mounts on first
 *  use and then stays mounted: remounting PylonChatView in the same process leaves
 *  the SDK's WebView permanently stuck, so closing the chat only hides it. */
export function SupportChatProvider({ children }: { readonly children: ReactNode }) {
  const { token } = useAuth();
  const trpc = useTRPC();
  const { data } = useQuery({
    ...trpc.user.getPylonIdentity.queryOptions(),
    enabled: token != null,
  });
  const identity = data?.identity;
  const [state, setState] = useState<SupportChatState>('idle');
  const chatRef = useRef<ComponentRef<typeof PylonChatView>>(null);

  const openSupportChat = useCallback(() => {
    setState(current => {
      if (current === 'hidden') {
        chatRef.current?.openChat();
        return current;
      }
      return current === 'idle' ? 'loading' : current;
    });
  }, []);

  const available = identity != null;
  const value = useMemo(
    () => ({ available, state, openSupportChat }),
    [available, state, openSupportChat]
  );

  return (
    <SupportChatContext value={value}>
      {children}
      {identity && state === 'loading' && (
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
      {identity && state !== 'idle' && (
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
              setState('open');
            },
            onChatClosed: () => {
              setState(current => (current === 'idle' ? current : 'hidden'));
            },
            onPylonError: error => {
              toast.error(`Could not load support chat: ${error}`);
            },
          }}
        />
      )}
    </SupportChatContext>
  );
}
