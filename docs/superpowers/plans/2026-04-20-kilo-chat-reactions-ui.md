# Kilo-Chat Reactions UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reactions UI to kilo-chat messages — display reaction pills below bubbles, quick-pick emoji bar on hover, full emoji-mart picker via "+", with real-time sync and optimistic updates.

**Architecture:** Extend `Message` type with `reactions: ReactionSummary[]`, add reaction cache updater cases + mutation hooks in `useMessages.ts`, wire events in `MessageArea.tsx`, render via new `ReactionPills` and `EmojiQuickPick` components in `MessageBubble.tsx`. Full picker uses `@emoji-mart/react`.

**Tech Stack:** React, TanStack React Query, `@emoji-mart/react` + `@emoji-mart/data`, `@radix-ui/react-popover` (already installed), Tailwind CSS, lucide-react icons.

**Working directory:** `/Users/igor/Projects/.worktrees/kilo-chat-plugin/`
**Branch:** `feat/kiloclaw-kilo-chat-plugin` (PR #2361)

---

### Task 1: Add `ReactionSummary` to shared types and client

**Files:**
- Modify: `packages/kilo-chat/src/types.ts`
- Modify: `packages/kilo-chat/src/client.ts`

- [ ] **Step 1: Add `ReactionSummary` type and `reactions` field to `Message` and `MessageRow`**

In `packages/kilo-chat/src/types.ts`, add the type after the `ContentBlock` section:

```typescript
export type ReactionSummary = {
  emoji: string;
  count: number;
  memberIds: string[];
};
```

Add `reactions: ReactionSummary[]` to both `Message` and `MessageRow` types:

```typescript
export type Message = {
  id: string;
  senderId: string;
  content: ContentBlock[];
  inReplyToMessageId: string | null;
  updatedAt: number | null;
  clientUpdatedAt: number | null;
  deleted: boolean;
  deliveryFailed: boolean;
  reactions: ReactionSummary[];
};

export type MessageRow = {
  id: string;
  senderId: string;
  content: string;
  inReplyToMessageId: string | null;
  updatedAt: number | null;
  clientUpdatedAt: number | null;
  deleted: boolean;
  deliveryFailed: boolean;
  reactions: ReactionSummary[];
};
```

- [ ] **Step 2: Update `parseMessageRow` in client.ts**

In `packages/kilo-chat/src/client.ts`, update the function:

```typescript
function parseMessageRow(row: MessageRow): Message {
  return { ...row, content: row.content as unknown as ContentBlock[] };
}
```

No change needed — the spread already passes through `reactions`. The backend already returns the field, so the types now match the wire format.

- [ ] **Step 3: Export `ReactionSummary` from package index**

In `packages/kilo-chat/src/index.ts`, the `export type * from './types'` already re-exports everything. No change needed.

- [ ] **Step 4: Fix all TypeScript errors from the new required field**

The `Message` type now requires `reactions`. Every place that constructs a `Message` literal needs `reactions: []` added. These locations are:

In `apps/web/src/app/(app)/claw/kilo-chat/hooks/useMessages.ts`:
- `useSendMessage` `onMutate` optimistic message (line ~52): add `reactions: []`
- `useMessageCacheUpdater` `message.created` case (line ~168): add `reactions: []`

- [ ] **Step 5: Run typecheck**

Run: `cd /Users/igor/Projects/.worktrees/kilo-chat-plugin && pnpm run typecheck`
Expected: PASS (no type errors)

- [ ] **Step 6: Commit**

```bash
git add packages/kilo-chat/src/types.ts apps/web/src/app/\(app\)/claw/kilo-chat/hooks/useMessages.ts
git commit -m "feat(kilo-chat): add ReactionSummary type to Message"
```

---

### Task 2: Add reaction cache updater cases and mutation hooks

**Files:**
- Modify: `apps/web/src/app/(app)/claw/kilo-chat/hooks/useMessages.ts`

- [ ] **Step 1: Add reaction event type imports**

Add `ReactionAddedEvent` and `ReactionRemovedEvent` to the imports from `@kilocode/kilo-chat`:

```typescript
import type {
  Message,
  ReactionSummary,
  CreateMessageRequest,
  EditMessageRequest,
  DeleteMessageRequest,
  MessageCreatedEvent,
  MessageUpdatedEvent,
  MessageDeletedEvent,
  MessageDeliveryFailedEvent,
  ReactionAddedEvent,
  ReactionRemovedEvent,
} from '@kilocode/kilo-chat';
```

- [ ] **Step 2: Add `reaction.added` and `reaction.removed` cases to `useMessageCacheUpdater`**

Add these two cases inside the `switch (event.type)` block, after the `message.delivery_failed` case:

```typescript
case 'reaction.added': {
  const e = event.data as ReactionAddedEvent;
  queryClient.setQueryData(queryKey, (old: unknown) => {
    if (!old || typeof old !== 'object') return old;
    const data = old as { pages: Message[][]; pageParams: unknown[] };
    return {
      ...data,
      pages: data.pages.map(page =>
        page.map(msg => {
          if (msg.id !== e.messageId) return msg;
          const reactions = [...msg.reactions];
          const idx = reactions.findIndex(r => r.emoji === e.emoji);
          if (idx >= 0) {
            const existing = reactions[idx];
            if (!existing.memberIds.includes(e.memberId)) {
              reactions[idx] = {
                ...existing,
                count: existing.count + 1,
                memberIds: [...existing.memberIds, e.memberId],
              };
            }
          } else {
            reactions.push({ emoji: e.emoji, count: 1, memberIds: [e.memberId] });
          }
          return { ...msg, reactions };
        })
      ),
    };
  });
  break;
}
case 'reaction.removed': {
  const e = event.data as ReactionRemovedEvent;
  queryClient.setQueryData(queryKey, (old: unknown) => {
    if (!old || typeof old !== 'object') return old;
    const data = old as { pages: Message[][]; pageParams: unknown[] };
    return {
      ...data,
      pages: data.pages.map(page =>
        page.map(msg => {
          if (msg.id !== e.messageId) return msg;
          const reactions = msg.reactions
            .map(r => {
              if (r.emoji !== e.emoji) return r;
              const memberIds = r.memberIds.filter(id => id !== e.memberId);
              return { ...r, count: memberIds.length, memberIds };
            })
            .filter(r => r.count > 0);
          return { ...msg, reactions };
        })
      ),
    };
  });
  break;
}
```

- [ ] **Step 3: Add `useAddReaction` mutation hook**

Add this after `useDeleteMessage`:

```typescript
export function useAddReaction(
  client: KiloChatClient,
  conversationId: string | null,
  currentUserId: string
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, emoji }: { messageId: string; emoji: string }) =>
      client.addReaction(messageId, conversationId ?? '', emoji),
    onMutate: async ({ messageId, emoji }) => {
      if (!conversationId) return;
      const queryKey = ['kilo-chat', 'messages', conversationId];
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData(queryKey);
      queryClient.setQueryData(queryKey, (old: unknown) => {
        if (!old || typeof old !== 'object') return old;
        const data = old as { pages: Message[][]; pageParams: unknown[] };
        return {
          ...data,
          pages: data.pages.map(page =>
            page.map(msg => {
              if (msg.id !== messageId) return msg;
              const reactions = [...msg.reactions];
              const idx = reactions.findIndex(r => r.emoji === emoji);
              if (idx >= 0) {
                const existing = reactions[idx];
                if (!existing.memberIds.includes(currentUserId)) {
                  reactions[idx] = {
                    ...existing,
                    count: existing.count + 1,
                    memberIds: [...existing.memberIds, currentUserId],
                  };
                }
              } else {
                reactions.push({ emoji, count: 1, memberIds: [currentUserId] });
              }
              return { ...msg, reactions };
            })
          ),
        };
      });
      return { previous, queryKey };
    },
    onError: (_err, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(context.queryKey, context.previous);
      }
    },
  });
}
```

- [ ] **Step 4: Add `useRemoveReaction` mutation hook**

Add this after `useAddReaction`:

```typescript
export function useRemoveReaction(
  client: KiloChatClient,
  conversationId: string | null,
  currentUserId: string
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, emoji }: { messageId: string; emoji: string }) =>
      client.removeReaction(messageId, conversationId ?? '', emoji),
    onMutate: async ({ messageId, emoji }) => {
      if (!conversationId) return;
      const queryKey = ['kilo-chat', 'messages', conversationId];
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData(queryKey);
      queryClient.setQueryData(queryKey, (old: unknown) => {
        if (!old || typeof old !== 'object') return old;
        const data = old as { pages: Message[][]; pageParams: unknown[] };
        return {
          ...data,
          pages: data.pages.map(page =>
            page.map(msg => {
              if (msg.id !== messageId) return msg;
              const reactions = msg.reactions
                .map(r => {
                  if (r.emoji !== emoji) return r;
                  const memberIds = r.memberIds.filter(id => id !== currentUserId);
                  return { ...r, count: memberIds.length, memberIds };
                })
                .filter(r => r.count > 0);
              return { ...msg, reactions };
            })
          ),
        };
      });
      return { previous, queryKey };
    },
    onError: (_err, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(context.queryKey, context.previous);
      }
    },
  });
}
```

- [ ] **Step 5: Run typecheck**

Run: `cd /Users/igor/Projects/.worktrees/kilo-chat-plugin && pnpm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/\(app\)/claw/kilo-chat/hooks/useMessages.ts
git commit -m "feat(kilo-chat): add reaction cache updater and mutation hooks"
```

---

### Task 3: Install emoji-mart and create EmojiQuickPick + EmojiPicker components

**Files:**
- Modify: `apps/web/package.json` (via install)
- Create: `apps/web/src/app/(app)/claw/kilo-chat/components/EmojiQuickPick.tsx`
- Create: `apps/web/src/app/(app)/claw/kilo-chat/components/EmojiPicker.tsx`

- [ ] **Step 1: Install emoji-mart**

Run: `cd /Users/igor/Projects/.worktrees/kilo-chat-plugin/apps/web && pnpm add @emoji-mart/react @emoji-mart/data`

- [ ] **Step 2: Create `EmojiQuickPick.tsx`**

Create `apps/web/src/app/(app)/claw/kilo-chat/components/EmojiQuickPick.tsx`:

```tsx
'use client';

const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];

type EmojiQuickPickProps = {
  currentUserReactions: Set<string>;
  onSelect: (emoji: string) => void;
  onOpenFullPicker: () => void;
};

export function EmojiQuickPick({
  currentUserReactions,
  onSelect,
  onOpenFullPicker,
}: EmojiQuickPickProps) {
  return (
    <div className="flex items-center gap-0.5 rounded-lg bg-background border border-border p-1 shadow-md">
      {QUICK_EMOJIS.map(emoji => (
        <button
          key={emoji}
          onClick={() => onSelect(emoji)}
          className={`rounded p-1 text-base cursor-pointer transition-colors hover:bg-muted ${
            currentUserReactions.has(emoji) ? 'bg-primary/10' : ''
          }`}
          title={currentUserReactions.has(emoji) ? `Remove ${emoji}` : `React with ${emoji}`}
        >
          {emoji}
        </button>
      ))}
      <button
        onClick={onOpenFullPicker}
        className="rounded p-1 text-sm cursor-pointer transition-colors hover:bg-muted text-muted-foreground"
        title="More emoji"
      >
        +
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Create `EmojiPicker.tsx`**

Create `apps/web/src/app/(app)/claw/kilo-chat/components/EmojiPicker.tsx`:

```tsx
'use client';

import { useEffect, useRef } from 'react';
import data from '@emoji-mart/data';
import Picker from '@emoji-mart/react';

type EmojiPickerProps = {
  onSelect: (emoji: string) => void;
  onClose: () => void;
};

export function EmojiPicker({ onSelect, onClose }: EmojiPickerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  return (
    <div ref={containerRef} className="z-50">
      <Picker
        data={data}
        onEmojiSelect={(emoji: { native: string }) => {
          onSelect(emoji.native);
        }}
        theme="dark"
        previewPosition="none"
        skinTonePosition="none"
        maxFrequentRows={1}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run typecheck**

Run: `cd /Users/igor/Projects/.worktrees/kilo-chat-plugin && pnpm run typecheck`
Expected: PASS (emoji-mart may need type workarounds — if so, add `// @ts-expect-error no types` on the imports)

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src/app/\(app\)/claw/kilo-chat/components/EmojiQuickPick.tsx apps/web/src/app/\(app\)/claw/kilo-chat/components/EmojiPicker.tsx
git commit -m "feat(kilo-chat): add emoji quick-pick and full picker components"
```

---

### Task 4: Create ReactionPills component

**Files:**
- Create: `apps/web/src/app/(app)/claw/kilo-chat/components/ReactionPills.tsx`

- [ ] **Step 1: Create `ReactionPills.tsx`**

Create `apps/web/src/app/(app)/claw/kilo-chat/components/ReactionPills.tsx`:

```tsx
'use client';

import { useState, useCallback } from 'react';
import type { ReactionSummary } from '@kilocode/kilo-chat';
import { EmojiPicker } from './EmojiPicker';

type ReactionPillsProps = {
  reactions: ReactionSummary[];
  currentUserId: string;
  isOwn: boolean;
  onAdd: (emoji: string) => void;
  onRemove: (emoji: string) => void;
};

export function ReactionPills({
  reactions,
  currentUserId,
  isOwn,
  onAdd,
  onRemove,
}: ReactionPillsProps) {
  const [showPicker, setShowPicker] = useState(false);

  const handlePickerSelect = useCallback(
    (emoji: string) => {
      setShowPicker(false);
      const existing = reactions.find(r => r.emoji === emoji);
      if (existing?.memberIds.includes(currentUserId)) {
        onRemove(emoji);
      } else {
        onAdd(emoji);
      }
    },
    [reactions, currentUserId, onAdd, onRemove]
  );

  if (reactions.length === 0 && !showPicker) return null;

  return (
    <div className={`flex flex-wrap gap-1 mt-1 ${isOwn ? 'justify-end' : 'justify-start'}`}>
      {reactions.map(r => {
        const isMine = r.memberIds.includes(currentUserId);
        return (
          <button
            key={r.emoji}
            onClick={() => (isMine ? onRemove(r.emoji) : onAdd(r.emoji))}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs cursor-pointer transition-colors border ${
              isMine
                ? 'bg-primary/10 border-primary/30 hover:bg-primary/20'
                : 'bg-muted border-border hover:bg-accent'
            }`}
            title={isMine ? `Remove ${r.emoji}` : `React with ${r.emoji}`}
          >
            <span className="text-sm">{r.emoji}</span>
            <span className={isMine ? 'text-primary font-medium' : 'text-muted-foreground'}>
              {r.count}
            </span>
          </button>
        );
      })}
      <div className="relative">
        <button
          onClick={() => setShowPicker(prev => !prev)}
          className="inline-flex items-center rounded-full px-2 py-0.5 text-xs cursor-pointer transition-colors border bg-muted border-border hover:bg-accent text-muted-foreground"
          title="Add reaction"
        >
          +
        </button>
        {showPicker && (
          <div className={`absolute bottom-full mb-2 z-50 ${isOwn ? 'right-0' : 'left-0'}`}>
            <EmojiPicker onSelect={handlePickerSelect} onClose={() => setShowPicker(false)} />
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd /Users/igor/Projects/.worktrees/kilo-chat-plugin && pnpm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/\(app\)/claw/kilo-chat/components/ReactionPills.tsx
git commit -m "feat(kilo-chat): add ReactionPills component"
```

---

### Task 5: Wire reactions into MessageBubble

**Files:**
- Modify: `apps/web/src/app/(app)/claw/kilo-chat/components/MessageBubble.tsx`

- [ ] **Step 1: Add reaction props and smiley button to MessageBubble**

Add imports at top:

```typescript
import { Pencil, Trash2, Reply, X, Check, AlertCircle, Smile } from 'lucide-react';
import type { Message, ContentBlock, ReactionSummary } from '@kilocode/kilo-chat';
```

Extend `MessageBubbleProps`:

```typescript
type MessageBubbleProps = {
  message: Message;
  isOwn: boolean;
  replyToMessage?: Message | null;
  pendingDeleteId: string | null;
  onEdit: (messageId: string, content: ContentBlock[]) => void;
  onDelete: (messageId: string) => void;
  onConfirmDelete: (messageId: string) => void;
  onCancelDelete: () => void;
  onReply: (message: Message) => void;
  onAddReaction: (messageId: string, emoji: string) => void;
  onRemoveReaction: (messageId: string, emoji: string) => void;
  currentUserId: string;
};
```

Add new props to the destructured params:

```typescript
export function MessageBubble({
  message,
  isOwn,
  replyToMessage,
  pendingDeleteId,
  onEdit,
  onDelete,
  onConfirmDelete,
  onCancelDelete,
  onReply,
  onAddReaction,
  onRemoveReaction,
  currentUserId,
}: MessageBubbleProps) {
```

- [ ] **Step 2: Add smiley button state and quick-pick**

Add imports for the new components:

```typescript
import { EmojiQuickPick } from './EmojiQuickPick';
import { EmojiPicker } from './EmojiPicker';
import { ReactionPills } from './ReactionPills';
```

Add state inside the component:

```typescript
const [showQuickPick, setShowQuickPick] = useState(false);
const [showFullPicker, setShowFullPicker] = useState(false);
```

Add a computed set of the current user's reactions:

```typescript
const myReactions = new Set(
  message.reactions.filter(r => r.memberIds.includes(currentUserId)).map(r => r.emoji)
);
```

Add handlers:

```typescript
function handleQuickPickSelect(emoji: string) {
  setShowQuickPick(false);
  if (myReactions.has(emoji)) {
    onRemoveReaction(message.id, emoji);
  } else {
    onAddReaction(message.id, emoji);
  }
}

function handleFullPickerSelect(emoji: string) {
  setShowFullPicker(false);
  setShowQuickPick(false);
  if (myReactions.has(emoji)) {
    onRemoveReaction(message.id, emoji);
  } else {
    onAddReaction(message.id, emoji);
  }
}
```

- [ ] **Step 3: Add smiley button to action bar**

In the `actionButtons` JSX, add a smiley button before the existing buttons (so it appears first). It should show for all non-deleted, non-delivery-failed messages (not just own). Add it right after the opening `<div>` of the action bar:

```tsx
<button
  onClick={() => setShowQuickPick(prev => !prev)}
  className="hover:bg-muted rounded p-1 cursor-pointer transition-colors"
  title="React"
>
  <Smile className="h-3.5 w-3.5" />
</button>
```

The smiley button should be available for ALL messages (own and others), so place it outside any `{isOwn && ...}` guard. Put it as the first child.

- [ ] **Step 4: Add quick-pick and full-picker popovers**

Add the popovers right after the `{actionButtons}` line inside the `<div className="relative">`:

```tsx
{showQuickPick && (
  <div
    className={`absolute z-20 ${
      isOwn ? 'right-full mr-1' : 'left-full ml-1'
    } top-0`}
  >
    <EmojiQuickPick
      currentUserReactions={myReactions}
      onSelect={handleQuickPickSelect}
      onOpenFullPicker={() => {
        setShowQuickPick(false);
        setShowFullPicker(true);
      }}
    />
  </div>
)}
{showFullPicker && (
  <div
    className={`absolute bottom-full mb-2 z-50 ${isOwn ? 'right-0' : 'left-0'}`}
  >
    <EmojiPicker
      onSelect={handleFullPickerSelect}
      onClose={() => setShowFullPicker(false)}
    />
  </div>
)}
```

- [ ] **Step 5: Add ReactionPills below the bubble**

After the closing `</div>` of the `rounded-2xl` bubble div (the one with `bg-primary` / `bg-muted`), and still inside the outer `<div className="relative">`, add:

```tsx
{!message.deleted && !message.deliveryFailed && (
  <ReactionPills
    reactions={message.reactions}
    currentUserId={currentUserId}
    isOwn={isOwn}
    onAdd={emoji => onAddReaction(message.id, emoji)}
    onRemove={emoji => onRemoveReaction(message.id, emoji)}
  />
)}
```

- [ ] **Step 6: Close popovers on mouse leave**

Update the `onMouseLeave` handler on the outer `<div>` to also close the quick-pick (but NOT the full picker — that has its own click-outside handling):

```typescript
onMouseLeave={() => {
  setShowActions(false);
  setShowQuickPick(false);
}}
```

- [ ] **Step 7: Run typecheck**

Run: `cd /Users/igor/Projects/.worktrees/kilo-chat-plugin && pnpm run typecheck`
Expected: FAIL — `MessageArea.tsx` doesn't pass the new props yet. That's expected; we fix it in Task 6.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/app/\(app\)/claw/kilo-chat/components/MessageBubble.tsx
git commit -m "feat(kilo-chat): add reaction UI to MessageBubble"
```

---

### Task 6: Wire everything together in MessageArea

**Files:**
- Modify: `apps/web/src/app/(app)/claw/kilo-chat/components/MessageArea.tsx`

- [ ] **Step 1: Import new hooks**

Update imports from `../hooks/useMessages`:

```typescript
import {
  useMessages,
  useSendMessage,
  useEditMessage,
  useDeleteMessage,
  useMessageCacheUpdater,
  useAddReaction,
  useRemoveReaction,
} from '../hooks/useMessages';
```

- [ ] **Step 2: Initialize reaction mutation hooks**

After `const deleteMessage = ...` line, add:

```typescript
const addReaction = useAddReaction(kiloChatClient, conversationId, currentUserId);
const removeReaction = useRemoveReaction(kiloChatClient, conversationId, currentUserId);
```

- [ ] **Step 3: Wire reaction events**

In the `useEffect` that registers event handlers, add these two entries to the `offs` array:

```typescript
kiloChatClient.onReactionAdded((_ctx, data) => {
  updateCache({ type: 'reaction.added', data });
}),
kiloChatClient.onReactionRemoved((_ctx, data) => {
  updateCache({ type: 'reaction.removed', data });
}),
```

- [ ] **Step 4: Add reaction handler functions**

After the `handleCancelDelete` function, add:

```typescript
function handleAddReaction(messageId: string, emoji: string) {
  addReaction.mutate(
    { messageId, emoji },
    { onError: () => toast.error('Failed to add reaction') }
  );
}

function handleRemoveReaction(messageId: string, emoji: string) {
  removeReaction.mutate(
    { messageId, emoji },
    { onError: () => toast.error('Failed to remove reaction') }
  );
}
```

- [ ] **Step 5: Pass new props to MessageBubble**

In the `messages.map(msg => ...)` JSX, add the new props to `<MessageBubble>`:

```tsx
<MessageBubble
  key={msg.id}
  message={msg}
  isOwn={msg.senderId === currentUserId}
  replyToMessage={
    msg.inReplyToMessageId ? (messageMap.get(msg.inReplyToMessageId) ?? null) : null
  }
  pendingDeleteId={pendingDeleteId}
  onEdit={handleEdit}
  onDelete={handleDelete}
  onConfirmDelete={handleConfirmDelete}
  onCancelDelete={handleCancelDelete}
  onReply={setReplyingTo}
  onAddReaction={handleAddReaction}
  onRemoveReaction={handleRemoveReaction}
  currentUserId={currentUserId}
/>
```

- [ ] **Step 6: Run typecheck**

Run: `cd /Users/igor/Projects/.worktrees/kilo-chat-plugin && pnpm run typecheck`
Expected: PASS

- [ ] **Step 7: Run format**

Run: `cd /Users/igor/Projects/.worktrees/kilo-chat-plugin && pnpm run format:changed`

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/app/\(app\)/claw/kilo-chat/components/MessageArea.tsx
git commit -m "feat(kilo-chat): wire reaction events and mutations in MessageArea"
```
