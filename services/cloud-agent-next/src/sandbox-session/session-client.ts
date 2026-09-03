import type { CloudAgentSession } from '../persistence/CloudAgentSession.js';
import type { SandboxSession } from './SandboxSession.js';

export type SessionClient = Pick<
  CloudAgentSession,
  | 'fetch'
  | 'closeOrgStreams'
  | 'getMetadata'
  | 'getRuntimeAuthorizationStatus'
  | 'validateKiloGlobalFeedProducer'
  | 'getLatestAssistantMessage'
  | 'getLatestEventId'
  | 'getMessageResult'
  | 'markAsInterrupted'
  | 'interruptExecution'
  | 'createTerminal'
  | 'resizeTerminal'
  | 'closeTerminal'
  | 'isSandboxCleanupScheduled'
  | 'deleteSession'
  | 'registerSession'
  | 'createSessionWithInitialAdmission'
  | 'tryUpdate'
  | 'getCurrentMessageWork'
  | 'hasMessageAdmission'
  | 'admitSubmittedMessage'
  | 'replayPreparedInitialMessage'
  | 'admitPreparedInitialMessage'
>;

type _CloudAgentSessionIsClient = CloudAgentSession extends SessionClient ? true : false;
const _cloudAgentSessionIsClient: _CloudAgentSessionIsClient = true;
void _cloudAgentSessionIsClient;

type _SandboxSessionIsClient = SandboxSession extends SessionClient ? true : false;
const _sandboxSessionIsClient: _SandboxSessionIsClient = true;
void _sandboxSessionIsClient;
