'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { MoreVertical } from 'lucide-react';
import type { ConversationListItem } from '@kilocode/kilo-chat';
import { ulidToTimestamp } from '@kilocode/kilo-chat';

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

  const lastMessageTime = conversation.lastMessageId
    ? new Date(ulidToTimestamp(conversation.lastMessageId)).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
      })
    : null;

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
    setRenameValue(conversation.conversationTitle ?? '');
    setIsRenaming(true);
    setMenuOpen(false);
  }, [conversation.conversationTitle]);

  const handleConfirmRename = useCallback(() => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== conversation.conversationTitle) {
      onRename(conversation.conversationId, trimmed);
    }
    setIsRenaming(false);
  }, [renameValue, conversation.conversationTitle, conversation.conversationId, onRename]);

  const handleCancelRename = useCallback(() => {
    setIsRenaming(false);
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

  if (isRenaming) {
    return (
      <div
        className={`block rounded-md px-3 py-2 ${
          isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50'
        }`}
      >
        <input
          ref={inputRef}
          value={renameValue}
          onChange={e => setRenameValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') handleConfirmRename();
            if (e.key === 'Escape') handleCancelRename();
          }}
          onBlur={handleConfirmRename}
          className="bg-background border-border w-full rounded border px-1.5 py-0.5 text-sm"
          maxLength={200}
        />
      </div>
    );
  }

  if (isConfirmingLeave) {
    return (
      <div
        className={`block rounded-md px-3 py-2 ${
          isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50'
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm">Leave?</span>
          <span className="flex gap-1.5 text-xs">
            <button
              onClick={handleConfirmLeave}
              className="text-destructive hover:underline font-medium"
            >
              Yes
            </button>
            <button onClick={handleCancelLeave} className="text-muted-foreground hover:underline">
              No
            </button>
          </span>
        </div>
      </div>
    );
  }

  return (
    <Link
      href={`/claw/kilo-chat/${conversation.conversationId}`}
      className={`group relative block rounded-md px-3 py-2 ${
        isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50'
      }`}
      prefetch={false}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-sm font-medium">
          {conversation.conversationTitle ?? 'Untitled'}
        </p>
        <div className="flex shrink-0 items-center gap-1">
          {lastMessageTime && (
            <span className="text-muted-foreground text-xs group-hover:hidden">
              {lastMessageTime}
            </span>
          )}
          <div ref={menuRef} className="relative">
            <button
              onClick={e => {
                e.preventDefault();
                e.stopPropagation();
                setMenuOpen(prev => !prev);
              }}
              className="hover:bg-muted hidden rounded p-0.5 group-hover:block"
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
                  className="hover:bg-muted w-full px-3 py-1.5 text-left text-sm"
                >
                  Rename
                </button>
                <button
                  onClick={e => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleStartLeave();
                  }}
                  className="text-destructive hover:bg-muted w-full px-3 py-1.5 text-left text-sm"
                >
                  Leave
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}
