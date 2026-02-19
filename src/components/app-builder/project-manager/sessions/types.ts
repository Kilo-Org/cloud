/**
 * Discriminated union types for V1 and V2 app builder sessions.
 * Each session is a self-contained unit with its own store and streaming.
 */

import type { CloudMessage } from '@/components/cloud-agent/types';
import type { StoredMessage } from '@/components/cloud-agent-next/types';
import type { Images } from '@/lib/images-schema';
import type { ProjectSessionInfo } from '@/lib/app-builder/types';
import type { SessionState, SessionStore } from './session-store';

export type V1SessionState = SessionState<CloudMessage>;
export type V2SessionState = SessionState<StoredMessage>;

export type V1SessionStore = SessionStore<CloudMessage>;
export type V2SessionStore = SessionStore<StoredMessage>;

/** Common session shape shared by V1 and V2 */
export type SessionBase = {
  info: ProjectSessionInfo;
  subscribe: (listener: () => void) => () => void;
  sendMessage: (text: string, images: Images | undefined, model: string) => Promise<void>;
  interrupt: () => Promise<void>;
  startInitialStreaming: () => void;
  connectToExistingSession: (sessionId: string) => void;
  destroy: () => void;
};

export type V1Session = SessionBase & {
  type: 'v1';
  getState: () => V1SessionState;
};

export type V2Session = SessionBase & {
  type: 'v2';
  getState: () => V2SessionState;
};

export type AppBuilderSession = V1Session | V2Session;
