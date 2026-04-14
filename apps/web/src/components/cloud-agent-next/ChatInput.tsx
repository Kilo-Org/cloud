'use client';

import type { KeyboardEvent } from 'react';
import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Button as UIButton } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverAnchor } from '@/components/ui/popover';
import { Command, CommandList, CommandItem, CommandEmpty } from '@/components/ui/command';
import { Send, Square, Paperclip, Upload } from 'lucide-react';
import type { SlashCommand } from '@/lib/cloud-agent/slash-commands';
import { cn } from '@/lib/utils';
import { BrowseCommandsDialog } from './BrowseCommandsDialog';
import { ModeCombobox, NEXT_MODE_OPTIONS } from '@/components/shared/ModeCombobox';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { VariantCombobox } from '@/components/shared/VariantCombobox';
import { MobileToolbarPopover } from './MobileToolbarPopover';
import { ImagePreviewStrip } from '@/components/shared/ImagePreviewStrip';
import { useImageUpload, type UseImageUploadOptions } from '@/hooks/useImageUpload';
import { CLOUD_AGENT_IMAGE_MAX_COUNT } from '@/lib/cloud-agent/constants';
import type { Images } from '@/lib/images-schema';
import type { AgentMode } from './types';

type ChatInputProps = {
  onSend: (message: string, images?: Images) => Promise<boolean>;
  onStop?: () => void;
  disabled?: boolean;
  isStreaming?: boolean;
  placeholder?: string;
  slashCommands?: SlashCommand[];
  /** Options passed to useImageUpload. */
  imageUploadOptions: UseImageUploadOptions;
  /** Current mode for the toolbar */
  mode?: AgentMode;
  /** Current model for the toolbar */
  model?: string;
  /** Available model options for the toolbar */
  modelOptions?: ModelOption[];
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
};

export function ChatInput({
  onSend,
  onStop,
  disabled = false,
  isStreaming = false,
  placeholder = 'Type your message...',
  slashCommands = [],
  mode,
  model,
  modelOptions = [],
  isLoadingModels = false,
  onModeChange,
  onModelChange,
  variant,
  onVariantChange,
  availableVariants = [],
  showToolbar = false,
  initialValue,
  imageUploadOptions,
}: ChatInputProps) {
  const [value, setValue] = useState('');
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const valueRef = useRef('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const setInputValue = useCallback((nextValue: string) => {
    valueRef.current = nextValue;
    setValue(nextValue);
  }, []);

  const imageUpload = useImageUpload(imageUploadOptions);
  const maxImages = imageUploadOptions.maxImages ?? CLOUD_AGENT_IMAGE_MAX_COUNT;
  const isImageLimitReached = imageUpload.images.length >= maxImages;

  // Restore text into the textarea when initialValue changes (e.g. after a failed send).
  // Treats undefined as "no opinion" (skip), but empty string actively clears the field.
  useEffect(() => {
    if (initialValue === undefined) return;
    if (initialValue !== '' && valueRef.current !== '') return;

    setInputValue(initialValue);
    textareaRef.current?.focus();
  }, [initialValue, setInputValue]);

  // Filter commands based on current input
  const filteredCommands = useMemo(() => {
    if (!slashCommands || slashCommands.length === 0) return [];
    if (!value.startsWith('/')) return [];

    const query = value.slice(1).toLowerCase();
    return slashCommands.filter(cmd => cmd.trigger.toLowerCase().startsWith(query));
  }, [value, slashCommands]);

  // Determine if autocomplete should be shown
  const shouldShowAutocomplete = useMemo(() => {
    return (
      value.startsWith('/') &&
      filteredCommands.length > 0 &&
      slashCommands &&
      slashCommands.length > 0
    );
  }, [value, filteredCommands.length, slashCommands]);

  // Update showAutocomplete state when conditions change
  useEffect(() => {
    setShowAutocomplete(shouldShowAutocomplete);
    // Reset selected index when filtering changes
    if (shouldShowAutocomplete) {
      setSelectedIndex(0);
    }
  }, [shouldShowAutocomplete]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  }, [value]);

  const sendMessage = useCallback(
    async (message: string) => {
      const trimmed = message.trim();
      if (!trimmed || disabled) return false;
      if (imageUpload.hasUploadingImages) return false;

      const imagesData = imageUpload.getImagesData();
      const submittedImageIds = imageUpload.images.map(image => image.id);

      setInputValue('');
      submittedImageIds.forEach(imageUpload.removeImage);
      setShowAutocomplete(false);

      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }

      const accepted = await onSend(trimmed, imagesData);
      if (!accepted) {
        if (valueRef.current === '') {
          setInputValue(trimmed);
          textareaRef.current?.focus();
        }
        return false;
      }

      return true;
    },
    [disabled, imageUpload, onSend, setInputValue]
  );

  const handleSend = () => {
    void sendMessage(value);
  };

  const handleStop = () => {
    if (onStop) {
      onStop();
    }
  };

  const handleSelectCommand = (command: SlashCommand, autoSend = false) => {
    const expansion = command.expansion;
    setShowAutocomplete(false);
    setSelectedIndex(0);

    if (autoSend) {
      void sendMessage(expansion);
    } else {
      // Just fill the input for editing
      setInputValue(expansion);
      // Force height recalculation for expanded text
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
      }
    }

    // Keep focus on textarea
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Ignore keyboard events during IME composition (Chinese, Japanese, Korean input)
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;

    if (showAutocomplete && filteredCommands.length > 0) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex(prev => (prev + 1) % filteredCommands.length);
          return;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex(prev => (prev - 1 + filteredCommands.length) % filteredCommands.length);
          return;
        case 'Enter':
          e.preventDefault();
          // Bounds check to prevent race condition
          if (selectedIndex >= 0 && selectedIndex < filteredCommands.length) {
            // Enter = select and send; Shift+Enter = select and expand only
            handleSelectCommand(filteredCommands[selectedIndex], !e.shiftKey);
          }
          return;
        case 'Tab':
          e.preventDefault();
          // Bounds check to prevent race condition
          if (selectedIndex >= 0 && selectedIndex < filteredCommands.length) {
            // Tab = select and expand only (don't send)
            handleSelectCommand(filteredCommands[selectedIndex], false);
          }
          return;
        case 'Escape':
          e.preventDefault();
          setShowAutocomplete(false);
          return;
      }
    }

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
      const files = Array.from(e.clipboardData.items)
        .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
        .map(item => item.getAsFile())
        .filter((f): f is File => f !== null);
      if (files.length > 0) {
        imageUpload.addFiles(files);
      }
    },
    [imageUpload]
  );

  // Check if toolbar should be rendered (has callbacks and options)
  const hasToolbar = showToolbar && onModeChange && onModelChange && modelOptions.length > 0;

  return (
    <div className="px-[max(1rem,calc(50%_-_27rem))] py-3 md:py-4">
      <div
        className={cn(
          'relative overflow-hidden bg-muted/30 focus-within:ring-ring rounded-lg border focus-within:ring-2',
          disabled && !isStreaming && 'opacity-60',
          imageUpload.isDragging && 'border-transparent focus-within:ring-0'
        )}
        {...imageUpload.dragHandlers}
      >
        {imageUpload.isDragging && (
          <div
            className={cn(
              'absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed backdrop-blur-[2px]',
              isImageLimitReached
                ? 'border-amber-500/60 bg-amber-500/10'
                : 'border-primary/60 bg-primary/5'
            )}
          >
            <div
              className={cn(
                'flex items-center gap-2 text-sm font-medium',
                isImageLimitReached ? 'text-amber-400' : 'text-primary'
              )}
            >
              <Upload className="h-4 w-4" />
              {isImageLimitReached ? `Maximum ${maxImages} images attached` : 'Drop images here'}
            </div>
          </div>
        )}
        {/* Hidden file input for image selection */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          className="hidden"
          onChange={e => {
            if (e.target.files) {
              imageUpload.addFiles(e.target.files);
              e.target.value = '';
            }
          }}
        />
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
              disabled={disabled}
              className="max-h-[200px] w-full resize-none overflow-y-auto border-0 bg-transparent p-4 pb-2 text-base focus:ring-0 focus:outline-none md:text-sm"
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
            <Command>
              <CommandList
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
                    className={cn(
                      'flex cursor-pointer flex-col items-start gap-1 px-3 py-2',
                      index === selectedIndex && 'bg-accent'
                    )}
                    onMouseEnter={() => setSelectedIndex(index)}
                    role="option"
                    aria-selected={index === selectedIndex}
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

        {imageUpload.images.length > 0 && (
          <div className="px-3 pb-1">
            <ImagePreviewStrip
              images={imageUpload.images}
              onRemove={imageUpload.removeImage}
              size="compact"
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
                onModelChange={onModelChange}
                isLoadingModels={isLoadingModels}
                variant={variant}
                availableVariants={availableVariants}
                onVariantChange={onVariantChange}
                disabled={disabled || isStreaming}
                className="md:hidden"
              />
              {/* Desktop: individual pickers */}
              <div className="hidden md:contents">
                <ModeCombobox
                  value={mode}
                  onValueChange={onModeChange}
                  options={NEXT_MODE_OPTIONS}
                  variant="compact"
                  disabled={disabled || isStreaming}
                  className="min-w-0"
                />
                <ModelCombobox
                  models={modelOptions}
                  value={model}
                  onValueChange={onModelChange}
                  variant="compact"
                  isLoading={isLoadingModels}
                  disabled={disabled || isStreaming}
                  className="min-w-0"
                />
                {availableVariants.length > 0 && onVariantChange && (
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
          {slashCommands.length > 0 && (
            <div className="hidden xl:block">
              <BrowseCommandsDialog />
            </div>
          )}
          <div className="flex-1" />
          {!isStreaming && (
            <UIButton
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              className="h-8 w-8 rounded-lg"
              title="Attach images"
            >
              <Paperclip className="h-4 w-4" />
            </UIButton>
          )}
          {isStreaming ? (
            <UIButton
              type="button"
              variant="destructive"
              size="icon"
              onClick={handleStop}
              disabled={!onStop}
              className="h-8 w-8 rounded-lg"
            >
              <Square className="h-4 w-4" />
            </UIButton>
          ) : (
            <UIButton
              type="button"
              variant="primary"
              size="icon"
              onClick={handleSend}
              disabled={disabled || !value.trim() || imageUpload.hasUploadingImages}
              className="h-8 w-8 rounded-lg"
            >
              <Send className="h-4 w-4" />
            </UIButton>
          )}
        </div>
      </div>
    </div>
  );
}
