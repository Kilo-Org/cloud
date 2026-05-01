import {
  type MarkBadgeReadInput,
  type MarkBadgeReadResponse,
  markBadgeReadResponseSchema,
} from '@kilocode/notifications';

type MarkReadConversationAndBadgeInput = {
  conversationId: string;
  lastSeenMessageId: string;
  badgeBucket: string;
  notificationsUrl: string;
  markConversationRead: (input: {
    conversationId: string;
    lastSeenMessageId: string;
  }) => Promise<unknown>;
  getToken: () => Promise<string>;
  fetchBadgeRead: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

export async function markReadConversationAndBadge({
  conversationId,
  lastSeenMessageId,
  badgeBucket,
  notificationsUrl,
  markConversationRead,
  getToken,
  fetchBadgeRead,
}: MarkReadConversationAndBadgeInput): Promise<MarkBadgeReadResponse> {
  await markConversationRead({ conversationId, lastSeenMessageId });
  const token = await getToken();
  const input = { badgeBucket } satisfies MarkBadgeReadInput;
  const response = await fetchBadgeRead(`${notificationsUrl}/v1/badges/mark-read`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(`Failed to mark badge read: ${response.status}`);
  }
  return markBadgeReadResponseSchema.parse(await response.json());
}
