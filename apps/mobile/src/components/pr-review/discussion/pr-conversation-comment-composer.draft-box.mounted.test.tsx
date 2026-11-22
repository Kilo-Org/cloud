// Mounted coverage for the conversation composer's draft-ready geometry: while
// the durable draft loads, the sheet body keeps the body field's own box instead
// of collapsing to nothing. A body with no first block leaves the footer label
// as the first thing the screen paints, which the design gate reports as a
// leading gap under the sheet header.

import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type ReactTestRenderer } from '@/test/renderer';

import { mount, unmountAll } from './pr-conversation-comment-composer.test-helpers';
import { PrConversationCommentComposer } from './pr-conversation-comment-composer';

const draft = vi.hoisted(() => ({ settled: false }));
const keyboard = vi.hoisted(() => ({ visible: false }));

vi.hoisted(() => {
  Object.assign(globalThis, { __DEV__: false });
});

vi.mock('react-native', () => ({
  BackHandler: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
  Keyboard: { addListener: vi.fn(() => ({ remove: vi.fn() })) },
  ScrollView: 'ScrollView',
  View: 'View',
  TextInput: 'TextInput',
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'not-used' }));
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(),
  notificationAsync: vi.fn(),
  ImpactFeedbackStyle: { Light: 'Light' },
  NotificationFeedbackType: { Success: 'Success' },
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/dialog', () => ({ useConfirmDialog: () => ({ dialog: null }) }));
vi.mock('@/components/pr-review/pr-form-sheet-chrome', () => ({
  PrFormSheetHeader: 'PrFormSheetHeader',
  PrFormSheetFooter: 'PrFormSheetFooter',
  useFormSheetKeyboardVisible: () => keyboard.visible,
}));
vi.mock('@/components/pr-review/pr-review-comment-composer-parts', () => ({
  CommentBodyField: 'CommentBodyField',
}));
vi.mock('@/components/pr-review/discussion/reply-input', () => ({
  ensureTermsAcceptedOutcome: vi.fn(),
}));
vi.mock('@/components/pr-review/composer-inline-error', () => ({
  ComposerInlineError: 'ComposerInlineError',
}));
vi.mock('@/lib/pr-review/discussion/use-review-discussion-mutations', () => ({
  useAddPrCommentMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({ connectionRefusesWrites: () => false }));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({ userId: 'u1', isLoading: false }),
}));
vi.mock('@/lib/persist/drafts', () => ({
  saveDraft: vi.fn(),
  clearDraft: vi.fn(() => Promise.resolve(true)),
  prConversationCommentDraftKey: () => 'pr-conversation:comment',
}));
vi.mock('@/lib/persist/use-draft-flush', () => ({ useDraftFlushOnBackground: vi.fn() }));
vi.mock('@/lib/hooks/use-surface-feedback', () => ({
  useSurfaceFeedback: () => ({
    feedback: { status: 'idle' },
    failure: null,
    begin: () => null,
    clearWhere: vi.fn(),
  }),
}));
vi.mock('@/lib/persist/use-draft-load', () => ({
  useFencedDraftLoad: () => ({ settled: draft.settled, value: null }),
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));

beforeEach(() => {
  draft.settled = false;
  keyboard.visible = false;
});

afterEach(() => {
  unmountAll();
});

function composer() {
  return createElement(PrConversationCommentComposer, {
    owner: 'acme',
    repo: 'sample',
    number: 7,
    onDismiss: () => undefined,
  });
}

/** The reserved field box, or undefined once the field itself renders. */
function placeholder(renderer: ReactTestRenderer) {
  const classes = renderer.root
    .findAllByType('View')
    .map(node => String(node.props.className ?? ''));
  const search = classes.find(entry => entry.startsWith('gap-6 px-4'));
  if (search === undefined) {
    throw new Error('missing the composer body');
  }
  const index = classes.indexOf(search);
  return classes
    .slice(index + 1)
    .find(entry => entry.startsWith('rounded-md border border-transparent'));
}

describe('conversation composer while the draft loads', () => {
  it('keeps the body field box at its closed line height', async () => {
    const renderer = await mount(composer());
    expect(renderer.root.findAllByType('CommentBodyField')).toHaveLength(0);
    expect(placeholder(renderer)).toBe('rounded-md border border-transparent min-h-14');
  });

  it('keeps the shorter box while the keyboard is up', async () => {
    keyboard.visible = true;
    const renderer = await mount(composer());
    expect(placeholder(renderer)).toBe('rounded-md border border-transparent min-h-12');
  });

  it('renders the field itself once the draft settles', async () => {
    draft.settled = true;
    const renderer = await mount(composer());
    expect(renderer.root.findAllByType('CommentBodyField')).toHaveLength(1);
    expect(placeholder(renderer)).toBeUndefined();
  });
});
