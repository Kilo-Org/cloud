# Kilo-Chat Reactions UI

## Context

The kilo-chat backend fully supports reactions: a `reactions` SQLite table with composite PK `(message_id, member_id, emoji)`, add/remove endpoints, real-time `reaction.added`/`reaction.removed` events via the event service, and `listMessages` already returns aggregated reaction summaries per message. The frontend has zero reaction UI — this spec covers wiring it up.

## Data Model Changes

### `packages/kilo-chat/src/types.ts`

Add `ReactionSummary` type and include it on `Message` and `MessageRow`:

```typescript
export type ReactionSummary = {
  emoji: string;
  count: number;
  memberIds: string[];
};
```

Both `Message` and `MessageRow` get: `reactions: ReactionSummary[]`.

### `packages/kilo-chat/src/client.ts`

`parseMessageRow` passes through the `reactions` field (already present in the API response, just not typed).

## Real-Time Event Handling

### `hooks/useMessages.ts` — `useMessageCacheUpdater`

Add two new cases to the cache updater:

- **`reaction.added`** `{ messageId, memberId, emoji }` — find the message in cache, find or create the emoji bucket in `reactions[]`, increment count, add memberId if not present.
- **`reaction.removed`** `{ messageId, memberId, emoji }` — find the message, find the emoji bucket, decrement count, remove memberId. If count reaches 0, remove the bucket entirely.

### `components/MessageArea.tsx`

Wire `kiloChatClient.onReactionAdded()` and `kiloChatClient.onReactionRemoved()` in the existing `useEffect` alongside other event handlers. Both delegate to `updateCache`.

## Mutation Hooks

### `useAddReaction` and `useRemoveReaction` in `hooks/useMessages.ts`

Both follow the existing optimistic update pattern (cancel queries → snapshot → optimistic update → revert on error):

- **`useAddReaction`** — optimistically adds the current user to the emoji bucket (or creates it with count 1). Calls `client.addReaction(messageId, conversationId, emoji)`.
- **`useRemoveReaction`** — optimistically removes the current user from the emoji bucket, decrements count, removes bucket if empty. Calls `client.removeReaction(messageId, conversationId, emoji)`.

## UI Components

### Reaction Pills — `components/ReactionPills.tsx` (new)

Renders below the message bubble (outside the `rounded-2xl` content div, inside the outer `max-w-[75%]` column). Aligned to the same side as the bubble (left for others, right for own messages).

Each pill: emoji character + count. Styled as small rounded capsules with `bg-muted border border-border`. If the current user is in `memberIds` for that emoji, the pill gets a highlighted style (`bg-primary/10 border-primary/30` or similar).

Clicking a pill toggles the reaction:
- If current user already reacted with that emoji → `removeReaction`
- Otherwise → `addReaction`

A "+" pill at the end of the row opens the full emoji-mart picker as a popover.

Props: `reactions: ReactionSummary[]`, `currentUserId: string`, `onToggle: (emoji: string) => void`, `onPickEmoji: () => void`.

### Emoji Quick Pick — `components/EmojiQuickPick.tsx` (new)

A floating row of 6 preset emoji: 👍 ❤️ 😂 😮 😢 🎉. Appears as a popover when the 😊 button in the message action bar is clicked.

Clicking an emoji calls `addReaction` and closes the popover. If the user already reacted with that emoji, clicking it calls `removeReaction` instead (toggle behavior).

A "+" button at the end opens the full emoji-mart picker.

### Full Emoji Picker

Uses `@emoji-mart/react` with `@emoji-mart/data`. Rendered as a popover anchored to either the "+" pill or the "+" button in the quick-pick row. Selecting an emoji calls `addReaction` and closes the picker.

### MessageBubble Changes

- **Action bar**: Add a 😊 (Smile icon from lucide-react) button. Available on all non-deleted, non-delivery-failed messages. Clicking opens the `EmojiQuickPick` popover.
- **Below bubble**: Render `<ReactionPills>` when `message.reactions.length > 0` or when the quick-pick/picker is open (to show the "+" affordance).

## Dependency

Install `@emoji-mart/react` and `@emoji-mart/data` in `apps/web`.

## Files Summary

| File | Action |
|------|--------|
| `packages/kilo-chat/src/types.ts` | Add `ReactionSummary`, add `reactions` field to `Message` and `MessageRow` |
| `packages/kilo-chat/src/client.ts` | Pass through `reactions` in `parseMessageRow` |
| `apps/web/package.json` | Add `@emoji-mart/react`, `@emoji-mart/data` |
| `apps/web/.../hooks/useMessages.ts` | Add `reaction.added`/`reaction.removed` cache cases, `useAddReaction`, `useRemoveReaction` hooks |
| `apps/web/.../components/MessageArea.tsx` | Wire reaction events, pass reaction handlers to MessageBubble |
| `apps/web/.../components/MessageBubble.tsx` | Add smiley action button, render ReactionPills below bubble |
| `apps/web/.../components/ReactionPills.tsx` | New — reaction pill display + toggle + "+" picker trigger |
| `apps/web/.../components/EmojiQuickPick.tsx` | New — 6-emoji floating quick-pick row |

## Not in Scope

- Reaction notifications or toasts
- Reaction animations
- "Who reacted" tooltip/popover showing member names (can add later)
- Bot reactions from the openclaw plugin side
