import { z } from 'zod';
import { generateInternalServiceToken } from './token.js';

const SessionSnapshotSchema = z.object({
  info: z.unknown(),
  messages: z.array(
    z.looseObject({
      info: z.looseObject({
        id: z.string(),
        role: z.string().optional(),
      }),
      parts: z.array(
        z.looseObject({
          id: z.string(),
          type: z.string().optional(),
          text: z.string().optional(),
        })
      ),
    })
  ),
});

type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;

function extractLastAssistantText(snapshot: SessionSnapshot): string | null {
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const message = snapshot.messages[index];
    if (message.info.role !== 'assistant') continue;
    const text = message.parts
      .filter(part => part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('');
    if (text.length > 0) return text;
  }
  return null;
}

export async function fetchLatestAssistantText(params: {
  sessionId: string;
  userId: string;
  sessionIngestWorkerUrl: string;
  nextAuthSecret: string;
}): Promise<string | null> {
  if (!params.sessionIngestWorkerUrl) return null;
  const token = await generateInternalServiceToken(params.userId, params.nextAuthSecret);
  const response = await fetch(
    `${params.sessionIngestWorkerUrl}/api/session/${encodeURIComponent(params.sessionId)}/export`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Session ingest export failed with ${response.status}`);
  }
  return extractLastAssistantText(SessionSnapshotSchema.parse(await response.json()));
}
