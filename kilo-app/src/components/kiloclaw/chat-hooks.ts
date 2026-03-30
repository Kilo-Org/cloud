import { useEffect, useState } from 'react';
import { Keyboard } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { type Event, type Channel as StreamChannel, type StreamChat } from 'stream-chat';

export function useKeyboardAwareBottomInset() {
  const { bottom } = useSafeAreaInsets();
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', () => {
      setKeyboardVisible(true);
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardVisible(false);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  return { bottomInset: keyboardVisible ? 0 : bottom, keyboardVisible };
}

export function useBotOnlineStatus(
  client: StreamChat | null,
  channel: StreamChannel | null,
  botUserId: string
): boolean {
  const [online, setOnline] = useState(false);

  useEffect(() => {
    const handlePresenceChange = (event: Event) => {
      if (event.user?.id === botUserId) {
        setOnline(Boolean(event.user.online));
      }
    };

    if (client && channel) {
      // Check initial state
      const member = channel.state.members[botUserId];
      setOnline(Boolean(member?.user?.online));
      client.on('user.presence.changed', handlePresenceChange);
    }

    return () => {
      client?.off('user.presence.changed', handlePresenceChange);
    };
  }, [client, channel, botUserId]);

  return online;
}
