import type { WrapperKiloClient } from '../kilo-api.js';
import { KILO_ACTIVITY_MESSAGE_LIMIT } from '../kilo-api.js';
import type { SessionInteraction, SessionObservation } from './session-supervisor.js';

const MAX_ACTIVITY_DIRECTORIES = 64;
const SNAPSHOT_CONCURRENCY = 4;

type KnownSession = { id: string; directory: string; messageIds: string[] };
type PendingRequest = {
  id: string;
  sessionID: string;
  blocking?: boolean;
  tool?: { messageID: string; callID: string };
};

/** Reads a bounded, complete observation; callers reject all partial failures. */
export async function readSessionSnapshot(input: {
  client: WrapperKiloClient;
  directory: string;
  observedDirectories: Iterable<string>;
  knownSessions: KnownSession[];
  signal: AbortSignal;
}): Promise<SessionObservation[]> {
  const { client, signal } = input;
  const metadata = await client.listSessionMetadata(signal);
  const sessions = new Map(metadata.map(item => [item.id, item]));
  const known = new Map(input.knownSessions.map(item => [item.id, item]));
  const directories = new Set([
    input.directory,
    ...input.observedDirectories,
    ...metadata.map(item => item.directory),
    ...input.knownSessions.map(item => item.directory),
  ]);
  if (directories.size > MAX_ACTIVITY_DIRECTORIES)
    throw new Error('Activity directory discovery exceeded its bounded window');
  const observations = new Map<string, SessionObservation>();

  async function readDirectory(directory: string): Promise<void> {
    const [statuses, questions, permissions, suggestions] = await Promise.all([
      client.getSessionStatuses(directory, signal),
      client.getQuestions(directory, signal),
      client.getPermissions(directory, signal),
      client.getSuggestions(directory, signal),
    ]);
    const pending: PendingRequest[] = [...questions, ...permissions, ...suggestions];
    const ids = new Set([
      ...Object.keys(statuses),
      ...pending.map(item => item.sessionID),
      ...input.knownSessions.filter(item => item.directory === directory).map(item => item.id),
    ]);
    for (const id of ids) {
      signal.throwIfAborted();
      const status = statuses[id]?.type ?? 'idle';
      if (status !== 'busy' && status !== 'retry' && status !== 'idle')
        throw new Error('Activity snapshot received unknown session status');
      let details = sessions.get(id);
      if (!details) details = await client.getSessionDetails(id, directory, signal);
      if (details.directory !== directory)
        throw new Error('Activity snapshot received mismatched execution directory');
      const requests = pending.filter(request => request.sessionID === id);
      const messages = await client.getRecentSessionMessages(id, directory, signal);
      const byId = new Map(messages.map(message => [message.info.id, message]));
      const messageIds = new Set([
        ...(known.get(id)?.messageIds ?? []),
        ...requests.flatMap(request => (request.tool ? [request.tool.messageID] : [])),
        ...messages
          .filter(
            message =>
              message.info.role === 'assistant' && message.info.time.completed === undefined
          )
          .map(message => message.info.id),
      ]);
      for (const messageId of messageIds) {
        const message = await client.getSessionMessage(id, directory, messageId, signal);
        if (message.info.sessionID !== id || message.info.id !== messageId)
          throw new Error('Activity snapshot received mismatched message identity');
        byId.set(messageId, message);
      }
      // A full window containing only queued user messages cannot establish where
      // older native work is. Never guess idle or no-progress from that window.
      if (
        messages.length === KILO_ACTIVITY_MESSAGE_LIMIT &&
        ![...byId.values()].some(message => message.info.role === 'assistant')
      ) {
        throw new Error('Activity message window cannot establish in-flight execution');
      }
      const interactions: SessionInteraction[] = requests.map(request => ({
        id: request.id,
        blocking: request.blocking !== false,
        callID: request.tool?.callID,
      }));
      if (observations.has(id))
        throw new Error('Activity session is executing in multiple directories');
      observations.set(id, {
        id,
        directory,
        parentID: details.parentID,
        status,
        messages: [...byId.values()],
        interactions,
      });
    }
  }

  const queue = [...directories];
  await Promise.all(
    Array.from({ length: Math.min(SNAPSHOT_CONCURRENCY, queue.length) }, async () => {
      while (queue.length > 0) {
        signal.throwIfAborted();
        const directory = queue.shift();
        if (directory !== undefined) await readDirectory(directory);
      }
    })
  );
  // Retain ancestry only during reconciliation; the supervisor prunes idle metadata.
  return [
    ...metadata
      .filter(item => !observations.has(item.id))
      .map(item => ({ ...item, status: 'idle' as const, messages: [], interactions: [] })),
    ...observations.values(),
  ];
}
