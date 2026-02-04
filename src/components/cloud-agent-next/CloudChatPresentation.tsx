/**
 * CloudChatPresentation - Pure rendering component
 *
 * Receives all display data and callbacks as props.
 * No hooks, no effects, no business logic - just pure rendering.
 * Wrapped with React.memo for performance optimization.
 */

import React, { memo, type RefObject } from 'react';
import { OrgContextModal } from './OrgContextModal';
import { ResumeConfigModal, type ResumeConfig, VALID_MODE_VALUES } from './ResumeConfigModal';
import { OldSessionBanner } from './OldSessionBanner';
import { ChatSidebar } from './ChatSidebar';
import { ChatHeader } from './ChatHeader';
import { ChatInput } from './ChatInput';
import { ErrorBanner } from './ErrorBanner';
import { MessageErrorBoundary } from './MessageErrorBoundary';
import { MessageBubble } from './MessageBubble';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { ArrowDown, RefreshCw } from 'lucide-react';
import type { AgentMode, SessionConfig, StoredSession, StoredMessage } from './types';
import { isMessageStreaming } from './types';
import type { DbSessionDetails, IndexedDbSessionData } from './store/db-session-atoms';
import type { ModelOption } from '@/components/shared/ModelCombobox';
import type { SlashCommand } from '@/lib/cloud-agent/slash-commands';

// V2: No conversion needed - StoredMessage format is used directly by MessageBubble

/**
 * Static messages component - memoized, never re-renders
 * V2: Accepts StoredMessage[] directly, no conversion needed
 */
const StaticMessages = memo(
  ({
    messages,
    getChildMessages,
  }: {
    messages: StoredMessage[];
    getChildMessages?: (sessionId: string) => StoredMessage[];
  }) => {
    return (
      <>
        {messages.map(msg => (
          <MessageErrorBoundary key={msg.info.id}>
            <MessageBubble message={msg} getChildMessages={getChildMessages} />
          </MessageErrorBoundary>
        ))}
      </>
    );
  }
);
StaticMessages.displayName = 'StaticMessages';

/**
 * Dynamic messages component - re-renders during streaming
 * V2: Uses isMessageStreaming() for streaming detection
 * Key includes streaming state to force re-render when message completes
 */
function DynamicMessages({
  messages,
  getChildMessages,
}: {
  messages: StoredMessage[];
  getChildMessages?: (sessionId: string) => StoredMessage[];
}) {
  return (
    <>
      {messages.map(msg => {
        const streaming = isMessageStreaming(msg);
        return (
          <MessageErrorBoundary key={`${msg.info.id}-${streaming ? 'streaming' : 'complete'}`}>
            <MessageBubble
              message={msg}
              isStreaming={streaming}
              getChildMessages={getChildMessages}
            />
          </MessageErrorBoundary>
        );
      })}
    </>
  );
}

/**
 * Props for CloudChatPresentation component
 */
export type CloudChatPresentationProps = {
  // Organization context
  organizationId?: string;

  // Display data (V2 format)
  staticMessages: StoredMessage[];
  dynamicMessages: StoredMessage[];
  sessions: StoredSession[];
  currentSessionId: string | null;
  currentDbSessionId: string | null;
  cloudAgentSessionId: string | null;
  sessionConfig: SessionConfig | null;
  totalCost: number;
  error: string | null;

  // UI state
  isStreaming: boolean;
  isLoadingFromDb: boolean;
  isStale: boolean;
  isSessionInitiated: boolean;
  showScrollButton: boolean;
  mobileSheetOpen: boolean;
  soundEnabled: boolean;

  // Modal state
  showOrgContextModal: boolean;
  showResumeModal: boolean;
  pendingSessionForOrgContext: IndexedDbSessionData | null;
  pendingResumeSession: DbSessionDetails | null;
  pendingGitState: { branch?: string } | null;

  // Config state
  needsResumeConfig: boolean;
  resumeConfigPersisting: boolean;
  resumeConfigFailed: boolean;
  resumeConfigError: string | null;

  // Resume modal options
  modelOptions: ModelOption[];
  isLoadingModels: boolean;
  defaultModel: string | undefined;

  // Slash commands
  availableCommands: SlashCommand[];

  // Refs (can be null initially)
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  messagesEndRef: RefObject<HTMLDivElement | null>;

  // Stream resume config (for input enabling)
  streamResumeConfig: {
    mode: string;
    model: string;
    githubRepo: string;
  } | null;

  // Child session messages function
  getChildMessages?: (sessionId: string) => StoredMessage[];

  // Callbacks
  onSendMessage: (message: string) => void;
  onStopExecution: () => void;
  onRefresh: () => void;
  onNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onDismissError: () => void;
  onOrgContextConfirm: (orgContext: { organizationId: string } | null) => void;
  onOrgContextClose: () => void;
  onResumeConfirm: (config: ResumeConfig) => Promise<void>;
  onResumeClose: () => void;
  onReopenResumeModal: () => void;
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void;
  onScrollToBottom: () => void;
  onToggleSound: () => void;
  onMenuClick: () => void;
  onMobileSheetOpenChange: (open: boolean) => void;

  // Old session handling
  isOldSession?: boolean;

  // Input toolbar state and callbacks
  inputMode?: AgentMode;
  inputModel?: string;
  onInputModeChange?: (mode: AgentMode) => void;
  onInputModelChange?: (model: string) => void;
};

/**
 * Pure presentational component for cloud chat
 * Zero hooks, zero effects, just rendering
 */
export const CloudChatPresentation = memo(function CloudChatPresentation({
  organizationId,
  staticMessages,
  dynamicMessages,
  sessions,
  currentSessionId,
  currentDbSessionId,
  cloudAgentSessionId,
  sessionConfig,
  totalCost,
  error,
  isStreaming,
  isLoadingFromDb,
  isStale,
  isSessionInitiated,
  showScrollButton,
  mobileSheetOpen,
  soundEnabled,
  showOrgContextModal,
  showResumeModal,
  pendingSessionForOrgContext,
  pendingResumeSession,
  pendingGitState,
  needsResumeConfig,
  resumeConfigPersisting,
  resumeConfigFailed,
  resumeConfigError,
  modelOptions,
  isLoadingModels,
  defaultModel,
  availableCommands,
  scrollContainerRef,
  messagesEndRef,
  streamResumeConfig,
  onSendMessage,
  onStopExecution,
  onRefresh,
  onNewSession,
  onSelectSession,
  onDeleteSession,
  onDismissError,
  onOrgContextConfirm,
  onOrgContextClose,
  onResumeConfirm,
  onResumeClose,
  onReopenResumeModal,
  onScroll,
  onScrollToBottom,
  onToggleSound,
  onMenuClick,
  onMobileSheetOpenChange,
  isOldSession = false,
  getChildMessages,
  inputMode,
  inputModel,
  onInputModeChange,
  onInputModelChange,
}: CloudChatPresentationProps) {
  // Show chat interface when we have:
  // 1. An active streaming session (currentSessionId + sessionConfig)
  // 2. A loaded DB session (currentDbSessionId present)
  const showChatInterface =
    Boolean(currentSessionId && sessionConfig) || Boolean(currentDbSessionId);

  return (
    <div className="flex h-dvh w-full overflow-hidden">
      {/* Org Context Modal */}
      <OrgContextModal
        isOpen={showOrgContextModal}
        onClose={onOrgContextClose}
        onConfirm={onOrgContextConfirm}
        sessionTitle={pendingSessionForOrgContext?.title ?? null}
      />

      {/* Resume Config Modal */}
      {pendingResumeSession && (
        <ResumeConfigModal
          isOpen={showResumeModal}
          onClose={onResumeClose}
          onConfirm={onResumeConfirm}
          session={{
            session_id: pendingResumeSession.session_id,
            git_url: pendingResumeSession.git_url ?? null,
            title: pendingResumeSession.title,
          }}
          gitState={pendingGitState}
          modelOptions={modelOptions}
          isLoadingModels={isLoadingModels}
          defaultMode={
            pendingResumeSession.last_mode &&
            (VALID_MODE_VALUES as readonly string[]).includes(pendingResumeSession.last_mode)
              ? (pendingResumeSession.last_mode as ResumeConfig['mode'])
              : undefined
          }
          defaultModel={
            pendingResumeSession.last_model &&
            modelOptions.some(m => m.id === pendingResumeSession.last_model)
              ? pendingResumeSession.last_model
              : defaultModel
          }
        />
      )}

      {/* Mobile Sheet */}
      <Sheet open={mobileSheetOpen} onOpenChange={onMobileSheetOpenChange}>
        <SheetContent side="left" className="w-80 p-0 lg:hidden">
          <SheetHeader className="sr-only">
            <SheetTitle>Sessions</SheetTitle>
          </SheetHeader>
          <ChatSidebar
            sessions={sessions}
            currentSessionId={currentSessionId || undefined}
            organizationId={organizationId}
            onNewSession={onNewSession}
            onSelectSession={sessionId => {
              onSelectSession(sessionId);
              onMobileSheetOpenChange(false);
            }}
            onDeleteSession={onDeleteSession}
            isInSheet={true}
          />
        </SheetContent>
      </Sheet>

      {/* Desktop Sidebar */}
      <div className="hidden w-80 border-r lg:block">
        <ChatSidebar
          sessions={sessions}
          currentSessionId={currentSessionId || undefined}
          organizationId={organizationId}
          onNewSession={onNewSession}
          onSelectSession={onSelectSession}
          onDeleteSession={onDeleteSession}
        />
      </div>

      {/* Main Chat Area */}
      <div className="flex min-h-0 w-full max-w-full flex-1 flex-col overflow-x-hidden">
        {showChatInterface ? (
          <>
            {/* Header */}
            <ChatHeader
              cloudAgentSessionId={currentSessionId || 'Starting session...'}
              kiloSessionId={currentDbSessionId || undefined}
              repository={sessionConfig?.repository || 'Loading...'}
              branch={currentSessionId || undefined}
              model={sessionConfig?.model}
              isStreaming={isStreaming}
              totalCost={totalCost}
              onMenuClick={onMenuClick}
              soundEnabled={soundEnabled}
              onToggleSound={onToggleSound}
              sessionTitle={pendingResumeSession?.title ?? undefined}
            />

            {error && (
              <div className="p-4">
                <ErrorBanner message={error} onDismiss={onDismissError} />
              </div>
            )}

            {/* Staleness Banner */}
            {isStale && (
              <div className="flex items-center justify-center gap-2 border-b border-yellow-500/50 bg-yellow-900/50 p-3 text-center text-sm text-yellow-200">
                <span>Session has been updated elsewhere.</span>
                <button
                  onClick={onRefresh}
                  disabled={isLoadingFromDb}
                  className="inline-flex items-center gap-1 font-medium underline hover:no-underline disabled:opacity-50"
                >
                  <RefreshCw className={`h-3 w-3 ${isLoadingFromDb ? 'animate-spin' : ''}`} />
                  Refresh to see latest
                </button>
              </div>
            )}

            {/* Loading indicator for DB session load */}
            {isLoadingFromDb && (
              <div className="flex items-center justify-center gap-2 border-b border-blue-500/50 bg-blue-500/20 p-3 text-center text-sm">
                <RefreshCw className="h-3 w-3 animate-spin" />
                <span>Loading session...</span>
              </div>
            )}

            {/* Old session banner */}
            {isOldSession && (
              <div className="p-4">
                <OldSessionBanner onStartNewSession={onNewSession} />
              </div>
            )}

            {/* Config persistence status */}
            {resumeConfigPersisting && (
              <div className="flex items-center justify-center gap-2 border-b border-blue-500/50 bg-blue-500/20 p-3 text-center text-sm">
                <RefreshCw className="h-3 w-3 animate-spin" />
                <span>Saving configuration...</span>
              </div>
            )}

            {resumeConfigFailed && resumeConfigError && (
              <div className="flex items-center justify-center gap-2 border-b border-red-500/50 bg-red-900/50 p-3 text-center text-sm text-red-200">
                <span>Failed to save configuration: {resumeConfigError}</span>
                <button
                  onClick={onReopenResumeModal}
                  className="inline-flex items-center gap-1 font-medium underline hover:no-underline"
                >
                  Try again
                </button>
              </div>
            )}

            <div className="relative min-h-0 flex-1">
              <div
                ref={scrollContainerRef}
                onScroll={onScroll}
                className="absolute inset-0 w-full max-w-full overflow-x-hidden overflow-y-auto p-4"
              >
                {/* Static messages - never re-render */}
                <StaticMessages messages={staticMessages} getChildMessages={getChildMessages} />

                {/* Dynamic messages - re-render during streaming */}
                <DynamicMessages messages={dynamicMessages} getChildMessages={getChildMessages} />

                {/* Invisible anchor for auto-scroll */}
                <div ref={messagesEndRef} />
              </div>

              {/* Scroll to bottom button */}
              {showScrollButton && (
                <div className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={onScrollToBottom}
                    className="shadow-lg"
                  >
                    <ArrowDown className="mr-1 h-3 w-3" />
                    Scroll to bottom
                  </Button>
                </div>
              )}
            </div>

            <ChatInput
              onSend={onSendMessage}
              onStop={onStopExecution}
              disabled={
                isStreaming ||
                needsResumeConfig ||
                isOldSession ||
                // Disable while a prepared session is auto-initiating (prevents dropped messages)
                (cloudAgentSessionId && !isSessionInitiated) ||
                // Allow sending if:
                // 1. We have an active cloud session (currentSessionId), OR
                // 2. We have streamResumeConfig ready for CLI sessions, OR
                // 3. We have cloudAgentSessionId for web sessions (ready for initiateFromKilocodeSession)
                (!currentSessionId && !streamResumeConfig && !cloudAgentSessionId)
              }
              isStreaming={isStreaming}
              placeholder={
                isOldSession
                  ? 'This session uses a legacy format. Please start a new session.'
                  : cloudAgentSessionId && !isSessionInitiated
                    ? 'Initializing session...'
                    : needsResumeConfig
                      ? 'Configure session to continue...'
                      : isStreaming
                        ? 'Streaming...'
                        : 'Type your message... (/ for commands)'
              }
              slashCommands={availableCommands}
              mode={inputMode}
              model={inputModel}
              modelOptions={modelOptions}
              isLoadingModels={isLoadingModels}
              onModeChange={onInputModeChange}
              onModelChange={onInputModelChange}
              showToolbar={Boolean(currentDbSessionId) && !needsResumeConfig}
            />

            {/* Banner for sessions needing configuration */}
            {needsResumeConfig && !showResumeModal && (
              <div className="flex items-center justify-center gap-2 border-t border-amber-500/50 bg-amber-500/20 p-3 text-center text-sm">
                <span>This session needs configuration before you can send messages.</span>
                <button
                  onClick={onReopenResumeModal}
                  className="inline-flex items-center gap-1 font-medium underline hover:no-underline"
                >
                  Configure now
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="flex h-full items-center justify-center">
            <div className="text-center text-gray-500">
              <p className="text-lg">No active session</p>
              <p className="mt-2 text-sm">Select a session from the sidebar or create a new one</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
