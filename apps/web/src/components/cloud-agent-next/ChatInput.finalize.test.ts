import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { CloudAgentAttachments } from '@/lib/cloud-agent/constants';
import type {
  CloudAgentAttachmentFile,
  UseCloudAgentAttachmentUploadReturn,
} from '@/hooks/useCloudAgentAttachmentUpload';
import type { CloudComposer as ChatInputComponent } from './assistant-ui/CloudComposer';

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
    window: window as unknown as Window,
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
    replaceAttachments: jest.fn(),
    hasUploadingAttachments: false,
    getAttachmentsData: jest.fn<() => CloudAgentAttachments | undefined>(),
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
 * walking the fiber tree.
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
  onChange({ target: { value }, nativeEvent: {} } as never);
}

/** Drive the textarea's own onKeyDown, the path a second Enter takes. */
function pressEnter(rootContainer: HTMLElement, nativeEvent = { isComposing: false, keyCode: 13 }) {
  type Fiber = {
    type: unknown;
    memoizedProps?: { onKeyDown?: (event: unknown) => void };
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
  let onKeyDown: ((event: unknown) => void) | undefined;
  walk(host?.stateNode?.current, fiber => {
    if (fiber.type === 'textarea' && typeof fiber.memoizedProps?.onKeyDown === 'function') {
      onKeyDown = fiber.memoizedProps.onKeyDown;
    }
  });
  if (!onKeyDown) throw new Error('textarea onKeyDown not found on fiber tree');
  onKeyDown({
    key: 'Enter',
    shiftKey: false,
    preventDefault: () => {},
    nativeEvent,
  });
}

/** Drive the hidden file input's onChange the way a native picker does. */
function changeFileInput(rootContainer: HTMLElement, files: File[]) {
  type Fiber = {
    type: unknown;
    memoizedProps?: { onChange?: (event: { target: { files: File[]; value: string } }) => void };
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
  let onChange: ((event: { target: { files: File[]; value: string } }) => void) | undefined;
  walk(host?.stateNode?.current, fiber => {
    if (fiber.type === 'input' && typeof fiber.memoizedProps?.onChange === 'function') {
      onChange = fiber.memoizedProps.onChange;
    }
  });
  if (!onChange) throw new Error('file input onChange not found on fiber tree');
  onChange({ target: { files, value: '' } });
}

// Runtime modules are loaded after the jest.mock registrations above so the
// presentational children and the upload hook are stubbed before ChatInput's
// own import graph resolves.
let ChatInput: typeof ChatInputComponent;
let toastError: jest.Mock;
let mockedUseCloudAgentAttachmentUpload: jest.Mock<
  (options: unknown) => UseCloudAgentAttachmentUploadReturn
>;

beforeAll(async () => {
  const { CloudComposer } = await import('./assistant-ui/CloudComposer');
  const { CloudChatRuntimeProvider } = await import('./assistant-ui/CloudChatRuntimeProvider');
  ChatInput = props =>
    createElement(CloudChatRuntimeProvider, {
      projection: { messages: [], isStreaming: false },
      state: {
        isLoading: false,
        isRunning: false,
        isReadOnly: false,
        isSendDisabled: false,
        canInterrupt: false,
      },
      onNew: async () => {},
      children: createElement(CloudComposer, props),
    });
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

  it('autosizes a hidden composer on reveal and width changes without reacting to height changes', () => {
    mockedUseCloudAgentAttachmentUpload.mockReturnValue(buildMockUpload());
    const dom = installLinkedomDom();
    const root = createRoot(dom.container);
    const previousResizeObserver = globalThis.ResizeObserver;
    const textareaPrototype = Object.getPrototypeOf(
      dom.container.ownerDocument.createElement('textarea')
    );
    const previousClientWidth = Object.getOwnPropertyDescriptor(textareaPrototype, 'clientWidth');
    const previousScrollHeight = Object.getOwnPropertyDescriptor(textareaPrototype, 'scrollHeight');
    let width = 0;
    let scrollHeight = 0;
    const readScrollHeight = jest.fn(() => scrollHeight);
    const observe = jest.fn();
    const disconnect = jest.fn();
    let notifyResize = () => {};
    class MockResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = () => callback([], this);
      }
      observe = observe;
      disconnect = disconnect;
      unobserve = jest.fn();
    }
    Object.defineProperties(textareaPrototype, {
      clientWidth: { configurable: true, get: () => width },
      scrollHeight: { configurable: true, get: readScrollHeight },
    });
    Object.assign(globalThis, { ResizeObserver: MockResizeObserver });

    try {
      act(() => {
        root.render(
          createElement(ChatInput, {
            onSend: jest.fn(async () => true),
            attachmentUploadOptions: { messageUuid: 'test-message-uuid' },
          })
        );
      });
      const textarea = dom.container.querySelector('textarea');
      if (!textarea) throw new Error('textarea missing');
      expect(textarea.style.height).not.toBe('0px');
      expect(readScrollHeight).not.toHaveBeenCalled();
      expect(observe).toHaveBeenCalledWith(textarea);

      width = 640;
      scrollHeight = 40;
      act(() => notifyResize());
      expect(textarea.style.height).toBe('40px');
      act(() => setTextareaValue(dom.container, 'Visible draft'));
      expect(textarea.value).toBe('Visible draft');

      readScrollHeight.mockClear();
      scrollHeight = 80;
      act(() => notifyResize());
      expect(readScrollHeight).not.toHaveBeenCalled();

      width = 320;
      act(() => notifyResize());
      expect(textarea.style.height).toBe('80px');
      scrollHeight = 240;
      act(() => setTextareaValue(dom.container, 'Longer draft'));
      expect(textarea.style.height).toBe('200px');

      width = 0;
      scrollHeight = 0;
      act(() => notifyResize());
      act(() => setTextareaValue(dom.container, 'Hidden draft'));
      expect(textarea.style.height).toBe('200px');
      width = 640;
      scrollHeight = 40;
      act(() => notifyResize());
      expect(textarea.style.height).toBe('40px');
      expect(textarea.value).toBe('Hidden draft');
    } finally {
      act(() => root.unmount());
      if (previousClientWidth) {
        Object.defineProperty(textareaPrototype, 'clientWidth', previousClientWidth);
      } else {
        delete textareaPrototype.clientWidth;
      }
      if (previousScrollHeight) {
        Object.defineProperty(textareaPrototype, 'scrollHeight', previousScrollHeight);
      } else {
        delete textareaPrototype.scrollHeight;
      }
      Object.assign(globalThis, { ResizeObserver: previousResizeObserver });
      dom.cleanup();
    }
    expect(disconnect).toHaveBeenCalled();
  });

  it('gates Stop on interrupt capability independently of send availability', () => {
    mockedUseCloudAgentAttachmentUpload.mockReturnValue(buildMockUpload());
    const onStop = jest.fn();
    const dom = installLinkedomDom();
    const root = createRoot(dom.container);
    const render = (canInterrupt: boolean, disabled: boolean, withHandler = true) => {
      act(() => {
        root.render(
          createElement(ChatInput, {
            onSend: jest.fn(async () => true),
            onStop: withHandler ? onStop : undefined,
            canInterrupt,
            disabled,
            isStreaming: true,
            attachmentUploadOptions: { messageUuid: 'test-message-uuid' },
          })
        );
      });
    };
    const stopButton = () => {
      const button = dom.container.querySelector<HTMLButtonElement>(
        'button[aria-label="Stop response"]'
      );
      if (!button) throw new Error('Stop button missing');
      return button;
    };

    try {
      render(true, true);
      expect(stopButton().hasAttribute('disabled')).toBe(false);
      act(() => stopButton().click());
      expect(onStop).toHaveBeenCalledTimes(1);

      render(false, true);
      expect(stopButton().hasAttribute('disabled')).toBe(true);
      act(() => stopButton().click());
      expect(onStop).toHaveBeenCalledTimes(1);

      render(false, false);
      expect(stopButton().hasAttribute('disabled')).toBe(true);

      render(true, true);
      expect(stopButton().hasAttribute('disabled')).toBe(false);

      render(true, false, false);
      expect(stopButton().hasAttribute('disabled')).toBe(true);
    } finally {
      act(() => root.unmount());
      dom.cleanup();
    }
  });

  it('keeps the draft editable without refocusing while submission is temporarily disabled', async () => {
    const upload = buildMockUpload();
    mockedUseCloudAgentAttachmentUpload.mockReturnValue(upload);
    const onSend = jest.fn<
      (message: string, attachments?: CloudAgentAttachments) => Promise<boolean>
    >(async () => true);
    const dom = installLinkedomDom();
    const root = createRoot(dom.container);
    const render = (disabled: boolean, textareaDisabled = false) => {
      act(() => {
        root.render(
          createElement(ChatInput, {
            onSend,
            disabled,
            textareaDisabled,
            attachmentUploadOptions: { messageUuid: 'test-message-uuid' },
          })
        );
      });
    };
    try {
      render(false);
      const textarea = dom.container.querySelector('textarea');
      if (!textarea) throw new Error('textarea missing');
      const focus = jest.spyOn(textarea, 'focus');
      textarea.focus();
      focus.mockClear();
      act(() => setTextareaValue(dom.container, 'first draft'));

      render(true);
      expect(dom.container.querySelector('textarea')).toBe(textarea);
      expect(textarea.hasAttribute('disabled')).toBe(false);
      act(() => setTextareaValue(dom.container, 'continued draft'));
      await act(async () => pressEnter(dom.container));
      expect(textarea.value).toBe('continued draft');
      expect(onSend).not.toHaveBeenCalled();
      expect(upload.finalizeAttachments).not.toHaveBeenCalled();
      expect(
        dom.container.querySelector('button[aria-label="Send message"]')?.hasAttribute('disabled')
      ).toBe(true);
      expect(
        dom.container.querySelector('button[aria-label="Attach files"]')?.hasAttribute('disabled')
      ).toBe(true);

      render(false);
      expect(textarea.value).toBe('continued draft');
      expect(focus).not.toHaveBeenCalled();
      await act(async () => pressEnter(dom.container));
      expect(onSend).toHaveBeenCalledWith('continued draft', undefined);

      render(true, true);
      expect(textarea.hasAttribute('disabled')).toBe(true);
    } finally {
      act(() => root.unmount());
      dom.cleanup();
    }
  });

  it('shows an error toast and keeps the input value when finalizeAttachments rejects', async () => {
    const finalizeAttachments = jest.fn(async () => {
      throw new Error('link failed');
    });
    mockedUseCloudAgentAttachmentUpload.mockReturnValue(
      buildMockUpload({
        finalizeAttachments,
        attachments: [
          {
            id: 'attachment',
            file: new File(['notes'], 'notes.txt', { type: 'text/plain' }),
            contentType: 'text/plain',
            kind: 'document',
            status: 'complete',
            progress: 100,
            r2Key: 'owner/cloud-agent/message/notes.txt',
          },
        ],
      })
    );
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

  it.each([true, false])(
    'routes /new locally and rejects files before finalization with attachments=%s',
    async hasAttachments => {
      const upload = buildMockUpload({
        attachments: hasAttachments
          ? [
              {
                id: 'attachment',
                file: new File(['notes'], 'notes.txt', { type: 'text/plain' }),
                contentType: 'text/plain',
                kind: 'document',
                status: 'complete',
                progress: 100,
                r2Key: 'owner/cloud-agent/message/notes.txt',
              },
            ]
          : [],
      });
      mockedUseCloudAgentAttachmentUpload.mockReturnValue(upload);
      const onSend = jest.fn(async () => true);
      const onNewChat = jest.fn(() => true);
      const dom = installLinkedomDom();
      let root: Root | undefined;
      try {
        act(() => {
          root = createRoot(dom.container);
          root.render(
            createElement(ChatInput, {
              onSend,
              onNewChat,
              attachmentUploadOptions: { messageUuid: 'test-message-uuid' },
            })
          );
        });
        act(() => setTextareaValue(dom.container, '/new '));
        await act(async () => {
          pressEnter(dom.container);
        });

        expect(onSend).not.toHaveBeenCalled();
        if (hasAttachments) {
          expect(upload.finalizeAttachments).not.toHaveBeenCalled();
          expect(onNewChat).not.toHaveBeenCalled();
          expect(upload.removeAttachment).not.toHaveBeenCalled();
          expect(toastError).toHaveBeenCalledWith('Files cannot be attached to slash commands', {
            description: 'Remove the files or type a plain prompt instead.',
          });
          expect(dom.container.querySelector('textarea')?.value).toBe('/new ');
        } else {
          expect(upload.finalizeAttachments).not.toHaveBeenCalled();
          expect(onNewChat).toHaveBeenCalledTimes(1);
          expect(dom.container.querySelector('textarea')?.value).toBe('');
        }
      } finally {
        act(() => root?.unmount());
        dom.cleanup();
      }
    }
  );

  it('ignores a second Enter while the link RPC is still in flight', async () => {
    let resolveFinalize!: (value: CloudAgentAttachments | undefined) => void;
    const finalizeAttachments = jest.fn(
      () =>
        new Promise<CloudAgentAttachments | undefined>(resolve => {
          resolveFinalize = resolve;
        })
    );
    mockedUseCloudAgentAttachmentUpload.mockReturnValue(
      buildMockUpload({
        finalizeAttachments,
        attachments: [
          {
            id: 'attachment',
            file: new File(['notes'], 'notes.txt', { type: 'text/plain' }),
            contentType: 'text/plain',
            kind: 'document',
            status: 'complete',
            progress: 100,
            r2Key: 'owner/cloud-agent/message/notes.txt',
          },
        ],
      })
    );
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
        pressEnter(dom.container);
      });
      act(() => {
        pressEnter(dom.container);
      });

      expect(finalizeAttachments).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveFinalize({ path: 'test-message-uuid', files: ['file.png'] });
        await Promise.resolve();
      });

      expect(onSend).toHaveBeenCalledTimes(1);
    } finally {
      act(() => {
        root.unmount();
      });
      dom.cleanup();
    }
  });

  it('does not restore a failed send draft after the conversation changed', async () => {
    mockedUseCloudAgentAttachmentUpload.mockReturnValue(buildMockUpload());
    let resolveSend!: (value: boolean) => void;
    const onSend = jest.fn<
      (message: string, attachments?: CloudAgentAttachments) => Promise<boolean>
    >(
      () =>
        new Promise<boolean>(resolve => {
          resolveSend = resolve;
        })
    );

    const dom = installLinkedomDom();
    let root!: Root;
    const render = (conversationKey: string) => {
      act(() => {
        root.render(
          createElement(ChatInput, {
            onSend,
            conversationKey,
            attachmentUploadOptions: { messageUuid: 'test-message-uuid' },
          })
        );
      });
    };
    try {
      act(() => {
        root = createRoot(dom.container);
      });
      render('chat-a');
      act(() => {
        setTextareaValue(dom.container, 'draft for A');
      });
      await act(async () => {
        pressEnter(dom.container);
      });
      expect(onSend).toHaveBeenCalledWith('draft for A', undefined);

      render('chat-b');
      await act(async () => {
        resolveSend(false);
        await Promise.resolve();
      });

      expect(dom.container.querySelector('textarea')?.value).toBe('');
    } finally {
      act(() => {
        root.unmount();
      });
      dom.cleanup();
    }
  });

  it('restores the failed send draft when the conversation is unchanged', async () => {
    mockedUseCloudAgentAttachmentUpload.mockReturnValue(buildMockUpload());
    let resolveSend!: (value: boolean) => void;
    const onSend = jest.fn<
      (message: string, attachments?: CloudAgentAttachments) => Promise<boolean>
    >(
      () =>
        new Promise<boolean>(resolve => {
          resolveSend = resolve;
        })
    );

    const dom = installLinkedomDom();
    let root!: Root;
    try {
      act(() => {
        root = createRoot(dom.container);
        root.render(
          createElement(ChatInput, {
            onSend,
            conversationKey: 'chat-a',
            attachmentUploadOptions: { messageUuid: 'test-message-uuid' },
          })
        );
      });
      act(() => {
        setTextareaValue(dom.container, 'draft for A');
      });
      await act(async () => {
        pressEnter(dom.container);
      });

      await act(async () => {
        resolveSend(false);
        await Promise.resolve();
      });

      expect(dom.container.querySelector('textarea')?.value).toBe('draft for A');
    } finally {
      act(() => {
        root.unmount();
      });
      dom.cleanup();
    }
  });

  it.each([true, false])(
    'cleans up accepted attachments and retains failed attachments after switching chats (accepted=%s)',
    async accepted => {
      const attachment: CloudAgentAttachmentFile = {
        id: 'attachment',
        file: new File(['notes'], 'notes.txt', { type: 'text/plain' }),
        contentType: 'text/plain',
        kind: 'document',
        status: 'complete',
        progress: 100,
        r2Key: 'owner/cloud-agent/message/notes.txt',
        previewUrl: 'blob:submitted',
      };
      const revokePreview = jest.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
      const upload = buildMockUpload({ attachments: [attachment] });
      mockedUseCloudAgentAttachmentUpload.mockReturnValue(upload);
      let resolveSend!: (value: boolean) => void;
      const onSend = jest.fn<
        (message: string, attachments?: CloudAgentAttachments) => Promise<boolean>
      >(
        () =>
          new Promise<boolean>(resolve => {
            resolveSend = resolve;
          })
      );

      const dom = installLinkedomDom();
      let root!: Root;
      const render = (conversationKey: string) => {
        act(() => {
          root.render(
            createElement(ChatInput, {
              onSend,
              conversationKey,
              attachmentUploadOptions: { messageUuid: 'test-message-uuid' },
            })
          );
        });
      };
      try {
        act(() => {
          root = createRoot(dom.container);
        });
        render('chat-a');
        act(() => {
          setTextareaValue(dom.container, 'draft for A');
        });
        await act(async () => {
          pressEnter(dom.container);
        });
        expect(onSend).toHaveBeenCalledWith('draft for A', undefined);
        expect(upload.finalizeAttachments).toHaveBeenCalledTimes(1);

        render('chat-b');
        const destinationAttachment = {
          ...attachment,
          id: 'destination-attachment',
          r2Key: 'owner/cloud-agent/b/notes.txt',
          previewUrl: 'blob:destination',
        };
        upload.attachments = [destinationAttachment];
        render('chat-b');
        act(() => setTextareaValue(dom.container, 'Draft for B'));
        expect(upload.clearAttachments).not.toHaveBeenCalled();
        expect(upload.removeAttachment).not.toHaveBeenCalled();
        const replaceCalls = (upload.replaceAttachments as jest.Mock).mock.calls;
        expect(replaceCalls.at(-1)?.[0]).toEqual([]);

        await act(async () => {
          resolveSend(accepted);
          await Promise.resolve();
        });
        expect(dom.container.querySelector('textarea')?.value).toBe('Draft for B');
        expect(upload.clearAttachments).not.toHaveBeenCalled();

        expect(revokePreview).toHaveBeenCalledTimes(accepted ? 1 : 0);
        if (accepted) expect(revokePreview).toHaveBeenCalledWith('blob:submitted');
        render('chat-a');
        expect(dom.container.querySelector('textarea')?.value).toBe(accepted ? '' : 'draft for A');
        expect((upload.replaceAttachments as jest.Mock).mock.calls.at(-1)?.[0]).toEqual(
          accepted ? [] : [attachment]
        );
        expect(upload.clearAttachments).not.toHaveBeenCalled();
        upload.attachments = accepted ? [] : [attachment];
        render('chat-a');
        render('chat-b');
        expect(dom.container.querySelector('textarea')?.value).toBe('Draft for B');
        expect((upload.replaceAttachments as jest.Mock).mock.calls.at(-1)?.[0]).toEqual([
          destinationAttachment,
        ]);
      } finally {
        act(() => {
          root.unmount();
        });
        dom.cleanup();
        revokePreview.mockRestore();
      }
    }
  );

  it('starts a new chat while an ordinary send request is held', async () => {
    const upload = buildMockUpload();
    mockedUseCloudAgentAttachmentUpload.mockReturnValue(upload);
    const onSend = jest.fn<
      (message: string, attachments?: CloudAgentAttachments) => Promise<boolean>
    >(() => new Promise<boolean>(() => {}));
    const onNewChat = jest.fn(() => true);

    const dom = installLinkedomDom();
    let root!: Root;
    const render = (disabled: boolean) => {
      act(() => {
        root.render(
          createElement(ChatInput, {
            onSend,
            onNewChat,
            disabled,
            attachmentUploadOptions: { messageUuid: 'test-message-uuid' },
          })
        );
      });
    };
    try {
      act(() => {
        root = createRoot(dom.container);
      });
      render(false);
      act(() => {
        setTextareaValue(dom.container, 'hi');
      });
      await act(async () => {
        pressEnter(dom.container);
      });
      expect(onSend).toHaveBeenCalledTimes(1);

      render(true);
      act(() => {
        setTextareaValue(dom.container, '/new');
      });
      const newChatButton = dom.container.querySelector<HTMLButtonElement>(
        'button[aria-label="New chat"]'
      );
      expect(newChatButton).not.toBeNull();
      expect(newChatButton?.hasAttribute('disabled')).toBe(false);
      await act(async () => {
        newChatButton?.click();
      });

      expect(onNewChat).toHaveBeenCalledTimes(1);
      expect(onSend).toHaveBeenCalledTimes(1);

      // `/new` must not clear the ordinary send guard it bypassed.
      const stillSending = dom.container.querySelector<HTMLButtonElement>(
        'button[aria-label="Sending message"]'
      );
      expect(stillSending).not.toBeNull();
      expect(stillSending?.getAttribute('aria-busy')).toBe('true');
    } finally {
      act(() => {
        root.unmount();
      });
      dom.cleanup();
    }
  });

  it('does not treat another conversation as pending while the first request is held', async () => {
    mockedUseCloudAgentAttachmentUpload.mockReturnValue(buildMockUpload());
    const onSend = jest.fn<
      (message: string, attachments?: CloudAgentAttachments) => Promise<boolean>
    >(() => new Promise<boolean>(() => {}));

    const dom = installLinkedomDom();
    let root!: Root;
    const render = (conversationKey: string) => {
      act(() => {
        root.render(
          createElement(ChatInput, {
            onSend,
            conversationKey,
            attachmentUploadOptions: { messageUuid: 'test-message-uuid' },
          })
        );
      });
    };
    try {
      act(() => {
        root = createRoot(dom.container);
      });
      render('chat-a');
      act(() => {
        setTextareaValue(dom.container, 'from A');
      });
      await act(async () => {
        pressEnter(dom.container);
      });
      expect(onSend).toHaveBeenCalledTimes(1);

      render('chat-b');
      act(() => {
        setTextareaValue(dom.container, 'from B');
      });

      const sendButton = dom.container.querySelector<HTMLButtonElement>(
        'button[aria-label="Send message"]'
      );
      expect(sendButton).not.toBeNull();
      expect(sendButton?.hasAttribute('disabled')).toBe(false);
      expect(sendButton?.getAttribute('aria-busy')).toBeNull();
      expect(dom.container.querySelector('button[aria-label="Sending message"]')).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
      dom.cleanup();
    }
  });

  it('keeps the second conversation pending after the first request settles', async () => {
    mockedUseCloudAgentAttachmentUpload.mockReturnValue(buildMockUpload());
    const resolvers: Array<(value: boolean) => void> = [];
    const onSend = jest.fn<
      (message: string, attachments?: CloudAgentAttachments) => Promise<boolean>
    >(
      () =>
        new Promise<boolean>(resolve => {
          resolvers.push(resolve);
        })
    );

    const dom = installLinkedomDom();
    let root!: Root;
    const render = (conversationKey: string) => {
      act(() => {
        root.render(
          createElement(ChatInput, {
            onSend,
            conversationKey,
            attachmentUploadOptions: { messageUuid: 'test-message-uuid' },
          })
        );
      });
    };
    try {
      act(() => {
        root = createRoot(dom.container);
      });
      render('chat-a');
      act(() => {
        setTextareaValue(dom.container, 'from A');
      });
      await act(async () => {
        pressEnter(dom.container);
      });

      render('chat-b');
      act(() => {
        setTextareaValue(dom.container, 'from B');
      });
      await act(async () => {
        pressEnter(dom.container);
      });
      expect(onSend).toHaveBeenCalledTimes(2);

      await act(async () => {
        resolvers[0](false);
        await Promise.resolve();
      });

      const sending = dom.container.querySelector<HTMLButtonElement>(
        'button[aria-label="Sending message"]'
      );
      expect(sending).not.toBeNull();
      expect(sending?.getAttribute('aria-busy')).toBe('true');
      expect(dom.container.querySelector('textarea')?.value).toBe('');
    } finally {
      act(() => {
        root.unmount();
      });
      dom.cleanup();
    }
  });

  it('opens the picker and accepts a file input while idle', async () => {
    const upload = buildMockUpload();
    mockedUseCloudAgentAttachmentUpload.mockReturnValue(upload);

    const dom = installLinkedomDom();
    let root: Root | undefined;
    try {
      act(() => {
        root = createRoot(dom.container);
        root.render(
          createElement(ChatInput, {
            onSend: jest.fn(async () => true),
            attachmentUploadOptions: { messageUuid: 'test-message-uuid' },
          })
        );
      });

      const fileInput = dom.container.querySelector<HTMLInputElement>('input[type="file"]');
      if (!fileInput) throw new Error('file input missing');
      const openPicker = jest.spyOn(fileInput, 'click').mockImplementation(() => {});

      act(() => {
        dom.container
          .querySelector<HTMLButtonElement>('button[aria-label="Attach files"]')
          ?.click();
      });
      expect(openPicker).toHaveBeenCalledTimes(1);

      act(() => {
        changeFileInput(dom.container, [new File(['notes'], 'notes.txt', { type: 'text/plain' })]);
      });
      expect(upload.addFiles).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root?.unmount());
      dom.cleanup();
    }
  });

  it('accepts files in the second conversation while the first request is held', async () => {
    const upload = buildMockUpload();
    mockedUseCloudAgentAttachmentUpload.mockReturnValue(upload);
    const onSend = jest.fn<
      (message: string, attachments?: CloudAgentAttachments) => Promise<boolean>
    >(() => new Promise<boolean>(() => {}));

    const dom = installLinkedomDom();
    let root!: Root;
    const render = (conversationKey: string) => {
      act(() => {
        root.render(
          createElement(ChatInput, {
            onSend,
            conversationKey,
            attachmentUploadOptions: { messageUuid: 'test-message-uuid' },
          })
        );
      });
    };
    try {
      act(() => {
        root = createRoot(dom.container);
      });
      render('chat-a');
      act(() => {
        setTextareaValue(dom.container, 'from A');
      });
      await act(async () => {
        pressEnter(dom.container);
      });

      // The conversation that owns the held request refuses new files…
      act(() => {
        changeFileInput(dom.container, [new File(['a'], 'a.txt', { type: 'text/plain' })]);
      });
      expect(upload.addFiles).not.toHaveBeenCalled();

      // …but another conversation is not blocked by it.
      render('chat-b');
      act(() => {
        changeFileInput(dom.container, [new File(['b'], 'b.txt', { type: 'text/plain' })]);
      });
      expect(upload.addFiles).toHaveBeenCalledTimes(1);
    } finally {
      act(() => {
        root.unmount();
      });
      dom.cleanup();
    }
  });
});

describe('CloudComposer originating draft transaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  it.each([true, false])(
    'preserves newer typing when the held submission settles accepted=%s',
    async accepted => {
      mockedUseCloudAgentAttachmentUpload.mockReturnValue(buildMockUpload());
      let settle: (value: boolean) => void = () => {
        throw new Error('Send not started');
      };
      const onSend = jest.fn(
        () =>
          new Promise<boolean>(resolve => {
            settle = resolve;
          })
      );
      const dom = installLinkedomDom();
      const root = createRoot(dom.container);
      try {
        act(() =>
          root.render(
            createElement(ChatInput, {
              onSend,
              conversationKey: 'chat-a',
              attachmentUploadOptions: { messageUuid: 'transaction' },
            })
          )
        );
        act(() => setTextareaValue(dom.container, 'Original draft'));
        await act(async () => {
          pressEnter(dom.container);
        });
        act(() => setTextareaValue(dom.container, 'Newer draft'));
        await act(async () => {
          pressEnter(dom.container);
        });
        expect(onSend).toHaveBeenCalledTimes(1);
        await act(async () => {
          settle(accepted);
        });
        expect(dom.container.querySelector('textarea')?.value).toBe('Newer draft');
        expect(onSend).toHaveBeenCalledTimes(1);
      } finally {
        act(() => root.unmount());
        dom.cleanup();
      }
    }
  );
  it('does not resurrect an older rejected draft after the user types and clears a new revision', async () => {
    mockedUseCloudAgentAttachmentUpload.mockReturnValue(buildMockUpload());
    let settle: (value: boolean) => void = () => {
      throw new Error('Send not started');
    };
    const onSend = jest.fn(
      () =>
        new Promise<boolean>(resolve => {
          settle = resolve;
        })
    );
    const dom = installLinkedomDom();
    const root = createRoot(dom.container);
    try {
      act(() =>
        root.render(
          createElement(ChatInput, {
            onSend,
            conversationKey: 'chat-a',
            attachmentUploadOptions: { messageUuid: 'transaction' },
          })
        )
      );
      act(() => setTextareaValue(dom.container, 'Original draft'));
      await act(async () => {
        pressEnter(dom.container);
      });
      act(() => setTextareaValue(dom.container, 'New revision'));
      act(() => setTextareaValue(dom.container, ''));
      await act(async () => {
        settle(false);
      });
      expect(dom.container.querySelector('textarea')?.value).toBe('');
    } finally {
      act(() => root.unmount());
      dom.cleanup();
    }
  });
  it('does not send into the destination conversation after upload finalization finishes late', async () => {
    let finalize: (value: CloudAgentAttachments | undefined) => void = () => {
      throw new Error('Finalization not started');
    };
    const upload = buildMockUpload({
      attachments: [
        {
          id: 'file-a',
          status: 'complete',
          contentType: 'text/plain',
          kind: 'document',
          progress: 100,
          r2Key: 'fixture/file-a',
          file: new File(['test'], 'a.txt', { type: 'text/plain' }),
        },
      ],
      finalizeAttachments: jest.fn(
        () =>
          new Promise<CloudAgentAttachments | undefined>(resolve => {
            finalize = resolve;
          })
      ),
    });
    mockedUseCloudAgentAttachmentUpload.mockReturnValue(upload);
    const onSend = jest.fn(async () => true);
    const dom = installLinkedomDom();
    const root = createRoot(dom.container);
    const render = (conversationKey: string) =>
      act(() =>
        root.render(
          createElement(ChatInput, {
            onSend,
            conversationKey,
            attachmentUploadOptions: { messageUuid: 'transaction' },
          })
        )
      );
    try {
      render('chat-a');
      act(() => setTextareaValue(dom.container, 'Original draft'));
      await act(async () => {
        pressEnter(dom.container);
      });
      render('chat-b');
      act(() => setTextareaValue(dom.container, 'Chat B draft'));
      await act(async () => {
        finalize({ path: 'transaction', files: ['file-a'] });
      });
      expect(onSend).not.toHaveBeenCalled();
      expect(dom.container.querySelector('textarea')?.value).toBe('Chat B draft');
    } finally {
      act(() => root.unmount());
      dom.cleanup();
    }
  });
});

it.each([
  { isComposing: true, keyCode: 13 },
  { isComposing: false, keyCode: 229 },
])('keeps IME Enter from submitting: %j', async nativeEvent => {
  mockedUseCloudAgentAttachmentUpload.mockReturnValue(buildMockUpload());
  const onSend = jest.fn(async () => true);
  const dom = installLinkedomDom();
  const root = createRoot(dom.container);
  try {
    act(() =>
      root.render(
        createElement(ChatInput, {
          onSend,
          conversationKey: 'ime',
          attachmentUploadOptions: { messageUuid: 'ime' },
        })
      )
    );
    act(() => setTextareaValue(dom.container, 'Composing draft'));
    await act(async () => {
      pressEnter(dom.container, nativeEvent);
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(dom.container.querySelector('textarea')?.value).toBe('Composing draft');
    await act(async () => {
      pressEnter(dom.container);
    });
    expect(onSend).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
    dom.cleanup();
  }
});

it.each([false, true])(
  'guards SDK failedPrompt restoration against newer revisions (newer=%s)',
  async newer => {
    mockedUseCloudAgentAttachmentUpload.mockReturnValue(buildMockUpload());
    let settle: (value: boolean) => void = () => {
      throw new Error('Send not started');
    };
    const onSend = jest.fn(
      () =>
        new Promise<boolean>(resolve => {
          settle = resolve;
        })
    );
    const dom = installLinkedomDom();
    const root = createRoot(dom.container);
    const render = (conversationKey: string, initialValue?: string) =>
      act(() =>
        root.render(
          createElement(ChatInput, {
            onSend,
            conversationKey,
            initialValue,
            attachmentUploadOptions: { messageUuid: 'failure' },
          })
        )
      );
    try {
      render('chat-a');
      act(() => setTextareaValue(dom.container, 'Original draft'));
      await act(async () => {
        pressEnter(dom.container);
      });
      if (newer) {
        act(() => setTextareaValue(dom.container, 'New revision'));
        act(() => setTextareaValue(dom.container, ''));
      }
      render('chat-a', 'Original draft');
      await act(async () => {
        settle(false);
      });
      expect(dom.container.querySelector('textarea')?.value).toBe(newer ? '' : 'Original draft');
      render('chat-b');
      act(() => setTextareaValue(dom.container, 'B new revision'));
      act(() => setTextareaValue(dom.container, ''));
      render('chat-b', 'B failed prompt');
      expect(dom.container.querySelector('textarea')?.value).toBe('');
      render('chat-a', 'Original draft');
      expect(dom.container.querySelector('textarea')?.value).toBe(newer ? '' : 'Original draft');
    } finally {
      act(() => root.unmount());
      dom.cleanup();
    }
  }
);

it.each(['unsent', 'accepted', 'rejected'] as const)(
  'retains conversation drafts/files through hidden read-only history (%s)',
  async outcome => {
    const attachment: CloudAgentAttachmentFile = {
      id: 'file-a',
      file: new File(['a'], 'a.txt', { type: 'text/plain' }),
      contentType: 'text/plain',
      kind: 'document',
      status: 'complete',
      progress: 100,
      r2Key: 'fixture/a',
    };
    const upload = buildMockUpload({ attachments: [attachment] });
    upload.replaceAttachments = jest.fn((next: CloudAgentAttachmentFile[]) => {
      upload.attachments = next;
    });
    mockedUseCloudAgentAttachmentUpload.mockReturnValue(upload);
    let settle: (accepted: boolean) => void = () => {
      throw new Error('No pending send');
    };
    const onSend = jest.fn(
      () =>
        new Promise<boolean>(resolve => {
          settle = resolve;
        })
    );
    const dom = installLinkedomDom();
    const root = createRoot(dom.container);
    const render = (conversationKey: string, hidden = false) =>
      act(() =>
        root.render(
          createElement(
            'div',
            { hidden },
            createElement(ChatInput, {
              onSend,
              conversationKey,
              disabled: hidden,
              textareaDisabled: hidden,
              attachmentsEnabled: !hidden,
              attachmentUploadOptions: { messageUuid: 'hidden' },
            })
          )
        )
      );
    try {
      render('chat-a');
      act(() => setTextareaValue(dom.container, 'Draft A'));
      if (outcome !== 'unsent')
        await act(async () => {
          pressEnter(dom.container);
        });
      render('history', true);
      if (outcome !== 'unsent')
        await act(async () => {
          settle(outcome === 'accepted');
        });
      render('chat-b');
      expect(dom.container.querySelector('textarea')?.value).toBe('');
      act(() => setTextareaValue(dom.container, 'Draft B'));
      render('chat-a');
      expect(dom.container.querySelector('textarea')?.value).toBe(
        outcome === 'accepted' ? '' : 'Draft A'
      );
      expect(upload.replaceAttachments).toHaveBeenLastCalledWith(
        outcome === 'accepted' ? [] : [attachment]
      );
      render('chat-b');
      expect(dom.container.querySelector('textarea')?.value).toBe('Draft B');
    } finally {
      act(() => root.unmount());
      dom.cleanup();
    }
  }
);

it.each(['chat-b', 'new'])(
  'does not copy a stale SDK failure into %s during navigation',
  async destination => {
    mockedUseCloudAgentAttachmentUpload.mockReturnValue(buildMockUpload());
    const dom = installLinkedomDom();
    const root = createRoot(dom.container);
    const onSend = jest.fn(async () => false);
    const render = (conversationKey: string, initialValue?: string) =>
      act(() =>
        root.render(
          createElement(ChatInput, {
            onSend,
            conversationKey,
            initialValue,
            attachmentUploadOptions: { messageUuid: 'navigation' },
          })
        )
      );
    try {
      render('chat-a');
      act(() => setTextareaValue(dom.container, 'A failed prompt'));
      await act(async () => {
        pressEnter(dom.container);
      });
      render('chat-a', 'A failed prompt');
      expect(dom.container.querySelector('textarea')?.value).toBe('A failed prompt');
      render(destination, 'A failed prompt');
      render(destination);
      expect(dom.container.querySelector('textarea')?.value).toBe('');
      render('chat-a', 'A failed prompt');
      expect(dom.container.querySelector('textarea')?.value).toBe('A failed prompt');
    } finally {
      act(() => root.unmount());
      dom.cleanup();
    }
  }
);

it('retains submission ownership while another conversation stores its draft', async () => {
  mockedUseCloudAgentAttachmentUpload.mockReturnValue(buildMockUpload());
  let settle: (accepted: boolean) => void = () => {
    throw new Error('Send not started');
  };
  const onSend = jest.fn(
    () =>
      new Promise<boolean>(resolve => {
        settle = resolve;
      })
  );
  const dom = installLinkedomDom();
  const root = createRoot(dom.container);
  const render = (conversationKey: string, initialValue?: string) =>
    act(() =>
      root.render(
        createElement(ChatInput, {
          onSend,
          conversationKey,
          initialValue,
          attachmentUploadOptions: { messageUuid: 'ownership' },
        })
      )
    );
  try {
    render('chat-a');
    act(() => setTextareaValue(dom.container, 'Original draft'));
    await act(async () => {
      pressEnter(dom.container);
    });
    render('chat-b');
    render('chat-a', 'Original draft');
    expect(dom.container.querySelector('textarea')?.value).toBe('Original draft');
    await act(async () => {
      settle(false);
    });
  } finally {
    act(() => root.unmount());
    dom.cleanup();
  }
});

it.each(['chat-b', 'new'])(
  'does not seed %s from a stale SDK failure when the composer mounts',
  destination => {
    mockedUseCloudAgentAttachmentUpload.mockReturnValue(buildMockUpload());
    const dom = installLinkedomDom();
    const root = createRoot(dom.container);
    const onSend = jest.fn(async () => true);
    try {
      act(() =>
        root.render(
          createElement(ChatInput, {
            onSend,
            conversationKey: destination,
            initialValue: 'Private prompt from chat A',
            attachmentUploadOptions: { messageUuid: 'remount' },
          })
        )
      );
      expect(dom.container.querySelector('textarea')?.value).toBe('');
      act(() =>
        root.render(
          createElement(ChatInput, {
            onSend,
            conversationKey: destination,
            attachmentUploadOptions: { messageUuid: 'remount' },
          })
        )
      );
      expect(dom.container.querySelector('textarea')?.value).toBe('');
    } finally {
      act(() => root.unmount());
      dom.cleanup();
    }
  }
);
