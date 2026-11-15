import { type ChatFlag, type ChatFlagApplication } from './chat-flag';

/**
 * A choice that is on disk, on this session unless the case says otherwise.
 * Shared by the two `chat-flag` suites so each case names only the phase it is
 * about.
 */
export const saved = (choice: boolean | null, application: ChatFlagApplication = 'current') =>
  ({ kind: 'saved', choice, application }) satisfies ChatFlag;
