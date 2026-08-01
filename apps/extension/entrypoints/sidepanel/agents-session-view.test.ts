/* eslint-disable capitalized-comments, id-length, jest/max-expects, max-lines, sort-keys */
// @vitest-environment jsdom

import { createElement as h } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import type {
  StandaloneQuestion,
  StandalonePermission,
  StoredMessage,
  UserMessage,
  AssistantMessage,
} from '@kilocode/cloud-agent-sdk';
import { AgentsBlockingCards } from './agents-blocking-cards';
import { AgentsComposer } from './agents-composer';
import { AgentsMessageList } from './agents-message-list';

// ---- AgentsMessageList rendering ----

describe('agents message list rendering', () => {
  it('renders empty state when no messages', () => {
    const { container } = render(h(AgentsMessageList, { messages: [] }));
    expect(container.textContent).toContain('No messages yet');
  });

  it('renders user message as right-aligned', () => {
    const messages: StoredMessage[] = [
      {
        info: {
          id: 'msg-1',
          sessionID: 'ses-1',
          role: 'user',
          time: { created: 1000 },
          agent: '',
          model: { providerID: 'kilo', modelID: 'test' },
        } satisfies UserMessage,
        parts: [
          {
            id: 'p-1',
            sessionID: 'ses-1',
            messageID: 'msg-1',
            type: 'text' as const,
            text: 'Hello',
          },
        ],
      },
    ];

    const { container } = render(h(AgentsMessageList, { messages }));
    expect(container.querySelector('.justify-end')).not.toBeNull();
    expect(container.textContent).toContain('Hello');
  });

  it('renders assistant message as left-aligned markdown', () => {
    const messages: StoredMessage[] = [
      {
        info: {
          id: 'msg-2',
          sessionID: 'ses-1',
          role: 'assistant',
          time: { created: 2000, completed: 2000 },
          parentID: 'msg-1',
          modelID: 'test',
          providerID: 'kilo',
          mode: 'code',
          agent: '',
          path: { cwd: '/', root: '/' },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        } satisfies AssistantMessage,
        parts: [
          {
            id: 'p-2',
            sessionID: 'ses-1',
            messageID: 'msg-2',
            type: 'text' as const,
            text: '**bold**',
          },
        ],
      },
    ];

    const { container } = render(h(AgentsMessageList, { messages }));
    expect(container.querySelector('strong')).not.toBeNull();
  });

  it('renders tool parts as name + status row', () => {
    const messages: StoredMessage[] = [
      {
        info: {
          id: 'msg-3',
          sessionID: 'ses-1',
          role: 'assistant',
          time: { created: 3000 },
          parentID: 'msg-2',
          modelID: 'test',
          providerID: 'kilo',
          mode: 'code',
          agent: '',
          path: { cwd: '/', root: '/' },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        } satisfies AssistantMessage,
        parts: [
          {
            id: 'p-3',
            sessionID: 'ses-1',
            messageID: 'msg-3',
            type: 'tool' as const,
            callID: 'call-1',
            tool: 'read_file',
            state: {
              status: 'completed' as const,
              input: {},
              output: '',
              title: '',
              metadata: {},
              time: { start: 3000, end: 3100 },
            },
          },
        ],
      },
    ];

    const { container } = render(h(AgentsMessageList, { messages }));
    expect(container.textContent).toContain('read_file');
    expect(container.textContent).toContain('completed');
  });

  it('renders reasoning parts as muted label', () => {
    const messages: StoredMessage[] = [
      {
        info: {
          id: 'msg-4',
          sessionID: 'ses-1',
          role: 'assistant',
          time: { created: 4000, completed: 4000 },
          parentID: 'msg-3',
          modelID: 'test',
          providerID: 'kilo',
          mode: 'code',
          agent: '',
          path: { cwd: '/', root: '/' },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        } satisfies AssistantMessage,
        parts: [
          {
            id: 'p-4',
            sessionID: 'ses-1',
            messageID: 'msg-4',
            type: 'reasoning' as const,
            text: 'Let me think...',
            time: { start: 4000, end: 4100 },
          },
        ],
      },
    ];

    const { container } = render(h(AgentsMessageList, { messages }));
    expect(container.textContent).toContain('Reasoning');
  });
});

// ---- AgentsComposer rendering ----

describe('agents composer rendering', () => {
  it('renders read-only banner when isReadOnly is true', () => {
    const { container } = render(
      h(AgentsComposer, {
        canSend: false,
        canInterrupt: false,
        isStreaming: false,
        isReadOnly: true,
        isLoading: false,
        onSend: () => {},
        onStop: () => {},
      })
    );
    expect(container.textContent).toContain('This session is read-only');
  });

  it('renders loading skeleton when isLoading is true', () => {
    const { container } = render(
      h(AgentsComposer, {
        canSend: false,
        canInterrupt: false,
        isStreaming: false,
        isReadOnly: false,
        isLoading: true,
        onSend: () => {},
        onStop: () => {},
      })
    );
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
  });

  it('renders Send button when not streaming', () => {
    const { container } = render(
      h(AgentsComposer, {
        canSend: true,
        canInterrupt: true,
        isStreaming: false,
        isReadOnly: false,
        isLoading: false,
        onSend: () => {},
        onStop: () => {},
      })
    );
    expect(container.textContent).toContain('Send message');
  });

  it('renders Stop button when isStreaming is true', () => {
    const { container } = render(
      h(AgentsComposer, {
        canSend: false,
        canInterrupt: true,
        isStreaming: true,
        isReadOnly: false,
        isLoading: false,
        onSend: () => {},
        onStop: () => {},
      })
    );
    expect(container.textContent).toContain('Stop');
  });

  it('renders Stop button when isStreaming is true regardless of canSend', () => {
    const { container } = render(
      h(AgentsComposer, {
        canSend: true,
        canInterrupt: false,
        isStreaming: true,
        isReadOnly: false,
        isLoading: false,
        onSend: () => {},
        onStop: () => {},
      })
    );
    expect(container.textContent).toContain('Stop');
  });

  it('disables Send when canSend is false', () => {
    const { container } = render(
      h(AgentsComposer, {
        canSend: false,
        canInterrupt: false,
        isStreaming: false,
        isReadOnly: false,
        isLoading: false,
        onSend: () => {},
        onStop: () => {},
      })
    );
    const btn = container.querySelector('button');
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute('disabled')).not.toBeNull();
  });

  it('disables Stop when isStreaming is true and canInterrupt is false', () => {
    const { container } = render(
      h(AgentsComposer, {
        canSend: false,
        canInterrupt: false,
        isStreaming: true,
        isReadOnly: false,
        isLoading: false,
        onSend: () => {},
        onStop: () => {},
      })
    );
    const btn = [...container.querySelectorAll('button')].find(b => b.textContent === 'Stop');
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute('disabled')).not.toBeNull();
  });

  it('enables Stop when isStreaming is true and canInterrupt is true', () => {
    const { container } = render(
      h(AgentsComposer, {
        canSend: false,
        canInterrupt: true,
        isStreaming: true,
        isReadOnly: false,
        isLoading: false,
        onSend: () => {},
        onStop: () => {},
      })
    );
    const btn = [...container.querySelectorAll('button')].find(b => b.textContent === 'Stop');
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute('disabled')).toBeNull();
  });

  it('handles rejected onSend without unhandled rejection', async () => {
    // eslint-disable-next-line require-await -- async makes throw a promise rejection
    const rejectingSend = vi.fn(async () => {
      throw new Error('send failed');
    });

    const { container } = render(
      h(AgentsComposer, {
        canSend: true,
        canInterrupt: false,
        isStreaming: false,
        isReadOnly: false,
        isLoading: false,
        onSend: rejectingSend,
        onStop: () => {},
      })
    );

    const textarea = container.querySelector('textarea');
    expect(textarea).not.toBeNull();
    fireEvent.change(textarea!, { target: { value: 'hello' } });

    const sendBtn = [...container.querySelectorAll('button')].find(
      b => b.textContent === 'Send message'
    );
    expect(sendBtn).not.toBeNull();
    fireEvent.click(sendBtn!);

    // onSend was called with the trimmed text
    await vi.waitFor(() => {
      expect(rejectingSend).toHaveBeenCalledWith('hello');
    });

    // Composer clears the draft regardless of rejection
    expect(textarea!.value).toBe('');

    // Give microtasks time to flush — unhandled rejection would surface here
    await vi.waitFor(() => {
      // No unhandled rejection — test completes without Vitest error
      // eslint-disable-next-line vitest/prefer-called-once
      expect(rejectingSend).toHaveBeenCalledTimes(1);
    });
  });
});

// ---- AgentsBlockingCards rendering ----

const asyncNoop = async () => {};

describe('agents blocking cards rendering', () => {
  it('renders nothing when no active question or permission', () => {
    const { container } = render(
      h(AgentsBlockingCards, {
        activePermission: null,
        activeQuestion: null,
        onAnswerQuestion: asyncNoop,
        onRejectQuestion: asyncNoop,
        onRespondToPermission: asyncNoop,
      })
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders permission card with Once/Always/Reject buttons', () => {
    const permission: StandalonePermission = {
      requestId: 'perm-1',
      permission: 'read_file permission',
      patterns: ['src/**/*.ts'],
      metadata: {},
      always: ['src/**/*.ts'],
    };

    const { container } = render(
      h(AgentsBlockingCards, {
        activePermission: permission,
        activeQuestion: null,
        onAnswerQuestion: asyncNoop,
        onRejectQuestion: asyncNoop,
        onRespondToPermission: asyncNoop,
      })
    );

    expect(container.textContent).toContain('Permission required');
    expect(container.textContent).toContain('read_file permission');
    expect(container.textContent).toContain('src/**/*.ts');
    expect(container.textContent).toContain('Yes, once');
    expect(container.textContent).toContain('Yes, always');
    expect(container.textContent).toContain('No');
  });

  it('renders question card with option buttons', () => {
    const question: StandaloneQuestion = {
      requestId: 'q-1',
      questions: [
        {
          question: 'Which file?',
          header: 'File selection',
          options: [
            { label: 'file-a.ts', description: 'First option' },
            { label: 'file-b.ts', description: 'Second option' },
          ],
        },
      ],
    };

    const { container } = render(
      h(AgentsBlockingCards, {
        activePermission: null,
        activeQuestion: question,
        onAnswerQuestion: asyncNoop,
        onRejectQuestion: asyncNoop,
        onRespondToPermission: asyncNoop,
      })
    );

    expect(container.textContent).toContain('File selection');
    expect(container.textContent).toContain('file-a.ts');
    expect(container.textContent).toContain('file-b.ts');
    expect(container.textContent).toContain('Answer');
    expect(container.textContent).toContain('Dismiss');
  });
});

// ---- PermissionCard error handling (Fix 4) ----

describe('permission card error handling', () => {
  it('shows error and re-enables buttons after a failed respondToPermission', async () => {
    // eslint-disable-next-line require-await -- async makes throw a promise rejection
    const failingRespond = vi.fn(async () => {
      throw new Error('boom');
    });

    const permission: StandalonePermission = {
      requestId: 'perm-err',
      permission: 'write_file permission',
      patterns: ['/etc/hosts'],
      metadata: {},
      always: [],
    };

    const { container } = render(
      h(AgentsBlockingCards, {
        activePermission: permission,
        activeQuestion: null,
        onAnswerQuestion: async () => {},
        onRejectQuestion: async () => {},
        onRespondToPermission: failingRespond,
      })
    );

    const onceBtn = [...container.querySelectorAll('button')].find(b =>
      b.textContent?.includes('Yes, once')
    );
    expect(onceBtn).not.toBeNull();

    fireEvent.click(onceBtn!);

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Failed to respond');
    });

    const buttons = container.querySelectorAll('button');
    buttons.forEach(b => {
      expect(b.getAttribute('disabled')).toBeNull();
    });
  });
});

// ---- QuestionCard error handling (Fix 4) ----

describe('question card error handling', () => {
  it('shows error and re-enables after a failed answerQuestion', async () => {
    // eslint-disable-next-line require-await -- async makes throw a promise rejection
    const failingAnswer = vi.fn(async () => {
      throw new Error('boom');
    });

    const question: StandaloneQuestion = {
      requestId: 'q-err',
      questions: [
        {
          question: 'Which file?',
          header: 'File',
          options: [{ label: 'a.ts', description: '' }],
        },
      ],
    };

    const { container } = render(
      h(AgentsBlockingCards, {
        activePermission: null,
        activeQuestion: question,
        onAnswerQuestion: failingAnswer,
        onRejectQuestion: async () => {},
        onRespondToPermission: async () => {},
      })
    );

    const optionBtn = [...container.querySelectorAll('button')].find(b =>
      b.textContent?.includes('a.ts')
    );
    expect(optionBtn).not.toBeNull();
    fireEvent.click(optionBtn!);

    const answerBtn = [...container.querySelectorAll('button')].find(
      b => b.textContent?.trim() === 'Answer'
    );
    expect(answerBtn).not.toBeNull();
    fireEvent.click(answerBtn!);

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Failed to submit answer');
    });

    const buttons = container.querySelectorAll('button');
    buttons.forEach(b => {
      expect(b.getAttribute('disabled')).toBeNull();
    });
  });

  it('shows error and re-enables after a failed rejectQuestion', async () => {
    // eslint-disable-next-line require-await -- async makes throw a promise rejection
    const failingReject = vi.fn(async () => {
      throw new Error('boom');
    });

    const question: StandaloneQuestion = {
      requestId: 'q-dismiss-err',
      questions: [
        {
          question: 'Proceed?',
          header: 'Confirm',
          options: [{ label: 'yes', description: '' }],
        },
      ],
    };

    const { container } = render(
      h(AgentsBlockingCards, {
        activePermission: null,
        activeQuestion: question,
        onAnswerQuestion: async () => {},
        onRejectQuestion: failingReject,
        onRespondToPermission: async () => {},
      })
    );

    const dismissBtn = [...container.querySelectorAll('button')].find(b =>
      b.textContent?.includes('Dismiss')
    );
    expect(dismissBtn).not.toBeNull();
    fireEvent.click(dismissBtn!);

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Failed to dismiss');
    });

    const dismissBtnAfter = [...container.querySelectorAll('button')].find(b =>
      b.textContent?.includes('Dismiss')
    );
    expect(dismissBtnAfter?.getAttribute('disabled')).toBeNull();
  });
});

// ---- AgentsSessionView integration tests ----

const atomMap = new Map<object, string>();

function createAtom(label: string) {
  const a = {};
  atomMap.set(a, label);
  return a;
}

const mockAtoms = {
  messagesList: createAtom('messagesList'),
  isLoading: createAtom('isLoading'),
  isReadOnly: createAtom('isReadOnly'),
  canSend: createAtom('canSend'),
  canInterrupt: createAtom('canInterrupt'),
  isStreaming: createAtom('isStreaming'),
  statusIndicator: createAtom('statusIndicator'),
  error: createAtom('error'),
  failedPrompt: createAtom('failedPrompt'),
  activeQuestion: createAtom('activeQuestion'),
  activePermission: createAtom('activePermission'),
  fetchedSessionData: createAtom('fetchedSessionData'),
  sessionConfig: createAtom('sessionConfig'),
  hasOlderMessages: createAtom('hasOlderMessages'),
  isLoadingOlderMessages: createAtom('isLoadingOlderMessages'),
  olderMessagesError: createAtom('olderMessagesError'),
};

const mockManager = {
  atoms: mockAtoms,
  switchSession: vi.fn(),
  send: vi.fn(),
  interrupt: vi.fn(),
  clearError: vi.fn(),
  answerQuestion: vi.fn(),
  rejectQuestion: vi.fn(),
  respondToPermission: vi.fn(),
  loadOlderMessages: vi.fn(),
  destroy: vi.fn(),
};

let storedAtomValues: Record<string, unknown> = {};
let storedOrganizationId: string | null = null;

const mockGetKiloApiBaseUrl = vi.fn(() => 'https://app.kilocode.com');

// eslint-disable-next-line jest/no-untyped-mock-factory, vitest/prefer-import-in-mock -- mock type inference is sufficient; dynamic import changes factory signature
vi.mock('@/src/shared/auth', () => ({
  getKiloApiBaseUrl: () => mockGetKiloApiBaseUrl(),
}));

// eslint-disable-next-line jest/no-untyped-mock-factory, vitest/prefer-import-in-mock -- mock type inference is sufficient; dynamic import changes factory signature
vi.mock('./agents-provider', () => ({
  useExtensionAgents: () => ({ manager: mockManager, organizationId: storedOrganizationId }),
}));

// eslint-disable-next-line jest/no-untyped-mock-factory, vitest/prefer-import-in-mock -- mock type inference is sufficient; dynamic import changes factory signature
vi.mock('jotai', async () => {
  const actual = await vi.importActual('jotai');
  return {
    ...(actual as object),
    useAtomValue: (atom: object) => {
      const label = atomMap.get(atom);
      if (label !== undefined && label in storedAtomValues) {
        return storedAtomValues[label];
      }
      return null;
    },
  };
});

describe('agents session view integration', () => {
  // eslint-disable-next-line jest/no-hooks -- beforeEach is standard for test setup
  beforeEach(() => {
    vi.clearAllMocks();
    storedOrganizationId = null;
    storedAtomValues = {
      messagesList: [],
      isLoading: false,
      isReadOnly: false,
      canSend: false,
      canInterrupt: false,
      isStreaming: false,
      statusIndicator: null,
      error: null,
      failedPrompt: null,
      activeQuestion: null,
      activePermission: null,
      sessionConfig: null,
      hasOlderMessages: false,
      isLoadingOlderMessages: false,
      olderMessagesError: null,
    };
    /* eslint-disable unicorn/no-useless-undefined -- void-returning mock placValue */
    mockManager.switchSession.mockResolvedValue(undefined);
    mockManager.send.mockResolvedValue(true);
    mockManager.answerQuestion.mockResolvedValue(undefined);
    mockManager.rejectQuestion.mockResolvedValue(undefined);
    mockManager.respondToPermission.mockResolvedValue(undefined);
    /* eslint-enable unicorn/no-useless-undefined */
  });

  async function renderView() {
    const { AgentsSessionView } = await import('./agents-session-view');
    return render(h(AgentsSessionView, { kiloSessionId: 'ses-test-1', onBack: () => {} }));
  }

  // ---- Status indicator error Retry ----

  it('shows Retry button when status indicator type is error', async () => {
    storedAtomValues['statusIndicator'] = {
      type: 'error',
      message: 'Failed to load session',
      timestamp: Date.now(),
    };
    storedAtomValues['isStreaming'] = false;

    const { container } = await renderView();
    expect(container.textContent).toContain('Failed to load session');
    expect(container.textContent).toContain('Retry');
    expect(container.textContent).toContain('Dismiss');
  });

  // ---- Credits error ----

  it('shows Add credits link when error contains credits message', async () => {
    storedAtomValues['error'] =
      'Insufficient credits. Please add at least $1 to continue using Cloud Agent.';
    storedAtomValues['isStreaming'] = false;

    const { container } = await renderView();
    expect(container.textContent).toContain('Insufficient credits');
    expect(container.textContent).toContain('Add credits');
    expect([...container.querySelectorAll('button')].every(b => b.textContent !== 'Retry')).toBe(
      true
    );
  });

  // ---- Non-credits error shows Retry ----

  it('shows Retry button for non-credits errors', async () => {
    storedAtomValues['error'] = 'Connection lost. Please retry in a moment.';
    storedAtomValues['isStreaming'] = false;

    const { container } = await renderView();
    expect(container.textContent).toContain('Connection lost');
    const retryBtn = [...container.querySelectorAll('button')].find(b => b.textContent === 'Retry');
    expect(retryBtn).not.toBeNull();
  });

  // ---- Status indicator credits: no Retry (non-retryable) ----

  it('shows no Retry button when status indicator is a credits error', async () => {
    storedAtomValues['statusIndicator'] = {
      type: 'error',
      message: 'Insufficient credits. Add at least $1.',
      timestamp: Date.now(),
    };
    storedAtomValues['isStreaming'] = false;

    const { container } = await renderView();
    expect(container.textContent).toContain('Insufficient credits');
    expect([...container.querySelectorAll('button')].every(b => b.textContent !== 'Retry')).toBe(
      true
    );
  });

  // ---- Credits URL uses getKiloApiBaseUrl() ----

  it('uses getKiloApiBaseUrl() for credits link', async () => {
    mockGetKiloApiBaseUrl.mockReturnValue('https://custom.api.example.com');
    storedAtomValues['error'] = 'Insufficient credits. Please add at least $1 to continue.';

    const { container } = await renderView();
    const link = container.querySelector('a');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toContain('https://custom.api.example.com/credits');
  });

  // ---- Failed prompt Retry ----

  it('shows Retrying… state on failed prompt while send is pending', async () => {
    // eslint-disable-next-line init-declarations -- resolved inside Promise constructor
    let resolveSend!: (value: boolean | PromiseLike<boolean>) => void;
    // eslint-disable-next-line promise/avoid-new -- Promise is the standard pattern for delayed resolution in tests
    const sendPromise = new Promise<boolean>(resolve => {
      resolveSend = resolve;
    });
    mockManager.send.mockReturnValue(sendPromise);

    storedAtomValues['failedPrompt'] = 'hello world';
    storedAtomValues['isStreaming'] = false;
    storedAtomValues['sessionConfig'] = { mode: 'code', model: 'gpt-4' };

    const { container } = await renderView();
    expect(container.textContent).toContain('Message failed to send');

    const retryBtn = [...container.querySelectorAll('button')].find(b => b.textContent === 'Retry');
    expect(retryBtn).not.toBeNull();
    fireEvent.click(retryBtn!);

    await vi.waitFor(() => {
      const updated = container.querySelector('button[disabled]');
      expect(updated?.textContent).toBe('Retrying…');
    });

    resolveSend(true);
    await sendPromise;
  });

  // ---- Failed prompt retry: true hides row ----

  it('hides failed prompt row when retry succeeds (send returns true)', async () => {
    mockManager.send.mockResolvedValue(true);

    storedAtomValues['failedPrompt'] = 'hello world';
    storedAtomValues['isStreaming'] = false;
    storedAtomValues['sessionConfig'] = { mode: 'code', model: 'gpt-4' };

    const { container } = await renderView();
    expect(container.textContent).toContain('Message failed to send');

    const retryBtn = [...container.querySelectorAll('button')].find(b => b.textContent === 'Retry');
    fireEvent.click(retryBtn!);

    await vi.waitFor(() => {
      // Row should be hidden after successful retry
      expect(container.textContent).not.toContain('Message failed to send');
    });

    expect(mockManager.clearError).toHaveBeenCalledWith();
  });

  // ---- Failed prompt retry: false keeps row ----

  it('keeps failed prompt row when retry fails (send returns false)', async () => {
    mockManager.send.mockResolvedValue(false);

    storedAtomValues['failedPrompt'] = 'hello world';
    storedAtomValues['isStreaming'] = false;
    storedAtomValues['sessionConfig'] = { mode: 'code', model: 'gpt-4' };

    const { container } = await renderView();
    expect(container.textContent).toContain('Message failed to send');

    const retryBtn = [...container.querySelectorAll('button')].find(b => b.textContent === 'Retry');
    fireEvent.click(retryBtn!);

    // Row should remain visible and button should be re-enabled after failed retry.
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Message failed to send');
      const retryBtnAfter = [...container.querySelectorAll('button')].find(
        b => b.textContent === 'Retry'
      );
      expect(retryBtnAfter).not.toBeNull();
      expect(retryBtnAfter!.getAttribute('disabled')).toBeNull();
    });
  });

  // ---- Error retry: disabled state (same as switch retry) ----

  it('shows Retrying… on error atom Retry while switchSession is pending', async () => {
    // eslint-disable-next-line init-declarations -- resolved inside Promise constructor
    let resolveSwitch!: (value: void | PromiseLike<void>) => void;
    // eslint-disable-next-line promise/avoid-new -- Promise is the standard pattern for delayed resolution in tests
    const switchPromise = new Promise<void>(resolve => {
      resolveSwitch = resolve;
    });
    mockManager.switchSession.mockReturnValue(switchPromise);

    storedAtomValues['error'] = 'Connection lost.';
    storedAtomValues['isStreaming'] = false;

    const { container } = await renderView();
    const retryBtn = [...container.querySelectorAll('button')].find(b => b.textContent === 'Retry');
    expect(retryBtn).not.toBeNull();
    fireEvent.click(retryBtn!);

    await vi.waitFor(() => {
      const updated = container.querySelector('button[disabled]');
      expect(updated?.textContent).toBe('Retrying…');
    });

    resolveSwitch();
    await switchPromise;
  });

  // ---- Blocking card errors: inline via card components, no double error ----

  it('shows blocking card error inline when answerQuestion fails', async () => {
    mockManager.answerQuestion.mockRejectedValue(new Error('boom'));

    storedAtomValues['activeQuestion'] = {
      requestId: 'q-v',
      questions: [
        {
          question: 'Which file?',
          header: 'File',
          options: [{ label: 'a.ts', description: '' }],
        },
      ],
    };

    const { container } = await renderView();
    expect(container.textContent).toContain('File');

    // Select the option first so Answer is enabled
    const optionBtn = [...container.querySelectorAll('button')].find(b =>
      b.textContent?.includes('a.ts')
    );
    expect(optionBtn).not.toBeNull();
    fireEvent.click(optionBtn!);

    // Click Answer
    const answerBtn = [...container.querySelectorAll('button')].find(
      b => b.textContent?.trim() === 'Answer'
    );
    expect(answerBtn).not.toBeNull();
    fireEvent.click(answerBtn!);

    // Card component catches the error and shows its own inline message
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Failed to submit answer');
    });

    // Buttons should be re-enabled (card component re-enables after error)
    const answerBtnAfter = [...container.querySelectorAll('button')].find(
      b => b.textContent?.trim() === 'Answer'
    );
    expect(answerBtnAfter?.getAttribute('disabled')).toBeNull();
  });

  it('shows blocking card error inline when rejectQuestion fails', async () => {
    mockManager.rejectQuestion.mockRejectedValue(new Error('boom'));

    storedAtomValues['activeQuestion'] = {
      requestId: 'q-v',
      questions: [
        {
          question: 'Proceed?',
          header: 'Confirm',
          options: [{ label: 'yes', description: '' }],
        },
      ],
    };

    const { container } = await renderView();
    const dismissBtn = [...container.querySelectorAll('button')].find(b =>
      b.textContent?.includes('Dismiss')
    );
    expect(dismissBtn).not.toBeNull();
    fireEvent.click(dismissBtn!);

    // Card component catches error and shows inline message
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Failed to dismiss');
    });
  });

  it('shows blocking card error inline when respondToPermission fails', async () => {
    mockManager.respondToPermission.mockRejectedValue(new Error('boom'));

    storedAtomValues['activePermission'] = {
      requestId: 'perm-v',
      permission: 'read_file permission',
      patterns: ['src/**/*.ts'],
      metadata: {},
      always: [],
    };

    const { container } = await renderView();
    const onceBtn = [...container.querySelectorAll('button')].find(b =>
      b.textContent?.includes('Yes, once')
    );
    expect(onceBtn).not.toBeNull();
    fireEvent.click(onceBtn!);

    // Card component catches error and shows inline message
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Failed to respond');
    });
  });

  // ---- Fix 1: Status error retry hidden when failedPrompt exists ----

  it('hides status error Retry when failedPrompt is set (keeps Dismiss)', async () => {
    storedAtomValues['statusIndicator'] = {
      type: 'error',
      message: 'Connection lost. Please retry.',
      timestamp: Date.now(),
    };
    storedAtomValues['failedPrompt'] = 'hello world';
    storedAtomValues['isStreaming'] = false;

    const { container } = await renderView();

    // Dismiss is still present
    expect(container.textContent).toContain('Dismiss');
    // Retry from the status indicator must NOT be present
    const retryBtns = [...container.querySelectorAll('button')].filter(
      b => b.textContent === 'Retry'
    );
    // The only Retry button should be the failed-prompt one
    expect(retryBtns).toHaveLength(1);
    // Verify it's the failed-prompt retry (not the status retry)
    expect(container.textContent).toContain('Message failed to send');
  });

  it('shows Retry in status error when failedPrompt is null', async () => {
    storedAtomValues['statusIndicator'] = {
      type: 'error',
      message: 'Connection lost. Please retry.',
      timestamp: Date.now(),
    };
    storedAtomValues['failedPrompt'] = null;
    storedAtomValues['isStreaming'] = false;

    const { container } = await renderView();

    expect(container.textContent).toContain('Dismiss');
    expect(container.textContent).toContain('Retry');
  });

  // ---- Fix 2: variant included in prompt payload ----

  it('includes sessionConfig.variant in send payload when present', async () => {
    storedAtomValues['sessionConfig'] = { mode: 'code', model: 'gpt-4', variant: 'high' };
    storedAtomValues['canSend'] = true;
    storedAtomValues['isStreaming'] = false;

    const { container } = await renderView();

    // Type text and send
    const textarea = container.querySelector('textarea');
    expect(textarea).not.toBeNull();
    fireEvent.change(textarea!, { target: { value: 'hello' } });

    const sendBtn = [...container.querySelectorAll('button')].find(
      b => b.textContent === 'Send message'
    );
    expect(sendBtn).not.toBeNull();
    fireEvent.click(sendBtn!);

    expect(mockManager.send).toHaveBeenCalledWith({
      payload: { type: 'prompt', prompt: 'hello', mode: 'code', model: 'gpt-4', variant: 'high' },
    });
  });

  it('omits variant from send payload when sessionConfig.variant is absent', async () => {
    storedAtomValues['sessionConfig'] = { mode: 'code', model: 'gpt-4' };
    storedAtomValues['canSend'] = true;
    storedAtomValues['isStreaming'] = false;

    const { container } = await renderView();

    const textarea = container.querySelector('textarea');
    fireEvent.change(textarea!, { target: { value: 'hello' } });

    const sendBtn = [...container.querySelectorAll('button')].find(
      b => b.textContent === 'Send message'
    );
    fireEvent.click(sendBtn!);

    expect(mockManager.send.mock.calls.length).toBeGreaterThan(0);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- test validates shape via assertions
    const payload = mockManager.send.mock.calls[0]?.[0]?.payload;
    expect(payload).toBeDefined();
    expect(payload).not.toHaveProperty('variant');
  });

  it('includes sessionConfig.variant in failed-prompt retry payload when present', async () => {
    storedAtomValues['sessionConfig'] = { mode: 'code', model: 'gpt-4', variant: 'high' };
    storedAtomValues['failedPrompt'] = 'hello world';
    storedAtomValues['isStreaming'] = false;

    const { container } = await renderView();

    const retryBtn = [...container.querySelectorAll('button')].find(b => b.textContent === 'Retry');
    fireEvent.click(retryBtn!);

    expect(mockManager.send).toHaveBeenCalledWith({
      payload: {
        type: 'prompt',
        prompt: 'hello world',
        mode: 'code',
        model: 'gpt-4',
        variant: 'high',
      },
    });
  });

  // ---- Fix 3: Stale failed-prompt banner hidden after successful composer send ----

  it('hides failed-prompt banner after a new composer send', async () => {
    storedAtomValues['failedPrompt'] = 'old failed message';
    storedAtomValues['sessionConfig'] = { mode: 'code', model: 'gpt-4' };
    storedAtomValues['canSend'] = true;
    storedAtomValues['isStreaming'] = false;

    const { container } = await renderView();

    // Banner is visible initially
    expect(container.textContent).toContain('Message failed to send');

    // Type text and send
    const textarea = container.querySelector('textarea');
    fireEvent.change(textarea!, { target: { value: 'new message' } });

    const sendBtn = [...container.querySelectorAll('button')].find(
      b => b.textContent === 'Send message'
    );
    fireEvent.click(sendBtn!);

    // Banner should be hidden after send
    await vi.waitFor(() => {
      expect(container.textContent).not.toContain('Message failed to send');
    });
  });

  it('keeps failed-prompt banner when composer send returns false', async () => {
    mockManager.send.mockResolvedValue(false);

    storedAtomValues['failedPrompt'] = 'old failed message';
    storedAtomValues['sessionConfig'] = { mode: 'code', model: 'gpt-4' };
    storedAtomValues['canSend'] = true;
    storedAtomValues['isStreaming'] = false;

    const { container } = await renderView();

    // Banner is visible initially
    expect(container.textContent).toContain('Message failed to send');

    // Type text and send
    const textarea = container.querySelector('textarea');
    fireEvent.change(textarea!, { target: { value: 'new message' } });

    const sendBtn = [...container.querySelectorAll('button')].find(
      b => b.textContent === 'Send message'
    );
    fireEvent.click(sendBtn!);

    // Banner should remain visible since send returned false
    await vi.waitFor(() => {
      // eslint-disable-next-line jest/prefer-called-with -- checking call count not args
      expect(mockManager.send).toHaveBeenCalled();
    });

    // Force a re-render to confirm banner persists
    const { container: container2 } = await renderView();
    expect(container2.textContent).toContain('Message failed to send');
  });

  it('keeps failed-prompt banner when composer send rejects', async () => {
    mockManager.send.mockRejectedValue(new Error('send failed'));

    storedAtomValues['failedPrompt'] = 'old failed message';
    storedAtomValues['sessionConfig'] = { mode: 'code', model: 'gpt-4' };
    storedAtomValues['canSend'] = true;
    storedAtomValues['isStreaming'] = false;

    const { container } = await renderView();

    // Banner is visible initially
    expect(container.textContent).toContain('Message failed to send');

    // Type text and send
    const textarea = container.querySelector('textarea');
    fireEvent.change(textarea!, { target: { value: 'new message' } });

    const sendBtn = [...container.querySelectorAll('button')].find(
      b => b.textContent === 'Send message'
    );
    fireEvent.click(sendBtn!);

    // Banner should remain visible since send rejected
    await vi.waitFor(() => {
      // eslint-disable-next-line jest/prefer-called-with -- checking call count not args
      expect(mockManager.send).toHaveBeenCalled();
    });

    const { container: container2 } = await renderView();
    expect(container2.textContent).toContain('Message failed to send');
  });

  it('reshows failed-prompt banner when a different failed prompt arrives after send', async () => {
    storedAtomValues['failedPrompt'] = 'old failed message';
    storedAtomValues['sessionConfig'] = { mode: 'code', model: 'gpt-4' };
    storedAtomValues['canSend'] = true;
    storedAtomValues['isStreaming'] = false;

    const { container } = await renderView();
    expect(container.textContent).toContain('Message failed to send');

    // Send a new message — banner hides
    const textarea = container.querySelector('textarea');
    fireEvent.change(textarea!, { target: { value: 'new message' } });
    const sendBtn = [...container.querySelectorAll('button')].find(
      b => b.textContent === 'Send message'
    );
    fireEvent.click(sendBtn!);

    await vi.waitFor(() => {
      expect(container.textContent).not.toContain('Message failed to send');
    });

    // A new failed prompt arrives — banner should reappear
    storedAtomValues['failedPrompt'] = 'another failure';
    const { container: container2 } = await renderView();
    expect(container2.textContent).toContain('Message failed to send');
  });

  // ---- Fix 4: org-aware credits URL in status indicator ----

  it('includes organizationId in status indicator credits link as org route', async () => {
    storedOrganizationId = 'org-test-123';

    storedAtomValues['statusIndicator'] = {
      type: 'error',
      message: 'Insufficient credits. Please add at least $1.',
      timestamp: Date.now(),
    };
    storedAtomValues['isStreaming'] = false;

    const { container } = await renderView();
    const link = container.querySelector('a');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toContain('/organizations/org-test-123');
  });

  it('uses /credits route in status indicator link when no org', async () => {
    storedOrganizationId = null;

    storedAtomValues['statusIndicator'] = {
      type: 'error',
      message: 'Insufficient credits. Please add at least $1.',
      timestamp: Date.now(),
    };
    storedAtomValues['isStreaming'] = false;

    const { container } = await renderView();
    const link = container.querySelector('a');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toContain('/credits');
    expect(link!.getAttribute('href')).not.toContain('/organizations/');
  });

  it('includes organizationId in error row credits link as org route', async () => {
    storedOrganizationId = 'org-test-123';
    storedAtomValues['error'] =
      'Insufficient credits. Please add at least $1 to continue using Cloud Agent.';

    const { container } = await renderView();
    const link = container.querySelector('a');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toContain('/organizations/org-test-123');
  });

  it('uses /credits route in error row credits link when no org', async () => {
    storedOrganizationId = null;
    storedAtomValues['error'] =
      'Insufficient credits. Please add at least $1 to continue using Cloud Agent.';

    const { container } = await renderView();
    const link = container.querySelector('a');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toContain('/credits');
    expect(link!.getAttribute('href')).not.toContain('/organizations/');
  });

  // ---- Fix 5: same-text re-fail after retry succeeded ----

  it('reshows failed-prompt banner when composer re-sends same text that then fails', async () => {
    // Step 1: retry succeeds, hiding the banner
    mockManager.send.mockResolvedValue(true);
    storedAtomValues['failedPrompt'] = 'hello world';
    storedAtomValues['isStreaming'] = false;
    storedAtomValues['sessionConfig'] = { mode: 'code', model: 'gpt-4' };
    storedAtomValues['canSend'] = true;

    const { container } = await renderView();
    expect(container.textContent).toContain('Message failed to send');

    // Click retry — succeeds, row hides
    const retryBtn = [...container.querySelectorAll('button')].find(b => b.textContent === 'Retry');
    fireEvent.click(retryBtn!);
    await vi.waitFor(() => {
      expect(container.textContent).not.toContain('Message failed to send');
    });

    // Step 2: now make send return false
    mockManager.send.mockResolvedValue(false);

    // Step 3: type same text in composer and send
    const textarea = container.querySelector('textarea');
    fireEvent.change(textarea!, { target: { value: 'hello world' } });
    const sendBtn = [...container.querySelectorAll('button')].find(
      b => b.textContent === 'Send message'
    );
    fireEvent.click(sendBtn!);

    // Row should reappear — retrySucceeded was reset before send, and send returned false
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Message failed to send');
    });
  });

  // ---- Repair r6: retrySucceeded guards ----

  it('re-exposes status indicator Retry after failed-prompt retry succeeds', async () => {
    mockManager.send.mockResolvedValue(true);
    storedAtomValues['statusIndicator'] = {
      type: 'error',
      message: 'Connection lost. Please retry.',
      timestamp: Date.now(),
    };
    storedAtomValues['failedPrompt'] = 'hello world';
    storedAtomValues['isStreaming'] = false;
    storedAtomValues['sessionConfig'] = { mode: 'code', model: 'gpt-4' };

    const { container } = await renderView();

    // Both rows visible: status indicator and failed-prompt banner
    expect(container.textContent).toContain('Connection lost');
    expect(container.textContent).toContain('Message failed to send');

    // Status Retry is suppressed while failed-prompt row is visible
    let retryBtns = [...container.querySelectorAll('button')].filter(
      b => b.textContent === 'Retry'
    );
    // only the failed-prompt Retry
    expect(retryBtns).toHaveLength(1);

    // Click failed-prompt Retry — succeeds, row hides
    fireEvent.click(retryBtns[0]!);
    await vi.waitFor(() => {
      expect(container.textContent).not.toContain('Message failed to send');
    });

    // Now status indicator Retry should reappear (retrySucceeded is true)
    retryBtns = [...container.querySelectorAll('button')].filter(b => b.textContent === 'Retry');
    expect(retryBtns).toHaveLength(1);
    expect(container.textContent).toContain('Dismiss');
  });

  it('suppresses error atom Retry while failed-prompt recovery is active', async () => {
    storedAtomValues['error'] = 'Connection lost. Please retry in a moment.';
    storedAtomValues['failedPrompt'] = 'hello world';
    storedAtomValues['isStreaming'] = false;

    const { container } = await renderView();

    // Both rows visible
    expect(container.textContent).toContain('Connection lost');
    expect(container.textContent).toContain('Message failed to send');

    // Error atom Retry must not appear — only the failed-prompt Retry should be present
    const retryBtns = [...container.querySelectorAll('button')].filter(
      b => b.textContent === 'Retry'
    );
    expect(retryBtns).toHaveLength(1);
    expect(container.textContent).toContain('Message failed to send');
  });

  it('re-exposes error atom Retry after failed-prompt retry succeeds', async () => {
    mockManager.send.mockResolvedValue(true);
    storedAtomValues['error'] = 'Connection lost. Please retry in a moment.';
    storedAtomValues['failedPrompt'] = 'hello world';
    storedAtomValues['isStreaming'] = false;
    storedAtomValues['sessionConfig'] = { mode: 'code', model: 'gpt-4' };

    const { container } = await renderView();

    // Error Retry is suppressed while failed-prompt recovery row is visible
    let retryBtns = [...container.querySelectorAll('button')].filter(
      b => b.textContent === 'Retry'
    );
    // only the failed-prompt Retry
    expect(retryBtns).toHaveLength(1);

    // Click failed-prompt Retry — succeeds, row hides
    fireEvent.click(retryBtns[0]!);
    await vi.waitFor(() => {
      expect(container.textContent).not.toContain('Message failed to send');
    });

    // Now error atom Retry should reappear (retrySucceeded is true)
    retryBtns = [...container.querySelectorAll('button')].filter(b => b.textContent === 'Retry');
    expect(retryBtns).toHaveLength(1);
    expect(container.textContent).toContain('Connection lost');
  });

  it('keeps failed-prompt Retry visible even when error atom is also set', async () => {
    storedAtomValues['error'] = 'Connection lost. Please retry in a moment.';
    storedAtomValues['failedPrompt'] = 'hello world';
    storedAtomValues['isStreaming'] = false;

    const { container } = await renderView();

    // The failed-prompt retry row is still shown with its Retry button
    expect(container.textContent).toContain('Message failed to send');
    const retryBtns = [...container.querySelectorAll('button')].filter(
      b => b.textContent === 'Retry'
    );
    expect(retryBtns).toHaveLength(1);
  });

  // ---- Regression: empty mode defaults to 'code' ----

  it('defaults mode to code when sessionConfig.mode is empty string', async () => {
    storedAtomValues['sessionConfig'] = { mode: '', model: 'gpt-4' };
    storedAtomValues['canSend'] = true;
    storedAtomValues['isStreaming'] = false;

    const { container } = await renderView();

    const textarea = container.querySelector('textarea');
    fireEvent.change(textarea!, { target: { value: 'hello' } });

    const sendBtn = [...container.querySelectorAll('button')].find(
      b => b.textContent === 'Send message'
    );
    fireEvent.click(sendBtn!);

    expect(mockManager.send).toHaveBeenCalledWith({
      payload: { type: 'prompt', prompt: 'hello', mode: 'code', model: 'gpt-4' },
    });
  });

  it('defaults mode to code on failed-prompt retry when sessionConfig.mode is empty string', async () => {
    storedAtomValues['sessionConfig'] = { mode: '', model: 'gpt-4' };
    storedAtomValues['failedPrompt'] = 'hello world';
    storedAtomValues['isStreaming'] = false;

    const { container } = await renderView();

    const retryBtn = [...container.querySelectorAll('button')].find(b => b.textContent === 'Retry');
    fireEvent.click(retryBtn!);

    expect(mockManager.send).toHaveBeenCalledWith({
      payload: {
        type: 'prompt',
        prompt: 'hello world',
        mode: 'code',
        model: 'gpt-4',
      },
    });
  });

  it('defaults title to Session when fetchedSessionData.title is empty string', async () => {
    storedAtomValues['fetchedSessionData'] = { title: '', gitUrl: null, gitBranch: null };

    const { container } = await renderView();
    const h1 = container.querySelector('h1');
    expect(h1).not.toBeNull();
    expect(h1!.textContent).toBe('Session');
  });

  // ---- Unmount destroys manager transport ----

  it('calls manager.destroy() on unmount', async () => {
    const { unmount } = await renderView();
    expect(mockManager.destroy).not.toHaveBeenCalled();

    unmount();
    // eslint-disable-next-line vitest/prefer-called-times -- current linter also requires CalledOnce.
    expect(mockManager.destroy).toHaveBeenCalledOnce();
  });
});
