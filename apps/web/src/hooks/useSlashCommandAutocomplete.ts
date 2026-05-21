import { useMemo, useState, useEffect, useCallback, type RefObject } from 'react';
import type { SlashCommand } from '@/lib/cloud-agent/slash-commands';

type UseSlashCommandAutocompleteOptions = {
  value: string;
  slashCommands: SlashCommand[];
  onSelect: (command: SlashCommand, autoSend: boolean) => void;
  /** Ref to the scrollable CommandList container. When provided, the selected item is scrolled into view on keyboard navigation. */
  listRef?: RefObject<HTMLElement | null>;
};

type UseSlashCommandAutocompleteResult = {
  showAutocomplete: boolean;
  selectedIndex: number;
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  filteredCommands: SlashCommand[];
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  setShowAutocomplete: (show: boolean) => void;
};

/**
 * Reusable slash-command autocomplete logic extracted from ChatInput.
 *
 * Returns filtered commands, selection state, and a key-down handler.
 * The key-down handler returns `true` when it consumed the event (so the
 * caller can preventDefault only when the popover is active).
 */
export function useSlashCommandAutocomplete({
  value,
  slashCommands,
  onSelect,
  listRef,
}: UseSlashCommandAutocompleteOptions): UseSlashCommandAutocompleteResult {
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const filteredCommands = useMemo(() => {
    if (!slashCommands || slashCommands.length === 0) return [];
    if (!value.startsWith('/')) return [];

    const query = value.slice(1).toLowerCase();
    return slashCommands.filter(cmd => cmd.trigger.toLowerCase().startsWith(query));
  }, [value, slashCommands]);

  const shouldShowAutocomplete = useMemo(() => {
    return (
      value.startsWith('/') &&
      filteredCommands.length > 0 &&
      slashCommands &&
      slashCommands.length > 0
    );
  }, [value, filteredCommands.length, slashCommands]);

  useEffect(() => {
    setShowAutocomplete(shouldShowAutocomplete);
    if (shouldShowAutocomplete) {
      setSelectedIndex(0);
    }
  }, [shouldShowAutocomplete]);

  // Scroll the selected item into view when navigating with keyboard.
  useEffect(() => {
    if (!listRef?.current || !showAutocomplete) return;
    const items = listRef.current.querySelectorAll<HTMLElement>('[role="option"]');
    items[selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, showAutocomplete, listRef]);

  const handleSelectCommand = useCallback(
    (command: SlashCommand, autoSend = false) => {
      setShowAutocomplete(false);
      setSelectedIndex(0);
      onSelect(command, autoSend);
    },
    [onSelect]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      // Ignore keyboard events during IME composition (Chinese, Japanese, Korean input)
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return false;

      if (showAutocomplete && filteredCommands.length > 0) {
        switch (e.key) {
          case 'ArrowDown':
            e.preventDefault();
            setSelectedIndex(prev => (prev + 1) % filteredCommands.length);
            return true;
          case 'ArrowUp':
            e.preventDefault();
            setSelectedIndex(
              prev => (prev - 1 + filteredCommands.length) % filteredCommands.length
            );
            return true;
          case 'Enter':
            e.preventDefault();
            if (selectedIndex >= 0 && selectedIndex < filteredCommands.length) {
              // Enter = select and send; Shift+Enter = select and expand only
              handleSelectCommand(filteredCommands[selectedIndex], !e.shiftKey);
            }
            return true;
          case 'Tab':
            e.preventDefault();
            if (selectedIndex >= 0 && selectedIndex < filteredCommands.length) {
              // Tab = select and expand only (don't send)
              handleSelectCommand(filteredCommands[selectedIndex], false);
            }
            return true;
          case 'Escape':
            e.preventDefault();
            setShowAutocomplete(false);
            return true;
        }
      }

      return false;
    },
    [showAutocomplete, filteredCommands, selectedIndex, handleSelectCommand]
  );

  return {
    showAutocomplete,
    selectedIndex,
    setSelectedIndex,
    filteredCommands,
    handleKeyDown,
    setShowAutocomplete,
  };
}
