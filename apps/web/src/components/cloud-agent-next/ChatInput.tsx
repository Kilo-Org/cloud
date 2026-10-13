'use client';

import type { KeyboardEvent } from 'react';
import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { toast } from 'sonner';
import { Button as UIButton } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverAnchor } from '@/components/ui/popover';
import { Command, CommandList, CommandItem, CommandEmpty } from '@/components/ui/command';
import { Send, Square, Paperclip, Upload, LoaderCircle } from 'lucide-react';
import type { SlashCommand } from '@/lib/cloud-agent/slash-commands';
import { cn } from '@/lib/utils';
import { useSlashCommandAutocomplete } from '@/hooks/useSlashCommandAutocomplete';
import { BrowseCommandsDialog } from './BrowseCommandsDialog';
import { ModeCombobox, NEXT_MODE_OPTIONS, type ModeOption } from '@/components/shared/ModeCombobox';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { formatShortModelDisplayName } from '@/lib/format-model-name';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { VariantCombobox } from '@/components/shared/VariantCombobox';
import { thinkingEffortLabel } from '@/lib/code-reviews/core/model-variants';
import { Brain } from 'lucide-react';
import { MobileToolbarPopover } from './MobileToolbarPopover';
import { AttachmentPreviewStrip } from './AttachmentPreviewStrip';
import {
  useCloudAgentAttachmentUpload,
  type CloudAgentAttachmentFile,
  type UseCloudAgentAttachmentUploadOptions,
} from '@/hooks/useCloudAgentAttachmentUpload';
import {
  CLOUD_AGENT_ATTACHMENT_MAX_COUNT,
  CLOUD_AGENT_PROMPT_MAX_LENGTH,
  type CloudAgentAttachments,
} from '@/lib/cloud-agent/constants';
import type { AgentMode } from './types';
import {
  acceptedSubmissionAttachmentIdsToRemove,
  getChatInputPresentationCommands,
  isWorktreeNewChatCommand,
  shouldRejectAttachedSlashCommand,
} from './chat-input-attachments';
import {
  revokeComposerSnapshotPreviews,
  saveComposerSnapshot,
  takeComposerSnapshot,
  type ComposerSnapshot,
} from './composer-snapshots';

const DEFAULT_CONVERSATION_KEY = 'default';

/**
 * A restored attachment whose upload was interrupted by a conversation switch
 * cannot be resumed without a new object key, so surface it as an error the
 * user can remove or re-add instead of a silently stuck "uploading" row.
 */
function normalizeRestoredAttachments(
  attachments: readonly CloudAgentAttachmentFile[]
): CloudAgentAttachmentFile[] {
  return attachments.map(attachment =>
    attachment.status === 'processing' ||
    attachment.status === 'pending' ||
    attachment.status === 'uploading'
      ? { ...attachment, status: 'error', error: 'Upload interrupted' }
      : attachment
  );
}

type ChatInputProps = {
  onSend: (message: string, attachments?: CloudAgentAttachments) => Promise<boolean>;
  /**
   * Invoked when the user submits a slash command (input starts with `/<name>`
   * and `<name>` matches a known entry in `slashCommands`). When omitted or
   * the input doesn't match a known command, the input is forwarded to
   * `onSend` as plain text instead.
   */
  onSendCommand?: (
    command: string,
    args: string,
    attachments?: CloudAgentAttachments
  ) => Promise<boolean>;
  onNewChat?: () => Promise<boolean>;
  onStop?: () => void;
  canInterrupt?: boolean;
  disabled?: boolean;
  textareaDisabled?: boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  isStreaming?: boolean;
  placeholder?: string;
  slashCommands?: SlashCommand[];
  /** Options passed to the Cloud Agent attachment uploader. */
  attachmentUploadOptions: UseCloudAgentAttachmentUploadOptions;
  /** Whether this composer can submit file attachments through its active transport. */
  attachmentsEnabled?: boolean;
  /** Current mode for the toolbar */
  mode?: AgentMode;
  /** Current model for the toolbar */
  model?: string;
  /** Available model options for the toolbar */
  modelOptions?: ModelOption[];
  /** Optional model option pinned above regular gateway models. */
  pinnedModelOption?: ModelOption;
  /** Whether models are loading */
  isLoadingModels?: boolean;
  /** Callback when mode changes */
  onModeChange?: (mode: AgentMode) => void;
  /** Callback when model changes */
  onModelChange?: (model: string) => void;
  /** Current variant for the toolbar */
  variant?: string;
  /** Callback when variant changes */
  onVariantChange?: (variant: string) => void;
  /** Available variant keys for the current model */
  availableVariants?: string[];
  /** Whether to show the toolbar (hide when no active session) */
  showToolbar?: boolean;
  /** Pre-populate the textarea (e.g. to restore text after a failed send) */
  initialValue?: string;
  /** Custom modes exposed by the session's profile stack (shown in picker) */
  customModeOptions?: ModeOption<AgentMode>[];
  /** When true, the model picker is rendered read-only (e.g. agent has a model override). */
  modelPickerDisabled?: boolean;
  /** Explanatory tooltip shown alongside the locked model picker. */
  modelPickerTooltip?: string;
  /** When true, the variant picker is rendered read-only (e.g. agent has a thinking-effort override). */
  variantPickerDisabled?: boolean;
  /** Explanatory tooltip shown alongside the locked variant picker. */
  variantPickerTooltip?: string;
  /**
   * Identity of the conversation this composer edits. A send that settles after
   * the user switched away must not restore its draft or focus into the newly
   * selected chat, so completion is scoped to this key.
   */
  conversationKey?: string;
};

export function ChatInput({
  onSend,
  onSendCommand,
  onNewChat,
  onStop,
  canInterrupt = false,
  disabled = false,
  textareaDisabled = disabled,
  inputRef,
  isStreaming = false,
  placeholder = 'Type your message...',
  slashCommands = [],
  mode,
  model,
  modelOptions = [],
  pinnedModelOption,
  isLoadingModels = false,
  onModeChange,
  onModelChange,
  variant,
  onVariantChange,
  availableVariants = [],
  showToolbar = false,
  initialValue,
  attachmentUploadOptions,
  attachmentsEnabled = true,
  customModeOptions,
  modelPickerDisabled,
  modelPickerTooltip,
  variantPickerDisabled,
  variantPickerTooltip,
  conversationKey,
}: ChatInputProps) {
  const [value, setValue] = useState('');
  const [pendingSubmissionKeys, setPendingSubmissionKeys] = useState<ReadonlySet<string>>(
    new Set()
  );
  const valueRef = useRef('');
  const attachmentSubmissionPendingRef = useRef<ReadonlySet<string>>(new Set());
  const conversationKeyRef = useRef(conversationKey);
  conversationKeyRef.current = conversationKey;
  const isAttachmentSubmissionPending = pendingSubmissionKeys.has(
    conversationKey ?? DEFAULT_CONVERSATION_KEY
  );
  const isNewChatDraft = isWorktreeNewChatCommand(value.trim(), onNewChat !== undefined);
  const internalTextareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = inputRef ?? internalTextareaRef;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const commandListRef = useRef<HTMLDivElement>(null);

  const setInputValue = useCallback((nextValue: string) => {
    valueRef.current = nextValue;
    setValue(nextValue);
  }, []);

  const setAttachmentSubmissionPending = useCallback((pending: boolean, key: string) => {
    const next = new Set(attachmentSubmissionPendingRef.current);
    if (pending) next.add(key);
    else next.delete(key);
    attachmentSubmissionPendingRef.current = next;
    setPendingSubmissionKeys(next);
  }, []);
  const hasPendingSubmission = useCallback(
    () =>
      attachmentSubmissionPendingRef.current.has(
        conversationKeyRef.current ?? DEFAULT_CONVERSATION_KEY
      ),
    []
  );

  const attachmentUpload = useCloudAgentAttachmentUpload(attachmentUploadOptions);
  const isAttachmentLimitReached =
    attachmentUpload.attachments.length >= CLOUD_AGENT_ATTACHMENT_MAX_COUNT;

  const composerSnapshotsRef = useRef(new Map<string, ComposerSnapshot>());
  const composerConversationRef = useRef(conversationKey ?? DEFAULT_CONVERSATION_KEY);
  const liveAttachmentsRef = useRef(attachmentUpload.attachments);
  liveAttachmentsRef.current = attachmentUpload.attachments;
  const { replaceAttachments } = attachmentUpload;

  const storeComposerSnapshot = useCallback((key: string, snapshot: ComposerSnapshot) => {
    const shownKey = conversationKeyRef.current ?? DEFAULT_CONVERSATION_KEY;
    const evicted = saveComposerSnapshot(
      composerSnapshotsRef.current,
      key,
      snapshot,
      candidate => candidate === shownKey || attachmentSubmissionPendingRef.current.has(candidate)
    );
    revokeComposerSnapshotPreviews(evicted);
  }, []);

  useEffect(() => {
    const snapshots = composerSnapshotsRef.current;
    return () => revokeComposerSnapshotPreviews(snapshots.values());
  }, []);

  // Each conversation keeps its own draft and attachments. Switching away saves
  // them and switching back restores them, so a failed send in one chat is
  // recoverable after visiting another — and a transient `attachmentsEnabled`
  // false never releases a submitted upload's pending-ledger key.
  useEffect(() => {
    const previous = composerConversationRef.current;
    const next = conversationKey ?? DEFAULT_CONVERSATION_KEY;
    if (previous === next) return;
    composerConversationRef.current = next;
    storeComposerSnapshot(previous, {
      text: valueRef.current,
      attachments: liveAttachmentsRef.current,
    });
    const snapshot = takeComposerSnapshot(composerSnapshotsRef.current, next);
    setInputValue(snapshot?.text ?? '');
    replaceAttachments(normalizeRestoredAttachments(snapshot?.attachments ?? []));
  }, [conversationKey, replaceAttachments, setInputValue, storeComposerSnapshot]);

  // Restore text into the textarea when initialValue changes (e.g. after a failed send).
  // Treats undefined as "no opinion" (skip), but empty string actively clears the field.
  useEffect(() => {
    if (initialValue === undefined) return;
    if (initialValue !== '' && valueRef.current !== '') return;

    setInputValue(initialValue);
    textareaRef.current?.focus();
  }, [initialValue, setInputValue]);

  // Resolve the pinned model's display name from the allowed models list, so the
  // locked-read-only toolbar shows the same label as the ModelCombobox. Falls
  // back to the raw id when the model isn't in the org's allowed list (e.g. an
  // agent pinned a model that was later restricted).
  const lockedModelOption = useMemo(
    () => [pinnedModelOption, ...modelOptions].find(m => m?.id === model),
    [pinnedModelOption, modelOptions, model]
  );
  const lockedModelLabel = lockedModelOption
    ? formatShortModelDisplayName(lockedModelOption.name)
    : model;

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  }, [value]);

  const sendMessage = useCallback(
    async (message: string) => {
      const trimmed = message.trim();
      if (!trimmed) return false;

      const conversationAtSend = conversationKeyRef.current ?? DEFAULT_CONVERSATION_KEY;
      const createsWorktreeChat = isWorktreeNewChatCommand(trimmed, onNewChat !== undefined);

      // `/new` is navigation, not an ordinary send: a temporary send
      // unavailability (busy session, unsaved draft) must not block starting a
      // chat. Its own creation guard dedupes doubles, and the shared checks for
      // read-only/unresolved transports still apply because `onNewChat` is only
      // provided for an eligible worktree session.
      if (!createsWorktreeChat) {
        if (disabled) return false;
        if (trimmed.length > CLOUD_AGENT_PROMPT_MAX_LENGTH) return false;
        if (attachmentSubmissionPendingRef.current.has(conversationAtSend)) return false;
        if (attachmentsEnabled && attachmentUpload.hasUploadingAttachments) return false;
      }

      // Re-match against the trimmed value at submit time, and reject a slash
      // command carrying files BEFORE finalizing the attachment ledger: a
      // client-rejected send must leave its rows pending so the reaper can
      // delete the orphaned objects.
      let accepted = false;
      const slashMatch = onSendCommand
        ? /^\s*\/([\w.-]+)(?:\s+([\s\S]*))?\s*$/.exec(trimmed)
        : null;
      const slashCommand =
        slashMatch && slashCommands?.some(c => c.trigger === slashMatch[1])
          ? { command: slashMatch[1], args: slashMatch[2]?.trim() ?? '' }
          : null;

      if (
        shouldRejectAttachedSlashCommand(
          trimmed,
          slashCommands,
          attachmentsEnabled && attachmentUpload.attachments.length > 0,
          createsWorktreeChat
        )
      ) {
        toast.error('Files cannot be attached to slash commands', {
          description: 'Remove the files or type a plain prompt instead.',
        });
        return false;
      }

      let attachmentsData: CloudAgentAttachments | undefined;
      const hasAttachments = attachmentsEnabled && attachmentUpload.attachments.length > 0;
      // Take the in-flight guard for the whole submission — the link RPC and,
      // for a plain prompt, the send itself. While either is in flight the send
      // button stays disabled and Enter is refused, so a second submit cannot
      // start its own finalize + send. A plain prompt has nothing to finalize:
      // skipping the await lets onSend insert its optimistic row in the same
      // tick as the keypress.
      if (!createsWorktreeChat) setAttachmentSubmissionPending(true, conversationAtSend);
      if (hasAttachments) {
        try {
          attachmentsData = await attachmentUpload.finalizeAttachments();
        } catch (error) {
          setAttachmentSubmissionPending(false, conversationAtSend);
          toast.error('Failed to attach files. Please try again.', {
            description: String(error instanceof Error ? error.message : ''),
          });
          return false;
        }
      }
      const submittedAttachments = attachmentsEnabled ? attachmentUpload.attachments : [];

      setInputValue('');
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }

      try {
        if (createsWorktreeChat && onNewChat) {
          accepted = await onNewChat();
        } else if (slashCommand && onSendCommand) {
          accepted = await onSendCommand(slashCommand.command, slashCommand.args, attachmentsData);
        } else {
          accepted = await onSend(trimmed, attachmentsData);
        }
        return accepted;
      } finally {
        if (!createsWorktreeChat) setAttachmentSubmissionPending(false, conversationAtSend);
        const currentKey = conversationKeyRef.current ?? DEFAULT_CONVERSATION_KEY;
        if (accepted) {
          const removeIds = acceptedSubmissionAttachmentIdsToRemove(submittedAttachments, accepted);
          if (removeIds.length > 0) {
            if (currentKey === conversationAtSend) {
              removeIds.forEach(attachmentUpload.removeAttachment);
            } else {
              revokeComposerSnapshotPreviews([
                {
                  text: '',
                  attachments: submittedAttachments.filter(attachment =>
                    removeIds.includes(attachment.id)
                  ),
                },
              ]);
              const existing = composerSnapshotsRef.current.get(conversationAtSend);
              storeComposerSnapshot(conversationAtSend, {
                text: existing?.text ?? '',
                attachments: (existing?.attachments ?? []).filter(
                  attachment => !removeIds.includes(attachment.id)
                ),
              });
            }
          }
        } else {
          // The failed submission's inputs belong to its own conversation: keep
          // them there so returning recovers the original text and files.
          storeComposerSnapshot(conversationAtSend, {
            text: trimmed,
            attachments: submittedAttachments,
          });
          if (currentKey === conversationAtSend && valueRef.current === '') {
            setInputValue(trimmed);
            textareaRef.current?.focus();
          }
        }
      }
    },
    [
      attachmentUpload,
      attachmentsEnabled,
      disabled,
      onSend,
      onSendCommand,
      onNewChat,
      setAttachmentSubmissionPending,
      setInputValue,
      slashCommands,
      storeComposerSnapshot,
    ]
  );

  const handleSend = () => {
    void sendMessage(value);
  };

  const handleStop = () => {
    if (canInterrupt && onStop) {
      onStop();
    }
  };

  const handleSelectCommand = useCallback(
    (command: SlashCommand, autoSend = false) => {
      if (autoSend) {
        void sendMessage(`/${command.trigger}`);
      } else {
        const inserted = `/${command.trigger} `;
        setInputValue(inserted);
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
          textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
          const end = inserted.length;
          textareaRef.current.setSelectionRange(end, end);
        }
      }

      textareaRef.current?.focus();
    },
    [sendMessage, setInputValue]
  );

  const presentationSlashCommands = useMemo(
    () => getChatInputPresentationCommands(slashCommands, onNewChat !== undefined),
    [slashCommands, onNewChat]
  );

  const {
    showAutocomplete,
    selectedIndex,
    setSelectedIndex,
    filteredCommands,
    handleKeyDown: handleAutocompleteKeyDown,
    setShowAutocomplete,
  } = useSlashCommandAutocomplete({
    value,
    slashCommands: presentationSlashCommands,
    onSelect: handleSelectCommand,
    listRef: commandListRef,
  });

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;

    if (
      e.key === 'Enter' &&
      !e.shiftKey &&
      isWorktreeNewChatCommand(valueRef.current, onNewChat !== undefined)
    ) {
      e.preventDefault();
      handleSend();
      return;
    }

    if (handleAutocompleteKeyDown(e)) return;

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleOpenChange = (open: boolean) => {
    // Only allow closing, not opening through Popover's internal logic
    if (!open) {
      setShowAutocomplete(false);
    }
  };

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (!attachmentsEnabled || hasPendingSubmission()) return;

      const files = Array.from(e.clipboardData.items)
        .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
        .map(item => item.getAsFile())
        .filter((f): f is File => f !== null);
      if (files.length > 0) {
        attachmentUpload.addFiles(files);
      }
    },
    [attachmentUpload, attachmentsEnabled, hasPendingSubmission]
  );

  const dragHandlers = attachmentsEnabled
    ? {
        onDragEnter: (event: React.DragEvent) => {
          if (hasPendingSubmission()) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          attachmentUpload.dragHandlers.onDragEnter(event);
        },
        onDragOver: (event: React.DragEvent) => {
          if (hasPendingSubmission()) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          attachmentUpload.dragHandlers.onDragOver(event);
        },
        onDragLeave: attachmentUpload.dragHandlers.onDragLeave,
        onDrop: (event: React.DragEvent) => {
          if (hasPendingSubmission()) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          attachmentUpload.dragHandlers.onDrop(event);
        },
      }
    : undefined;

  // Check if toolbar should be rendered (has callbacks and options)
  const hasToolbar =
    showToolbar && onModeChange && onModelChange && (modelOptions.length > 0 || pinnedModelOption);

  return (
    <div className="px-[max(1rem,calc(50%_-_27rem))] py-2">
      <div
        className={cn(
          'relative overflow-hidden bg-muted/30 focus-within:ring-ring rounded-lg border focus-within:ring-2',
          textareaDisabled && !isStreaming && 'opacity-60',
          attachmentsEnabled &&
            !isAttachmentSubmissionPending &&
            attachmentUpload.isDragging &&
            'border-transparent focus-within:ring-0'
        )}
        {...dragHandlers}
      >
        {attachmentsEnabled && !isAttachmentSubmissionPending && attachmentUpload.isDragging && (
          <div
            className={cn(
              'absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed backdrop-blur-[2px]',
              isAttachmentLimitReached
                ? 'border-amber-500/60 bg-amber-500/10'
                : 'border-primary/60 bg-primary/5'
            )}
          >
            <div
              className={cn(
                'flex items-center gap-2 text-sm font-medium',
                isAttachmentLimitReached ? 'text-amber-400' : 'text-primary'
              )}
            >
              <Upload className="h-4 w-4" />
              {isAttachmentLimitReached
                ? `Maximum ${CLOUD_AGENT_ATTACHMENT_MAX_COUNT} files attached`
                : 'Drop files here'}
            </div>
          </div>
        )}
        {attachmentsEnabled && (
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,.txt,.md,.csv"
            multiple
            className="hidden"
            onChange={e => {
              if (e.target.files && !hasPendingSubmission()) {
                attachmentUpload.addFiles(e.target.files);
              }
              e.target.value = '';
            }}
          />
        )}
        {/* Textarea with slash command autocomplete */}
        <Popover open={showAutocomplete} onOpenChange={handleOpenChange}>
          <PopoverAnchor asChild>
            <textarea
              ref={textareaRef}
              value={value}
              onChange={e => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={placeholder}
              disabled={textareaDisabled}
              maxLength={CLOUD_AGENT_PROMPT_MAX_LENGTH}
              className="max-h-[200px] w-full resize-none overflow-y-auto border-0 bg-transparent px-3 pt-3 pb-1 text-base focus:ring-0 focus:outline-none md:text-sm"
              rows={1}
              role="combobox"
              aria-expanded={showAutocomplete}
              aria-autocomplete="list"
              aria-controls="slash-command-list"
            />
          </PopoverAnchor>
          <PopoverContent
            className="w-[var(--radix-popover-trigger-width)] min-w-[min(300px,calc(100vw-2rem))] p-0"
            side="top"
            align="start"
            sideOffset={4}
            onOpenAutoFocus={e => e.preventDefault()}
          >
            <Command shouldFilter={false} value={filteredCommands[selectedIndex]?.trigger ?? ''}>
              <CommandList
                ref={commandListRef}
                id="slash-command-list"
                role="listbox"
                className="max-h-64 overflow-auto"
              >
                <CommandEmpty>No matching commands</CommandEmpty>
                {filteredCommands.map((cmd, index) => (
                  <CommandItem
                    key={cmd.trigger}
                    value={cmd.trigger}
                    onSelect={() => handleSelectCommand(cmd)}
                    className="flex cursor-pointer flex-col items-start gap-1 px-3 py-2"
                    onMouseEnter={() => setSelectedIndex(index)}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-medium text-blue-400">
                        /{cmd.trigger}
                      </span>
                      <span className="text-muted-foreground text-sm">{cmd.label}</span>
                    </div>
                    <span className="text-muted-foreground text-xs">{cmd.description}</span>
                  </CommandItem>
                ))}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        {value.length >= CLOUD_AGENT_PROMPT_MAX_LENGTH * 0.9 && (
          <p
            className={cn(
              'px-4 pb-1 text-xs',
              value.length >= CLOUD_AGENT_PROMPT_MAX_LENGTH
                ? 'text-red-400'
                : 'text-muted-foreground'
            )}
          >
            {value.length.toLocaleString()} / {CLOUD_AGENT_PROMPT_MAX_LENGTH.toLocaleString()}{' '}
            characters
          </p>
        )}

        {attachmentsEnabled && attachmentUpload.attachments.length > 0 && (
          <div className="px-3 pb-1">
            <AttachmentPreviewStrip
              attachments={attachmentUpload.attachments}
              onRemove={attachmentUpload.removeAttachment}
            />
          </div>
        )}

        {/* Toolbar below textarea */}
        <div className="flex min-w-0 items-center gap-2 overflow-hidden px-3 py-1.5">
          {hasToolbar && (
            <>
              {/* Mobile: single trigger that opens Mode + Model + Variant */}
              <MobileToolbarPopover
                mode={mode}
                onModeChange={onModeChange}
                model={model}
                modelOptions={modelOptions}
                pinnedModelOption={pinnedModelOption}
                onModelChange={onModelChange}
                isLoadingModels={isLoadingModels}
                variant={variant}
                availableVariants={availableVariants}
                onVariantChange={onVariantChange}
                disabled={disabled || isStreaming}
                modelPickerDisabled={modelPickerDisabled}
                modelPickerTooltip={modelPickerTooltip}
                variantPickerDisabled={variantPickerDisabled}
                variantPickerTooltip={variantPickerTooltip}
                className="md:hidden"
                customModeOptions={customModeOptions}
              />
              {/* Desktop: individual pickers */}
              <div className="hidden md:contents">
                <ModeCombobox
                  value={mode}
                  onValueChange={onModeChange}
                  options={NEXT_MODE_OPTIONS}
                  customOptions={customModeOptions}
                  variant="compact"
                  disabled={disabled || isStreaming}
                  className="min-w-0"
                />
                {modelPickerDisabled ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="text-muted-foreground flex h-9 min-w-0 items-center rounded-md border border-dashed px-2 text-xs">
                        <span className={cn('truncate', !lockedModelOption && 'font-mono')}>
                          {lockedModelLabel}
                        </span>
                      </div>
                    </TooltipTrigger>
                    {modelPickerTooltip && (
                      <TooltipContent side="top" className="text-xs">
                        {modelPickerTooltip}
                      </TooltipContent>
                    )}
                  </Tooltip>
                ) : (
                  <ModelCombobox
                    models={modelOptions}
                    pinnedModel={pinnedModelOption}
                    value={model}
                    onValueChange={onModelChange}
                    variant="compact"
                    isLoading={isLoadingModels}
                    disabled={disabled || isStreaming}
                    className="min-w-0"
                  />
                )}
                {variantPickerDisabled
                  ? variant && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="text-muted-foreground flex h-9 min-w-0 items-center gap-1.5 rounded-md border border-dashed px-2 text-xs">
                            <Brain className="h-3.5 w-3.5 shrink-0 opacity-70" />
                            <span className="truncate">{thinkingEffortLabel(variant)}</span>
                          </div>
                        </TooltipTrigger>
                        {variantPickerTooltip && (
                          <TooltipContent side="top" className="text-xs">
                            {variantPickerTooltip}
                          </TooltipContent>
                        )}
                      </Tooltip>
                    )
                  : availableVariants.length > 0 &&
                    onVariantChange && (
                      <VariantCombobox
                        variants={availableVariants}
                        value={variant}
                        onValueChange={onVariantChange}
                        disabled={disabled || isStreaming}
                        className="min-w-0"
                      />
                    )}
              </div>
            </>
          )}
          {presentationSlashCommands.length > 0 && (
            <div className="hidden xl:block">
              <BrowseCommandsDialog commands={presentationSlashCommands} />
            </div>
          )}
          <div className="flex-1" />
          {!isStreaming && attachmentsEnabled && (
            <UIButton
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => {
                if (!hasPendingSubmission()) {
                  fileInputRef.current?.click();
                }
              }}
              disabled={disabled || isAttachmentSubmissionPending}
              className="relative h-8 w-8 rounded-lg before:absolute before:-inset-1.5"
              title="Attach files"
              aria-label="Attach files"
            >
              <Paperclip className="h-4 w-4" />
            </UIButton>
          )}
          {isStreaming && (
            <UIButton
              type="button"
              variant="destructive"
              size="icon"
              onClick={handleStop}
              disabled={!canInterrupt || !onStop}
              className="relative h-8 w-8 rounded-lg before:absolute before:-inset-1.5"
              aria-label="Stop response"
            >
              <Square className="h-4 w-4" />
            </UIButton>
          )}
          <UIButton
            type="button"
            variant="primary"
            size="icon"
            onClick={handleSend}
            disabled={
              (!isNewChatDraft && (disabled || isAttachmentSubmissionPending)) ||
              !value.trim() ||
              value.length > CLOUD_AGENT_PROMPT_MAX_LENGTH ||
              (attachmentsEnabled && attachmentUpload.hasUploadingAttachments)
            }
            className="relative h-8 w-8 rounded-lg before:absolute before:-inset-1.5"
            aria-label={
              isNewChatDraft
                ? 'New chat'
                : isAttachmentSubmissionPending
                  ? 'Sending message'
                  : 'Send message'
            }
            aria-busy={(!isNewChatDraft && isAttachmentSubmissionPending) || undefined}
          >
            {isAttachmentSubmissionPending && !isNewChatDraft ? (
              <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </UIButton>
        </div>
      </div>
    </div>
  );
}
