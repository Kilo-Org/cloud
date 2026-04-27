'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { MoreVertical } from 'lucide-react';
import type { ConversationListItem } from '@kilocode/kilo-chat';
import { CONVERSATION_TITLE_MAX_CHARS } from '@kilocode/kilo-chat';
import { useKiloChatContext } from './kiloChatContext';

type ConversationItemProps = {
  conversation: ConversationListItem;
  isActive: boolean;
  onRename: (id: string, title: string) => void;
  onLeave: (id: string) => void;
};

export function ConversationItem({
  conversation,
  isActive,
  onRename,
  onLeave,
}: ConversationItemProps) {
  const { basePath } = useKiloChatContext();
  const [menuOpen, setMenuOpen] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [isConfirmingLeave, setIsConfirmingLeave] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const timestamp = conversation.lastActivityAt ?? conversation.joinedAt;
  const displayTime = new Date(timestamp).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });

  // Focus input when entering rename mode
  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isRenaming]);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen]);

  const handleStartRename = useCallback(() => {
    setRenameValue(conversation.title ?? '');
    setIsRenaming(true);
    setMenuOpen(false);
  }, [conversation.title]);

  const handleConfirmRename = useCallback(() => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== conversation.title) {
      onRename(conversation.conversationId, trimmed);
    }
    setIsRenaming(false);
  }, [renameValue, conversation.title, conversation.conversationId, onRename]);

  const handleCancelRename = useCallback(() => {
    setIsRenaming(false);
    setRenameValue('');
  }, []);

  const handleStartLeave = useCallback(() => {
    setIsConfirmingLeave(true);
    setMenuOpen(false);
  }, []);

  const handleConfirmLeave = useCallback(() => {
    onLeave(conversation.conversationId);
    setIsConfirmingLeave(false);
  }, [conversation.conversationId, onLeave]);

  const handleCancelLeave = useCallback(() => {
    setIsConfirmingLeave(false);
  }, []);

  const title = conversation.title ?? 'Untitled';

  const isUnread =
    !isActive &&
    conversation.lastActivityAt != null &&
    (conversation.lastReadAt == null || conversation.lastActivityAt > conversation.lastReadAt);

  // "Card-link" pattern: the row is a <div>, navigation is handled by an
  // absolutely-positioned <Link> overlay. Interactive children (kebab, menu,
  // Yes/No) sit above the overlay with their own pointer-events so clicking
  // them doesn't also navigate, and the HTML stays valid (<a> never contains
  // a nested <button>). Hover styles still work because the overlay covers
  // the row and triggers `group-hover:*` on the outer container.
  const rowClassName = `group relative rounded-md px-3 py-2 ${
    isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50'
  }`;

  // The overlay is suppressed while editing state is open (rename/leave
  // confirm) so stray clicks on the row don't whisk the user away mid-action.
  const showLinkOverlay = !isRenaming && !isConfirmingLeave;

  return (
    <div className={rowClassName}>
      {showLinkOverlay && (
        <Link
          href={`${basePath}/${conversation.conversationId}`}
          prefetch={false}
          aria-label={title}
          className="absolute inset-0 rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        />
      )}
      {/* While the link overlay is visible, the content row must be transparent
          to pointer events so clicks reach the underlying <Link>. Interactive
          controls below opt back in with `pointer-events-auto`. When renaming
          or confirming leave, the overlay is gone and the row captures clicks
          normally. */}
      <div
        className={`relative flex items-center justify-between gap-2 ${
          showLinkOverlay ? 'pointer-events-none' : ''
        }`}
      >
        {isRenaming ? (
          <input
            ref={inputRef}
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleConfirmRename();
              if (e.key === 'Escape') handleCancelRename();
            }}
            onBlur={handleConfirmRename}
            className="bg-transparent min-w-0 flex-1 text-sm font-medium outline-none border-b border-current/20"
            maxLength={CONVERSATION_TITLE_MAX_CHARS}
          />
        ) : isConfirmingLeave ? (
          <>
            <span className="text-sm">Leave?</span>
            <span className="flex shrink-0 gap-1.5 text-xs">
              <button
                type="button"
                onClick={handleConfirmLeave}
                className="text-destructive hover:underline font-medium cursor-pointer"
              >
                Yes
              </button>
              <button
                type="button"
                onClick={handleCancelLeave}
                className="text-muted-foreground hover:underline cursor-pointer"
              >
                No
              </button>
            </span>
          </>
        ) : (
          <>
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <p className="truncate text-sm font-medium">{title}</p>
              {isUnread && (
                <>
                  <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-blue-500" />
                  <span className="sr-only">Unread</span>
                </>
              )}
            </div>
            {/* Controls column opts back into pointer events so the kebab is
                clickable; the time span stays transparent so clicks pass
                through to the link overlay. While the menu is open we pin
                the kebab visible (and the time hidden) so the row doesn't
                reflow back to its unhovered layout underneath the open
                dropdown when the mouse leaves. */}
            <div className="pointer-events-auto flex shrink-0 items-center gap-1">
              <span
                className={`text-muted-foreground pointer-events-none text-xs ${
                  menuOpen ? 'hidden' : 'group-hover:hidden'
                }`}
              >
                {displayTime}
              </span>
              <div ref={menuRef} className="relative">
                <button
                  type="button"
                  aria-label="Conversation options"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen(prev => !prev)}
                  className={`hover:bg-muted rounded p-0.5 cursor-pointer transition-colors ${
                    menuOpen ? 'block' : 'hidden group-hover:block'
                  }`}
                >
                  <MoreVertical className="h-3.5 w-3.5" />
                </button>
                {menuOpen && (
                  <div
                    role="menu"
                    className="bg-popover border-border absolute right-0 top-full z-10 mt-1 w-32 rounded-md border py-1 shadow-md"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={handleStartRename}
                      className="hover:bg-muted w-full px-3 py-1.5 text-left text-sm cursor-pointer transition-colors"
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={handleStartLeave}
                      className="text-destructive hover:bg-muted w-full px-3 py-1.5 text-left text-sm cursor-pointer transition-colors"
                    >
                      Leave
                    </button>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
