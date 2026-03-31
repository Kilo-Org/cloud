import { useEffect, useState } from 'react';
import { type Event, type Channel as StreamChannel, type StreamChat } from 'stream-chat';

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
