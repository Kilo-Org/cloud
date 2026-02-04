'use client';

import type { KeyboardEvent } from 'react';
import { useState, useRef, useEffect, useMemo } from 'react';
import { Button } from '@/components/Button';
import { Textarea } from '@/components/ui/textarea';
import { Popover, PopoverContent, PopoverAnchor } from '@/components/ui/popover';
import { Command, CommandList, CommandItem, CommandEmpty } from '@/components/ui/command';
import { Send, Square } from 'lucide-react';
import type { SlashCommand } from '@/lib/cloud-agent/slash-commands';
import { cn } from '@/lib/utils';
import { BrowseCommandsDialog } from './BrowseCommandsDialog';
import { ModeCombobox, NEXT_MODE_OPTIONS } from '@/components/shared/ModeCombobox';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
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
  /** Whether to show the toolbar (hide when no active session) */
  showToolbar?: boolean;
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
  showToolbar = false,
}: ChatInputProps) {
  const [value, setValue] = useState('');
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
    <div className="bg-background w-full max-w-full overflow-x-hidden border-t p-3 md:p-4">
      {/* Toolbar with mode and model selectors */}
      {hasToolbar && (
        <div className="mb-2 flex items-center gap-2">
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
            className="min-w-0 flex-1 md:w-auto md:flex-none"
          />
        </div>
      )}
      <div className="flex w-full max-w-full flex-col items-stretch gap-2 md:flex-row md:flex-wrap md:items-start md:gap-3">
        <Popover open={showAutocomplete} onOpenChange={handleOpenChange}>
          <PopoverAnchor asChild>
            <Textarea
              ref={textareaRef}
              value={value}
              onChange={e => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              disabled={disabled}
              className="max-h-[200px] min-h-[56px] w-full min-w-0 resize-y md:min-h-[60px] md:flex-1"
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
        {isStreaming ? (
          <Button
            onClick={handleStop}
            disabled={!onStop}
            size="icon"
            variant="danger"
            className="h-11 min-h-[44px] w-full min-w-[44px] md:w-auto md:min-w-[44px] md:flex-none md:px-4"
          >
            <Square className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            onClick={handleSend}
            disabled={disabled || !value.trim()}
            size="icon"
            variant="primary"
            className="h-11 min-h-[44px] w-full min-w-[44px] md:w-auto md:min-w-[44px] md:flex-none md:px-4"
          >
            <Send className="h-4 w-4" />
          </Button>
        )}
      </div>
      <div className="mt-2 hidden items-center justify-between text-xs text-gray-400 sm:flex">
        <p>Press Enter to send, Shift+Enter for new line</p>
        {slashCommands && slashCommands.length > 0 && <BrowseCommandsDialog />}
      </div>
    </div>
  );
}
