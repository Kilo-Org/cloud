import { atom } from 'jotai';
import type { AgentMode } from '@/src/shared/agent-conversation';

export const settingsDialogOpenAtom = atom(false);

/** The agent mode of the active conversation. Undefined when not yet wired. */
export const conversationModeAtom = atom<AgentMode | undefined>();

/** The id of the active conversation. Undefined when not yet wired. */
export const activeConversationIdAtom = atom<string | undefined>();
