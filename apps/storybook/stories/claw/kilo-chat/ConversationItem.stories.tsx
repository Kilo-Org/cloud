import type { Meta, StoryObj } from '@storybook/nextjs';
import type { ReactNode } from 'react';
import { ConversationItem } from '@/app/(app)/claw/kilo-chat/components/ConversationItem';
import {
  KiloChatContext,
  type KiloChatContextValue,
} from '@/app/(app)/claw/kilo-chat/components/kiloChatContext';

// ConversationItem only reads `basePath` from context; the rest of the
// KiloChatContextValue (event-service / kilo-chat clients) is not exercised in
// these isolated stories, so a minimal value is cast to satisfy the provider.
const mockContext = { basePath: '/claw/kilo-chat' } as KiloChatContextValue;

function ChatSidebar({ children }: { children: ReactNode }) {
  return (
    <KiloChatContext.Provider value={mockContext}>
      <div className="bg-background min-h-screen p-4">
        <div className="border-border w-72 rounded-lg border p-2">{children}</div>
      </div>
    </KiloChatContext.Provider>
  );
}

const now = Date.now();
const baseConversation = {
  conversationId: 'conv-1',
  title: 'Refactor billing lifecycle',
  lastActivityAt: now - 60_000,
  lastReadAt: now - 60_000,
  joinedAt: now - 3_600_000,
};

const noop = () => {};

// Radix menu/popover triggers open on pointerdown, not a bare click, so the
// play functions dispatch a full pointer sequence.
function openByPointer(el: Element | null | undefined) {
  if (!el) return;
  const opts = { bubbles: true, cancelable: true, composed: true, button: 0 };
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new PointerEvent('pointerup', opts));
  (el as HTMLElement).click();
}

const meta: Meta<typeof ConversationItem> = {
  title: 'Overlays/Menus/ConversationItem',
  component: ConversationItem,
  parameters: {
    layout: 'fullscreen',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const List: Story = {
  render: () => (
    <ChatSidebar>
      <ConversationItem conversation={baseConversation} isActive onRename={noop} onLeave={noop} />
      <ConversationItem
        conversation={{
          ...baseConversation,
          conversationId: 'conv-2',
          title: 'Unread: deploy backend',
          lastActivityAt: now,
          lastReadAt: now - 600_000,
        }}
        isActive={false}
        onRename={noop}
        onLeave={noop}
      />
      <ConversationItem
        conversation={{ ...baseConversation, conversationId: 'conv-3', title: null }}
        isActive={false}
        onRename={noop}
        onLeave={noop}
      />
    </ChatSidebar>
  ),
};

// Opens the kebab menu (Radix DropdownMenu).
export const MenuOpen: Story = {
  render: () => (
    <ChatSidebar>
      <ConversationItem conversation={baseConversation} isActive onRename={noop} onLeave={noop} />
    </ChatSidebar>
  ),
  play: async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    openByPointer(document.querySelector('button[aria-label="Conversation options"]'));
  },
};

// Opens the kebab menu then the leave-confirmation AlertDialog.
export const LeaveConfirm: Story = {
  render: () => (
    <ChatSidebar>
      <ConversationItem conversation={baseConversation} isActive onRename={noop} onLeave={noop} />
    </ChatSidebar>
  ),
  play: async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    openByPointer(document.querySelector('button[aria-label="Conversation options"]'));
    await new Promise(resolve => setTimeout(resolve, 120));
    const leave = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
      el => el.textContent?.trim() === 'Leave'
    );
    openByPointer(leave);
    await new Promise(resolve => setTimeout(resolve, 150));
  },
};
