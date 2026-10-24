import type {
  Part,
  SessionStatus,
  Session,
  UserMessage,
  AssistantMessage,
  QuestionInfo,
} from '@/types/opencode.gen';

export type ProcessedMessage = {
  info: UserMessage | AssistantMessage;
  parts: Part[];
};

export type AutocommitStatus = {
  status: 'in_progress' | 'completed' | 'failed';
  message: string;
  timestamp: string;
  commitHash?: string;
  commitMessage?: string;
};

export type EventProcessorCallbacks = {
  onMessageUpdated?: (
    sessionId: string,
    messageId: string,
    message: ProcessedMessage,
    parentSessionId: string | null
  ) => void;

  /** Called when a message is complete (all parts finished, info.time.completed set for assistant) */
  onMessageCompleted?: (
    sessionId: string,
    messageId: string,
    message: ProcessedMessage,
    parentSessionId: string | null
  ) => void;

  onPartUpdated?: (
    sessionId: string,
    messageId: string,
    partId: string,
    part: Part,
    parentSessionId: string | null
  ) => void;

  onPartRemoved?: (
    sessionId: string,
    messageId: string,
    partId: string,
    parentSessionId: string | null
  ) => void;

  onSessionStatusChanged?: (status: SessionStatus) => void;

  onSessionCreated?: (sessionInfo: Session) => void;

  onSessionUpdated?: (sessionInfo: Session) => void;

  onError?: (error: string, sessionId?: string) => void;

  onStreamingChanged?: (isStreaming: boolean) => void;

  onQuestionAsked?: (requestId: string, callId: string) => void;

  onStandaloneQuestionAsked?: (requestId: string, questions: QuestionInfo[]) => void;

  /** Called when a question is answered or rejected (question.replied / question.rejected) */
  onQuestionResolved?: (requestId: string) => void;

  onAutocommitUpdated?: (messageId: string, status: AutocommitStatus) => void;

  /** Called when the current branch changes (from complete event) */
  onBranchChanged?: (branch: string) => void;
};

export type EventProcessorConfig = {
  callbacks?: EventProcessorCallbacks;
};
