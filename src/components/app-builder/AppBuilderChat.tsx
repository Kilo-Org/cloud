/**
 * App Builder Chat
 *
 * Chat pane component with messages and input.
 * Uses ProjectSession context hooks for state and actions.
 * Supports model selection during chat via inline model selector.
 *
 * Renders sessions from state.sessions — each session subscribes to its
 * own store via useSyncExternalStore and renders V1 or V2 messages.
 */

'use client';

import React, {
  useState,
  useRef,
  useEffect,
  useMemo,
  memo,
  useCallback,
  useSyncExternalStore,
} from 'react';
import { User, ArrowDown } from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';
import AssistantLogo from '@/components/AssistantLogo';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { MessageContent } from '@/components/cloud-agent/MessageContent';
import { TypingIndicator } from '@/components/cloud-agent/TypingIndicator';
import type { CloudMessage } from '@/components/cloud-agent/types';
import type { StoredMessage } from '@/components/cloud-agent-next/types';
import { isMessageStreaming } from '@/components/cloud-agent-next/types';
import { MessageBubble as V2MessageBubble } from '@/components/cloud-agent-next/MessageBubble';
import type { AppBuilderSession, V1Session, V2Session } from './project-manager/types';
import {
  filterAppBuilderMessages,
  paginateMessages,
  getMessageRole,
  DEFAULT_VISIBLE_SESSIONS,
} from './utils/filterMessages';
import { PromptInput } from '@/components/app-builder/PromptInput';
import { useProject } from './ProjectSession';
import type { Images } from '@/lib/images-schema';
import type { ModelOption } from '@/components/shared/ModelCombobox';

import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';
import { InsufficientBalanceBanner } from '@/components/shared/InsufficientBalanceBanner';
import { useModelSelectorList } from '@/app/api/openrouter/hooks';
import { useOrganizationDefaults } from '@/app/api/organizations/hooks';
import { FeedbackDialog } from './FeedbackDialog';

type AppBuilderChatProps = {
  organizationId?: string;
};

const isDev = process.env.NODE_ENV === 'development';

/**
 * Timestamp display with optional tooltip showing full time in dev mode
 */
function TimestampDisplay({ ts }: { ts: number }) {
  const timeAgo = formatDistanceToNow(new Date(ts), { addSuffix: true });

  if (isDev) {
    const fullTime = format(new Date(ts), 'yyyy-MM-dd HH:mm:ss.SSS');
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="text-muted-foreground text-xs">{timeAgo}</span>
        </TooltipTrigger>
        <TooltipContent>
          <span className="font-mono">{fullTime}</span>
        </TooltipContent>
      </Tooltip>
    );
  }

  return <span className="text-muted-foreground text-xs">{timeAgo}</span>;
}

/**
 * User message bubble component
 */
function UserMessageBubble({ message }: { message: CloudMessage }) {
  return (
    <div className="flex items-start justify-end gap-2 py-4 md:gap-3">
      <div className="flex flex-1 flex-col items-end space-y-1">
        <div className="flex items-center gap-2">
          <TimestampDisplay ts={message.ts} />
          <span className="text-sm font-medium text-zinc-100">You</span>
        </div>
        <div className="bg-primary text-primary-foreground max-w-[95%] rounded-lg p-3 sm:max-w-[85%] md:max-w-[80%] md:p-4">
          <p className="overflow-wrap-anywhere text-sm wrap-break-word whitespace-pre-wrap">
            {message.text || message.content}
          </p>
        </div>
      </div>
      <div className="bg-primary flex h-7 w-7 shrink-0 items-center justify-center rounded-full md:h-8 md:w-8">
        <User className="h-4 w-4 text-white" />
      </div>
    </div>
  );
}

/**
 * Assistant/System message bubble component
 */
function AssistantMessageBubble({
  message,
  isStreaming,
}: {
  message: CloudMessage;
  isStreaming?: boolean;
}) {
  const content = message.text || message.content || '';

  return (
    <div className="flex items-start gap-2 py-4 md:gap-3">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full md:h-8 md:w-8">
        <AssistantLogo />
      </div>
      <div className="min-w-0 flex-1 space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-100">App Builder</span>
          <TimestampDisplay ts={message.ts} />
          {isStreaming && message.partial && (
            <span className="text-muted-foreground flex items-center gap-1 text-xs">
              <span className="relative flex h-2 w-2">
                <span className="bg-primary absolute inline-flex h-full w-full animate-ping rounded-full opacity-75" />
                <span className="bg-primary relative inline-flex h-2 w-2 rounded-full" />
              </span>
              Streaming...
            </span>
          )}
        </div>
        <MessageContent
          content={content}
          say={message.say}
          ask={message.ask}
          metadata={message.metadata}
          partial={message.partial}
          isStreaming={isStreaming && message.partial}
        />
      </div>
    </div>
  );
}

/**
 * Memoized static messages - never re-render once complete
 */
const StaticMessages = memo(function StaticMessages({ messages }: { messages: CloudMessage[] }) {
  return (
    <>
      {messages.map(msg => {
        const role = getMessageRole(msg);
        if (role === 'user') {
          return <UserMessageBubble key={msg.ts} message={msg} />;
        }
        return <AssistantMessageBubble key={msg.ts} message={msg} />;
      })}
    </>
  );
});

/**
 * Dynamic messages - re-render during streaming
 */
function DynamicMessages({
  messages,
  isStreaming,
}: {
  messages: CloudMessage[];
  isStreaming: boolean;
}) {
  return (
    <>
      {messages.map(msg => {
        const role = getMessageRole(msg);
        if (role === 'user') {
          return <UserMessageBubble key={`${msg.ts}-${msg.partial}`} message={msg} />;
        }
        return (
          <AssistantMessageBubble
            key={`${msg.ts}-${msg.partial}`}
            message={msg}
            isStreaming={isStreaming}
          />
        );
      })}
    </>
  );
}

/**
 * Collapsed session block for ended sessions
 */
function CollapsedSessionBlock({ session }: { session: AppBuilderSession }) {
  const date = new Date(session.info.created_at);
  const timeAgo = formatDistanceToNow(date, { addSuffix: true });
  const versionLabel = session.type === 'v2' ? 'V2' : 'V1';

  return (
    <div className="border-b py-2">
      <div className="text-muted-foreground flex w-full items-center gap-2 px-2 py-1 text-xs">
        <span className="font-mono text-[10px] opacity-50">{versionLabel}</span>
        <span>Session ended {timeAgo}</span>
      </div>
    </div>
  );
}

/**
 * Memoized static V2 messages - never re-render once complete
 */
const V2StaticMessages = memo(function V2StaticMessages({
  messages,
}: {
  messages: StoredMessage[];
}) {
  return (
    <>
      {messages.map(msg => (
        <V2MessageBubble key={msg.info.id} message={msg} />
      ))}
    </>
  );
});

/**
 * V2 dynamic messages (streaming)
 */
function V2DynamicMessages({ messages }: { messages: StoredMessage[] }) {
  return (
    <>
      {messages.map(msg => {
        const streaming = isMessageStreaming(msg);
        return (
          <V2MessageBubble
            key={`${msg.info.id}-${streaming ? 'streaming' : 'complete'}`}
            message={msg}
            isStreaming={streaming}
          />
        );
      })}
    </>
  );
}

/**
 * Renders a V1 session's messages with filtering and pagination.
 */
function V1SessionMessages({
  session,
  visibleSessionCount,
  onLoadMore,
}: {
  session: V1Session;
  visibleSessionCount: number;
  onLoadMore: () => void;
}) {
  const sessionState = useSyncExternalStore(session.subscribe, session.getState);

  const filteredMessages = useMemo(
    () => filterAppBuilderMessages(sessionState.messages),
    [sessionState.messages]
  );

  const { visibleMessages, hasOlderMessages } = useMemo(
    () => paginateMessages(filteredMessages, visibleSessionCount),
    [filteredMessages, visibleSessionCount]
  );

  const { staticMessages, dynamicMessages } = useMemo(() => {
    const staticMsgs: CloudMessage[] = [];
    const dynamicMsgs: CloudMessage[] = [];
    for (const msg of visibleMessages) {
      if (msg.partial) {
        dynamicMsgs.push(msg);
      } else {
        staticMsgs.push(msg);
      }
    }
    return { staticMessages: staticMsgs, dynamicMessages: dynamicMsgs };
  }, [visibleMessages]);

  if (visibleMessages.length === 0) {
    return null;
  }

  return (
    <>
      {hasOlderMessages && (
        <div className="flex justify-center py-2">
          <Button variant="ghost" size="sm" onClick={onLoadMore}>
            Load earlier messages
          </Button>
        </div>
      )}
      <StaticMessages messages={staticMessages} />
      <DynamicMessages messages={dynamicMessages} isStreaming={sessionState.isStreaming} />
      {sessionState.isStreaming && dynamicMessages.length === 0 && <TypingIndicator />}
    </>
  );
}

/**
 * Renders a V2 session's messages.
 */
function V2SessionMessages({ session }: { session: V2Session }) {
  const sessionState = useSyncExternalStore(session.subscribe, session.getState);

  const { v2Static, v2Dynamic } = useMemo(() => {
    const staticMsgs: StoredMessage[] = [];
    const dynamicMsgs: StoredMessage[] = [];
    for (const msg of sessionState.messages) {
      if (isMessageStreaming(msg)) {
        dynamicMsgs.push(msg);
      } else {
        staticMsgs.push(msg);
      }
    }
    return { v2Static: staticMsgs, v2Dynamic: dynamicMsgs };
  }, [sessionState.messages]);

  if (sessionState.messages.length === 0 && !sessionState.isStreaming) {
    return null;
  }

  return (
    <>
      <V2StaticMessages messages={v2Static} />
      <V2DynamicMessages messages={v2Dynamic} />
      {sessionState.isStreaming && v2Dynamic.length === 0 && <TypingIndicator />}
    </>
  );
}

/**
 * Renders a single session — collapsed if not the active session, or full messages if active.
 */
function SessionMessages({
  session,
  isLast,
  visibleSessionCount,
  onLoadMore,
}: {
  session: AppBuilderSession;
  isLast: boolean;
  visibleSessionCount: number;
  onLoadMore: () => void;
}) {
  if (!isLast) {
    return <CollapsedSessionBlock session={session} />;
  }

  if (session.type === 'v2') {
    return <V2SessionMessages session={session} />;
  }

  return (
    <V1SessionMessages
      session={session}
      visibleSessionCount={visibleSessionCount}
      onLoadMore={onLoadMore}
    />
  );
}

/**
 * Main chat component
 */
export function AppBuilderChat({ organizationId }: AppBuilderChatProps) {
  // Get state and manager from ProjectSession context
  const { manager, state } = useProject();
  const { isStreaming, isInterrupting, model: projectModel, sessions } = state;

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const [messageUuid, setMessageUuid] = useState(() => crypto.randomUUID());
  const [selectedModel, setSelectedModel] = useState<string>(projectModel ?? '');
  const [hasImages, setHasImages] = useState(false);
  // Track the initial projectModel to detect when a new project loads
  const initialProjectModelRef = useRef(projectModel);
  const [visibleSessionCount, setVisibleSessionCount] = useState(DEFAULT_VISIBLE_SESSIONS);
  const trpc = useTRPC();

  // Reset pagination when project/manager changes
  useEffect(() => {
    setVisibleSessionCount(DEFAULT_VISIBLE_SESSIONS);
  }, [manager]);

  // Fetch eligibility to check if user can use App Builder
  const personalEligibilityQuery = useQuery({
    ...trpc.appBuilder.checkEligibility.queryOptions(),
    enabled: !organizationId,
  });
  const orgEligibilityQuery = useQuery({
    ...trpc.organizations.appBuilder.checkEligibility.queryOptions({
      organizationId: organizationId || '',
    }),
    enabled: !!organizationId,
  });
  const eligibilityData = organizationId ? orgEligibilityQuery.data : personalEligibilityQuery.data;
  const isEligibilityLoading = organizationId
    ? orgEligibilityQuery.isPending
    : personalEligibilityQuery.isPending;
  // Access levels: 'full' = all models, 'limited' = free models only, 'blocked' = cannot use
  // Cast to include 'blocked' so UI can handle it even though server currently returns only 'full' or 'limited'
  const accessLevel = (eligibilityData?.accessLevel ?? 'full') as 'full' | 'limited' | 'blocked';
  const hasLimitedAccess = !isEligibilityLoading && accessLevel === 'limited';
  const isBlocked = !isEligibilityLoading && accessLevel === 'blocked';

  // Fetch organization configuration and models for the model selector
  const { data: modelsData, isLoading: isLoadingModels } = useModelSelectorList(organizationId);
  const { data: defaultsData } = useOrganizationDefaults(organizationId);

  const allModels = modelsData?.data || [];

  // When user has limited access, only show free models
  const availableModels = useMemo(() => {
    let models = allModels;

    // If user has limited access, filter to only free models
    if (hasLimitedAccess) {
      models = models.filter(m => {
        const promptPrice = parseFloat(m.pricing.prompt);
        const completionPrice = parseFloat(m.pricing.completion);
        return promptPrice === 0 && completionPrice === 0;
      });
    }

    return models;
  }, [allModels, hasLimitedAccess]);

  // Format models for the combobox (ModelOption format: id, name, supportsVision)
  const modelOptions = useMemo<ModelOption[]>(
    () =>
      availableModels.map(m => {
        const inputModalities = m.architecture?.input_modalities || [];
        const supportsVision =
          inputModalities.includes('image') || inputModalities.includes('image_url');
        return { id: m.id, name: m.name, supportsVision };
      }),
    [availableModels]
  );

  // Check if the selected model supports images (vision)
  const selectedModelData = useMemo(
    () => availableModels.find(m => m.id === selectedModel),
    [availableModels, selectedModel]
  );

  const modelSupportsImages = useMemo(() => {
    if (!selectedModelData) return false;
    const inputModalities = selectedModelData.architecture?.input_modalities || [];
    return inputModalities.includes('image') || inputModalities.includes('image_url');
  }, [selectedModelData]);

  // Warning state: user uploaded images but model doesn't support them
  const hasImageWarning = hasImages && !modelSupportsImages;

  // Sync selectedModel when a different project loads (projectModel changes from initial)
  useEffect(() => {
    if (projectModel && projectModel !== initialProjectModelRef.current) {
      initialProjectModelRef.current = projectModel;
      setSelectedModel(projectModel);
    }
  }, [projectModel]);

  // Set fallback model when models load and no valid selection exists
  useEffect(() => {
    if (modelOptions.length === 0) {
      return;
    }

    // If current selection is valid, keep it
    if (selectedModel && modelOptions.some(m => m.id === selectedModel)) {
      return;
    }

    // Pick a default model
    const defaultModel = defaultsData?.defaultModel;
    const isDefaultAllowed = defaultModel && modelOptions.some(m => m.id === defaultModel);
    const newModel = isDefaultAllowed ? defaultModel : modelOptions[0]?.id;
    if (newModel) {
      setSelectedModel(newModel);
    }
  }, [defaultsData?.defaultModel, modelOptions, selectedModel]);

  // Subscribe to active session for auto-scroll
  const activeSession = sessions.length > 0 ? sessions[sessions.length - 1] : undefined;
  const activeSessionMessages = useActiveSessionMessages(activeSession);

  // Auto-scroll effect
  useEffect(() => {
    if (shouldAutoScroll && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({
        top: scrollContainerRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
  }, [activeSessionMessages, shouldAutoScroll]);

  // Handle scroll events
  const handleScroll = () => {
    if (!scrollContainerRef.current) return;

    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;

    setShowScrollButton(!isNearBottom);
    setShouldAutoScroll(isNearBottom);
  };

  // Scroll to bottom
  const scrollToBottom = () => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({
        top: scrollContainerRef.current.scrollHeight,
        behavior: 'smooth',
      });
      setShouldAutoScroll(true);
      setShowScrollButton(false);
    }
  };

  // Handle send message using ProjectManager
  const handleSendMessage = useCallback(
    async (value: string, images?: Images): Promise<void> => {
      manager.sendMessage(value, images, selectedModel || undefined);
      // PromptInput clears itself internally after successful submit
      setMessageUuid(crypto.randomUUID());
    },
    [manager, selectedModel]
  );

  // Handle model change - stable callback for PromptInput memoization
  const handleModelChange = useCallback((newModel: string) => {
    setSelectedModel(newModel);
  }, []);

  // Handle images change - stable callback for PromptInput memoization
  const handleImagesChange = useCallback((hasUploadedImages: boolean) => {
    setHasImages(hasUploadedImages);
  }, []);

  // Handle interrupt using ProjectManager
  const handleInterrupt = useCallback(() => {
    manager.interrupt();
  }, [manager]);

  // Handle loading more messages (for V1 pagination)
  const handleLoadMore = useCallback(() => {
    setVisibleSessionCount(prev => prev + 1);
  }, []);

  // Check if input should be disabled (no messages in any session yet)
  const hasAnyMessages = activeSessionMessages.length > 0;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex h-12 items-center justify-between gap-4 border-b px-4">
        <h2 className="shrink-0 text-sm font-medium">Chat</h2>
        <FeedbackDialog disabled={isStreaming} organizationId={organizationId} />
      </div>

      {/* Blocked Banner - show when user cannot use App Builder at all */}
      {isBlocked && eligibilityData && (
        <div className="border-b p-3">
          <InsufficientBalanceBanner
            balance={eligibilityData.balance}
            variant="compact"
            organizationId={organizationId}
            content={{ type: 'productName', productName: 'App Builder' }}
          />
        </div>
      )}

      {/* Messages Area */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="absolute inset-0 overflow-x-hidden overflow-y-auto p-4"
        >
          {sessions.length === 0 || (!hasAnyMessages && !isStreaming) ? (
            <div className="flex h-full items-center justify-center">
              <div className="text-center text-gray-400">
                <p className="text-sm">Start building your app</p>
                <p className="mt-1 text-xs text-gray-500">Describe what you want to create</p>
              </div>
            </div>
          ) : (
            sessions.map((session, index) => (
              <SessionMessages
                key={session.info.id}
                session={session}
                isLast={index === sessions.length - 1}
                visibleSessionCount={visibleSessionCount}
                onLoadMore={handleLoadMore}
              />
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Scroll to bottom button */}
        {showScrollButton && (
          <div className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2">
            <Button size="sm" variant="secondary" onClick={scrollToBottom} className="shadow-lg">
              <ArrowDown className="mr-1 h-3 w-3" />
              Scroll to bottom
            </Button>
          </div>
        )}
      </div>

      {/* Input Area - disabled only when blocked, limited access users can continue */}
      <PromptInput
        variant="chat"
        onSubmit={handleSendMessage}
        messageUuid={messageUuid}
        organizationId={organizationId}
        placeholder={isStreaming ? 'Building...' : 'Describe changes to your app...'}
        disabled={!hasAnyMessages || isBlocked}
        isSubmitting={isStreaming}
        onInterrupt={handleInterrupt}
        isInterrupting={isInterrupting}
        onImagesChange={handleImagesChange}
        models={modelOptions}
        selectedModel={selectedModel}
        onModelChange={handleModelChange}
        isLoadingModels={isLoadingModels}
        warningMessage={
          hasImageWarning
            ? 'The selected model does not support images. Please remove the images or select a different model that supports vision.'
            : undefined
        }
      />
    </div>
  );
}

// =============================================================================
// Hooks
// =============================================================================

/** No-op subscribe for when there's no active session */
function noopSubscribe() {
  return () => {};
}

const EMPTY_MESSAGES: never[] = [];

/**
 * Subscribe to the active session's messages for auto-scroll triggering.
 * Returns the messages array (identity changes when messages update).
 */
function useActiveSessionMessages(session: AppBuilderSession | undefined): readonly unknown[] {
  const v1Messages = useV1Messages(session?.type === 'v1' ? session : undefined);
  const v2Messages = useV2Messages(session?.type === 'v2' ? session : undefined);

  if (!session) return EMPTY_MESSAGES;
  return session.type === 'v1' ? v1Messages : v2Messages;
}

function useV1Messages(session: V1Session | undefined): readonly CloudMessage[] {
  const state = useSyncExternalStore(
    session?.subscribe ?? noopSubscribe,
    session?.getState ?? emptyV1State
  );
  return state.messages;
}

function useV2Messages(session: V2Session | undefined): readonly StoredMessage[] {
  const state = useSyncExternalStore(
    session?.subscribe ?? noopSubscribe,
    session?.getState ?? emptyV2State
  );
  return state.messages;
}

const EMPTY_V1_STATE = { messages: [] as CloudMessage[], isStreaming: false };
function emptyV1State() {
  return EMPTY_V1_STATE;
}

const EMPTY_V2_STATE = { messages: [] as StoredMessage[], isStreaming: false };
function emptyV2State() {
  return EMPTY_V2_STATE;
}
