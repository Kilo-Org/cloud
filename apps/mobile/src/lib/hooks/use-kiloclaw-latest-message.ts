import { useQuery } from '@tanstack/react-query';

import { useStreamChatCredentials } from '@/lib/hooks/use-kiloclaw-queries';

const STREAM_CHAT_API_BASE = 'https://chat.stream-io-api.com';

type LatestMessage = {
  text: string;
  senderName: string;
  created_at: string;
};

type StreamChatCredentials = {
  apiKey: string;
  userId: string;
  userToken: string;
  channelId: string;
};

type ChannelQueryResponse = {
  messages?: {
    text?: string;
    created_at?: string;
    user?: { id?: string; name?: string };
  }[];
};

async function fetchLatestMessage(creds: StreamChatCredentials): Promise<LatestMessage | null> {
  const res = await fetch(
    `${STREAM_CHAT_API_BASE}/channels/messaging/${creds.channelId}/query?api_key=${creds.apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stream-Auth-Type': 'jwt',
        Authorization: creds.userToken,
      },
      body: JSON.stringify({
        state: true,
        messages: { limit: 1 },
      }),
    }
  );

  if (!res.ok) {
    if (res.status === 404) {
      return null;
    }
    const body = await res.text().catch(() => '(unreadable)');
    throw new Error(`Stream Chat query failed (${res.status}): ${body}`);
  }

  const payload = (await res.json()) as ChannelQueryResponse;
  const message = payload.messages?.[0];
  if (!message?.created_at) {
    return null;
  }

  return {
    text: message.text ?? '',
    senderName: message.user?.name ?? message.user?.id ?? '',
    created_at: message.created_at,
  };
}

/**
 * Fetch the most recent message on the KiloClaw chat channel directly from
 * Stream Chat, reusing the short-lived user credentials exposed by
 * `useStreamChatCredentials`. No extra backend endpoint required.
 */
export function useKiloClawLatestMessage(organizationId?: string | null, enabled = true) {
  const { data: creds } = useStreamChatCredentials(organizationId, enabled);
  const queryEnabled = enabled && Boolean(creds);
  return useQuery({
    queryKey: ['kiloclaw-latest-message', creds?.channelId ?? null],
    queryFn: async () => {
      if (!creds) {
        return null;
      }
      const latest = await fetchLatestMessage(creds);
      return latest;
    },
    enabled: queryEnabled,
    staleTime: 30_000,
    refetchInterval: queryEnabled ? 60_000 : false,
  });
}
