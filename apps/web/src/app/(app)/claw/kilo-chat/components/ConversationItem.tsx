'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { MoreVertical } from 'lucide-react';
import type { ConversationListItem } from '@kilocode/kilo-chat';

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

  const sharedClassName = `group relative block rounded-md px-3 py-2 ${
    isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50'
  }`;

  const content = (
    <div className="flex items-center justify-between gap-2">
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
          maxLength={200}
        />
      ) : isConfirmingLeave ? (
        <>
          <span className="text-sm">Leave?</span>
          <span className="flex shrink-0 gap-1.5 text-xs">
            <button
              onClick={e => {
                e.preventDefault();
                e.stopPropagation();
                handleConfirmLeave();
              }}
              className="text-destructive hover:underline font-medium cursor-pointer"
            >
              Yes
            </button>
            <button
              onClick={e => {
                e.preventDefault();
                e.stopPropagation();
                handleCancelLeave();
              }}
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
            {isUnread && <span className="h-2 w-2 shrink-0 rounded-full bg-blue-500" />}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <span className="text-muted-foreground text-xs group-hover:hidden">{displayTime}</span>
            <div ref={menuRef} className="relative">
              <button
                onClick={e => {
                  e.preventDefault();
                  e.stopPropagation();
                  setMenuOpen(prev => !prev);
                }}
                className="hover:bg-muted hidden rounded p-0.5 group-hover:block cursor-pointer transition-colors"
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </button>
              {menuOpen && (
                <div className="bg-popover border-border absolute right-0 top-full z-10 mt-1 w-32 rounded-md border py-1 shadow-md">
                  <button
                    onClick={e => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleStartRename();
                    }}
                    className="hover:bg-muted w-full px-3 py-1.5 text-left text-sm cursor-pointer transition-colors"
                  >
                    Rename
                  </button>
                  <button
                    onClick={e => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleStartLeave();
                    }}
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
  );

  // Use conditional JSX instead of inline component types to avoid unmount/remount
  return isRenaming ? (
    <div className={sharedClassName}>{content}</div>
  ) : (
    <Link
      href={`/claw/kilo-chat/${conversation.conversationId}`}
      prefetch={false}
      className={sharedClassName}
    >
      {content}
    </Link>
  );
}
