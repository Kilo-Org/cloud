/**
 * CLI-neutral evidence of model work. Each harness produces it from its own
 * native messages; turn supervision, the session supervisor, and review
 * publication read only this shape. Cloud stores native messages unchanged.
 */
export type ActivityMessage = {
  sessionId: string;
  id: string;
  role: 'user' | 'assistant';
  time?: { created: number; completed?: number };
  /** Present when the native message reports a model or provider error. */
  error?: unknown;
};

export type ActivityTool = {
  callId: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  /** The tool waits for the user, for example a question. */
  interactive: boolean;
  /** The session a subagent tool runs in. */
  childSessionId?: string;
  output?: string;
  error?: string;
};

export type ActivityPart = {
  sessionId: string;
  messageId: string;
  id: string;
  kind: 'text' | 'reasoning' | 'tool';
  text?: string;
  tool?: ActivityTool;
};

export type HarnessActivity =
  | { type: 'message'; message: ActivityMessage }
  | { type: 'part'; part: ActivityPart }
  | { type: 'delta'; sessionId: string; messageId: string; partId: string; text: string };

export type HarnessActivityEvent = {
  activity: HarnessActivity;
  directory?: string;
  nativeRuntimeId: string;
  /** Runtime key of the emitting runtime; see `KiloFeedEvent.runtimeKey`. */
  runtimeKey?: string;
};

/** One message with its parts, as a snapshot reads it. */
export type ActivitySnapshotMessage = ActivityMessage & { parts: ActivityPart[] };

export function activitySessionId(activity: HarnessActivity): string {
  if (activity.type === 'message') return activity.message.sessionId;
  if (activity.type === 'part') return activity.part.sessionId;
  return activity.sessionId;
}

/** Every activity the snapshot message carries, in observation order. */
export function snapshotActivity(message: ActivitySnapshotMessage): HarnessActivity[] {
  const { parts, ...info } = message;
  return [
    { type: 'message', message: info },
    ...parts.map(part => ({ type: 'part' as const, part })),
  ];
}

/** Bounded reads of recent model work, for activity snapshots. */
export type ActivityReads = {
  /** The latest window of messages, oldest first. */
  getRecentActivity(
    sessionId: string,
    directory: string,
    signal: AbortSignal
  ): Promise<ActivitySnapshotMessage[]>;
  getMessageActivity(
    sessionId: string,
    directory: string,
    messageId: string,
    signal: AbortSignal
  ): Promise<ActivitySnapshotMessage>;
};
