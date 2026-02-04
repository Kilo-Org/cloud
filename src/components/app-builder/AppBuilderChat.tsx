/**
 * App Builder Chat
 *
 * Chat pane component with messages and input.
 * Uses ProjectSession context hooks for state and actions.
 * Supports model selection during chat via inline model selector.
 */

'use client';

import React, { useState, useRef, useEffect, useMemo, memo, useCallback } from 'react';
import { User, ArrowDown, RotateCcw } from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';
import AssistantLogo from '@/components/AssistantLogo';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { MessageContent } from '@/components/cloud-agent/MessageContent';
import { TypingIndicator } from '@/components/cloud-agent/TypingIndicator';
import type { CloudMessage } from '@/components/cloud-agent/types';
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
import { useOpenRouterModels } from '@/app/api/openrouter/hooks';
import { useOrganizationWithMembers, useOrganizationDefaults } from '@/app/api/organizations/hooks';

type AppBuilderChatProps = {
  onNewProject: () => void;
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
 * Main chat component
 */
export function AppBuilderChat({ onNewProject, organizationId }: AppBuilderChatProps) {
  // Get state and manager from ProjectSession context
  const { manager, state } = useProject();
  const { messages, isStreaming, isInterrupting, model: projectModel } = state;

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const [messageUuid, setMessageUuid] = useState(() => crypto.randomUUID());
  const [selectedModel, setSelectedModel] = useState<string>(projectModel ?? '');
  const [hasImages, setHasImages] = useState(false);
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
  const { data: organizationData } = useOrganizationWithMembers(organizationId || '', {
    enabled: !!organizationId,
  });
  const { data: modelsData, isLoading: isLoadingModels } = useOpenRouterModels();
  const { data: defaultsData } = useOrganizationDefaults(organizationId);

  // Get organization's allowed models
  const savedModelAllowList = organizationData?.settings?.model_allow_list || [];
  const allModels = modelsData?.data || [];

  // Filter models based on organization's allow list
  // When user has limited access, only show free models
  const availableModels = useMemo(() => {
    let models =
      savedModelAllowList.length === 0
        ? allModels
        : allModels.filter(m => savedModelAllowList.includes(m.id));

    // If user has limited access, filter to only free models
    if (hasLimitedAccess) {
      models = models.filter(m => {
        const promptPrice = parseFloat(m.pricing.prompt);
        const completionPrice = parseFloat(m.pricing.completion);
        return promptPrice === 0 && completionPrice === 0;
      });
    }

    return models;
  }, [allModels, savedModelAllowList, hasLimitedAccess]);

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

  // Sync selectedModel with projectModel when it changes (e.g., when loading a project)
  // This takes priority over default selection - always apply projectModel when it arrives
  useEffect(() => {
    if (projectModel) {
      setSelectedModel(projectModel);
    }
  }, [projectModel]);

  // Set fallback model when available and not yet selected (and no projectModel)
  useEffect(() => {
    if (modelOptions.length === 0) {
      if (selectedModel) {
        setSelectedModel('');
      }
      return;
    }

    // If no model selected yet and no projectModel provided, select the default or first available
    if (!selectedModel && !projectModel) {
      const defaultModel = defaultsData?.defaultModel;
      const isDefaultAllowed = defaultModel && modelOptions.some(m => m.id === defaultModel);
      const newModel = isDefaultAllowed ? defaultModel : modelOptions[0]?.id;
      if (newModel) {
        setSelectedModel(newModel);
      }
    }
  }, [defaultsData?.defaultModel, modelOptions, selectedModel, projectModel]);

  // Filter messages to show only important ones for cleaner UX
  const filteredMessages = useMemo(() => filterAppBuilderMessages(messages), [messages]);

  // Apply session-based pagination to avoid overwhelming UI with long histories
  const { visibleMessages, hasOlderMessages } = useMemo(
    () => paginateMessages(filteredMessages, visibleSessionCount),
    [filteredMessages, visibleSessionCount]
  );

  // Split messages into static (complete) and dynamic (streaming)
  const { staticMessages, dynamicMessages } = useMemo(() => {
    const staticMsgs: CloudMessage[] = [];
    const dynamicMsgs: CloudMessage[] = [];

    visibleMessages.forEach(msg => {
      if (msg.partial) {
        dynamicMsgs.push(msg);
      } else {
        staticMsgs.push(msg);
      }
    });

    return { staticMessages: staticMsgs, dynamicMessages: dynamicMsgs };
  }, [visibleMessages]);

  // Auto-scroll effect
  useEffect(() => {
    if (shouldAutoScroll && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({
        top: scrollContainerRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
  }, [messages, shouldAutoScroll]);

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

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex h-12 items-center justify-between gap-4 border-b px-4">
        <h2 className="shrink-0 text-sm font-medium">Chat</h2>
        <Button variant="ghost" size="sm" onClick={onNewProject} disabled={isStreaming}>
          <RotateCcw className="mr-1 h-3 w-3" />
          New Project
        </Button>
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
          {visibleMessages.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <div className="text-center text-gray-400">
                <p className="text-sm">Start building your app</p>
                <p className="mt-1 text-xs text-gray-500">Describe what you want to create</p>
              </div>
            </div>
          ) : (
            <>
              {hasOlderMessages && (
                <div className="flex justify-center py-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setVisibleSessionCount(prev => prev + 1)}
                  >
                    Load earlier messages
                  </Button>
                </div>
              )}
              <StaticMessages messages={staticMessages} />
              <DynamicMessages messages={dynamicMessages} isStreaming={isStreaming} />
              {isStreaming && dynamicMessages.length === 0 && <TypingIndicator />}
            </>
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
        disabled={messages.length === 0 || isBlocked}
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
