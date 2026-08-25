import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { UseCloudAgentAttachmentUploadReturn } from '@/hooks/useCloudAgentAttachmentUpload';
import type { ChatInput as ChatInputComponent } from './ChatInput';

jest.mock('sonner', () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('@/hooks/useCloudAgentAttachmentUpload', () => ({
  useCloudAgentAttachmentUpload: jest.fn(),
}));

// Presentational children pull heavy provider/alias dependencies that the
// jest module map does not resolve; this test only drives the composer's own
// send path.
jest.mock('./BrowseCommandsDialog', () => ({ BrowseCommandsDialog: () => null }));
jest.mock('./MobileToolbarPopover', () => ({ MobileToolbarPopover: () => null }));
jest.mock('./AttachmentPreviewStrip', () => ({ AttachmentPreviewStrip: () => null }));
jest.mock('@/components/shared/ModeCombobox', () => ({
  ModeCombobox: () => null,
  NEXT_MODE_OPTIONS: [],
}));
jest.mock('@/components/shared/ModelCombobox', () => ({ ModelCombobox: () => null }));
jest.mock('@/components/shared/VariantCombobox', () => ({ VariantCombobox: () => null }));

type LinkedomParseHtml = (html: string) => {
  document: Document;
  window: typeof globalThis & {
    Event: typeof Event;
    HTMLTextAreaElement: typeof HTMLTextAreaElement;
  };
};

/** linkedom lives in the monorepo pnpm store (transitive); resolve from here. */
function installLinkedomDom(): {
  cleanup: () => void;
  container: HTMLElement;
  window: Window;
} {
  const requireFromHere = createRequire(__filename);
  const loadLinkedom = (): { parseHTML: LinkedomParseHtml } => {
    try {
      return requireFromHere('linkedom') as { parseHTML: LinkedomParseHtml };
    } catch {
      return requireFromHere(
        '../../../../node_modules/.pnpm/linkedom@0.18.12/node_modules/linkedom'
      ) as { parseHTML: LinkedomParseHtml };
    }
  };
  const { parseHTML } = loadLinkedom();
  const { window, document } = parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>'
  );

  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Element: globalThis.Element,
    Node: globalThis.Node,
    Event: globalThis.Event,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  };

  Object.assign(globalThis, {
    window,
    document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  const container = document.getElementById('root');
  if (!container) throw new Error('linkedom root missing');

  return {
    container: container as unknown as HTMLElement,
    window,
    cleanup: () => {
      Object.assign(globalThis, previous);
    },
  };
}

function buildMockUpload(
  overrides: Partial<UseCloudAgentAttachmentUploadReturn> = {}
): UseCloudAgentAttachmentUploadReturn {
  return {
    attachments: [],
    addFiles: jest.fn(),
    removeAttachment: jest.fn(),
    clearAttachments: jest.fn(),
    hasUploadingAttachments: false,
    getAttachmentsData: jest.fn(),
    finalizeAttachments: jest.fn(async () => undefined),
    isDragging: false,
    dragHandlers: {
      onDragEnter: jest.fn(),
      onDragOver: jest.fn(),
      onDragLeave: jest.fn(),
      onDrop: jest.fn(),
    },
    ...overrides,
  };
}

/**
 * linkedom + React's controlled-textarea tracking don't round-trip a raw
 * 'input' event reliably, so drive the same onChange the textarea wires up by
 * walking the fiber tree (the technique AutoRoutingModeCard.test.ts uses for
 * Radix Select).
 */
function setTextareaValue(rootContainer: HTMLElement, value: string) {
  type Fiber = {
    type: unknown;
    memoizedProps?: { onChange?: (event: { target: { value: string } }) => void };
    child?: Fiber | null;
    sibling?: Fiber | null;
  };
  const reactKey = Object.keys(rootContainer).find(key => key.startsWith('__reactContainer'));
  const host = reactKey
    ? (rootContainer as unknown as Record<string, { stateNode?: { current?: Fiber } }>)[reactKey]
    : undefined;
  const walk = (fiber: Fiber | null | undefined, visit: (f: Fiber) => void) => {
    if (!fiber) return;
    visit(fiber);
    walk(fiber.child, visit);
    walk(fiber.sibling, visit);
  };
  let onChange: ((event: { target: { value: string } }) => void) | undefined;
  walk(host?.stateNode?.current, fiber => {
    if (fiber.type === 'textarea' && typeof fiber.memoizedProps?.onChange === 'function') {
      onChange = fiber.memoizedProps.onChange;
    }
  });
  if (!onChange) throw new Error('textarea onChange not found on fiber tree');
  onChange({ target: { value } });
}

// Runtime modules are loaded after the jest.mock registrations above so the
// presentational children and the upload hook are stubbed before ChatInput's
// own import graph resolves.
let ChatInput: ChatInputComponent;
let toastError: jest.Mock;
let mockedUseCloudAgentAttachmentUpload: jest.Mock<
  (options: unknown) => UseCloudAgentAttachmentUploadReturn
>;

beforeAll(async () => {
  ({ ChatInput } = await import('./ChatInput'));
  const sonner = await import('sonner');
  toastError = sonner.toast.error as unknown as jest.Mock;
  const uploadModule = await import('@/hooks/useCloudAgentAttachmentUpload');
  mockedUseCloudAgentAttachmentUpload =
    uploadModule.useCloudAgentAttachmentUpload as unknown as jest.Mock<
      (options: unknown) => UseCloudAgentAttachmentUploadReturn
    >;
});

describe('ChatInput finalize failure', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows an error toast and keeps the input value when finalizeAttachments rejects', async () => {
    const finalizeAttachments = jest.fn(async () => {
      throw new Error('link failed');
    });
    mockedUseCloudAgentAttachmentUpload.mockReturnValue(buildMockUpload({ finalizeAttachments }));
    const onSend = jest.fn(async () => true);

    const dom = installLinkedomDom();
    let root!: Root;
    try {
      act(() => {
        root = createRoot(dom.container);
        root.render(
          createElement(ChatInput, {
            onSend,
            attachmentUploadOptions: { messageUuid: 'test-message-uuid' },
          })
        );
      });

      act(() => {
        setTextareaValue(dom.container, 'first message');
      });

      act(() => {
        const sendButton = dom.container.querySelector('button[aria-label="Send message"]');
        if (!sendButton) throw new Error('send button not found');
        (sendButton as HTMLButtonElement).click();
      });

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(finalizeAttachments).toHaveBeenCalledTimes(1);
      expect(toastError).toHaveBeenCalledWith('Failed to attach files. Please try again.', {
        description: 'link failed',
      });
      expect(onSend).not.toHaveBeenCalled();

      const textarea = dom.container.querySelector('textarea');
      expect(textarea).not.toBeNull();
      expect((textarea as HTMLTextAreaElement).value).toBe('first message');
    } finally {
      act(() => {
        root.unmount();
      });
      dom.cleanup();
    }
  });
});
