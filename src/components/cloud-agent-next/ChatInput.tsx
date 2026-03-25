'use client';

import type { KeyboardEvent } from 'react';
import { useState, useRef, useEffect, useMemo } from 'react';
import { Button as UIButton } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverAnchor } from '@/components/ui/popover';
import { Command, CommandList, CommandItem, CommandEmpty } from '@/components/ui/command';
import { Send, Square } from 'lucide-react';
import type { SlashCommand } from '@/lib/cloud-agent/slash-commands';
import { cn } from '@/lib/utils';
import { BrowseCommandsDialog } from './BrowseCommandsDialog';
import { ModeCombobox, NEXT_MODE_OPTIONS } from '@/components/shared/ModeCombobox';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { VariantCombobox } from '@/components/shared/VariantCombobox';
import type { AgentMode } from './types';

type ChatInputProps = {
  onSend: (message: string) => void;
  onStop?: () => void;
  disabled?: boolean;
  isStreaming?: boolean;
  placeholder?: string;
  slashCommands?: SlashCommand[];
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
}: ChatInputProps) {
  const [value, setValue] = useState('');
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Restore text into the textarea when initialValue changes (e.g. after a failed send).
  // Treats undefined as "no opinion" (skip), but empty string actively clears the field.
  useEffect(() => {
    if (initialValue !== undefined) {
      setValue(initialValue);
      textareaRef.current?.focus();
    }
  }, [initialValue]);

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

  const handleSend = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;

    onSend(trimmed);
    setValue('');
    setShowAutocomplete(false);

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
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
      // Send immediately
      onSend(expansion);
      setValue('');
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    } else {
      // Just fill the input for editing
      setValue(expansion);
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

  // Check if toolbar should be rendered (has callbacks and options)
  const hasToolbar = showToolbar && onModeChange && onModelChange && modelOptions.length > 0;

  return (
    <div className="px-[max(1rem,calc(50%_-_27rem))] py-3 md:py-4">
      <div
        className={cn(
          'overflow-hidden bg-muted/30 focus-within:ring-ring rounded-lg border focus-within:ring-2',
          disabled && !isStreaming && 'opacity-60'
        )}
      >
        {/* Textarea with slash command autocomplete */}
        <Popover open={showAutocomplete} onOpenChange={handleOpenChange}>
          <PopoverAnchor asChild>
            <textarea
              ref={textareaRef}
              value={value}
              onChange={e => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              disabled={disabled}
              className="max-h-[200px] w-full resize-none overflow-y-auto border-0 bg-transparent p-4 pb-2 text-sm focus:ring-0 focus:outline-none"
              rows={1}
              role="combobox"
              aria-expanded={showAutocomplete}
              aria-autocomplete="list"
              aria-controls="slash-command-list"
            />
          </PopoverAnchor>
          <PopoverContent
            className="w-[var(--radix-popover-trigger-width)] min-w-[300px] p-0"
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

        {/* Toolbar below textarea */}
        <div className="flex items-center gap-2 px-3 py-1.5">
          {hasToolbar && (
            <>
              <ModeCombobox
                value={mode}
                onValueChange={onModeChange}
                options={NEXT_MODE_OPTIONS}
                variant="compact"
                disabled={disabled || isStreaming}
              />
              <ModelCombobox
                models={modelOptions}
                value={model}
                onValueChange={onModelChange}
                variant="compact"
                isLoading={isLoadingModels}
                disabled={disabled || isStreaming}
              />
              {availableVariants.length > 0 && onVariantChange && (
                <VariantCombobox
                  variants={availableVariants}
                  value={variant}
                  onValueChange={onVariantChange}
                  disabled={disabled || isStreaming}
                />
              )}
            </>
          )}
          {slashCommands.length > 0 && <BrowseCommandsDialog />}
          <div className="flex-1" />
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
              disabled={disabled || !value.trim()}
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
