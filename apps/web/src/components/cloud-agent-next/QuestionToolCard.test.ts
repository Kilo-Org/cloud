import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { QuestionInfo } from '@/types/opencode.gen';
import type { QuestionToolCard as QuestionToolCardComponent } from './QuestionToolCard';
import type { QuestionContextProvider as QuestionContextProviderComponent } from './QuestionContext';

jest.mock('@/lib/trpc/utils', () => ({
  useRawTRPCClient: () => ({}),
}));

jest.mock('./ToolCardShell', () => ({
  ToolCardShell: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

type LinkedomParseHtml = (html: string) => {
  document: Document;
  window: typeof globalThis & {
    Event: typeof Event;
    HTMLElement: typeof HTMLElement;
  };
};

function installLinkedomDom(): {
  cleanup: () => void;
  container: HTMLElement;
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
    cleanup: () => {
      Object.assign(globalThis, previous);
    },
  };
}

type InputProps = {
  placeholder?: string;
  onChange?: (event: { target: { value: string } }) => void;
  onKeyDown?: (event: {
    key: string;
    shiftKey: boolean;
    preventDefault: () => void;
    nativeEvent: { isComposing: boolean };
  }) => void;
};

type Fiber = {
  type: unknown;
  memoizedProps?: InputProps;
  child?: Fiber | null;
  sibling?: Fiber | null;
};

function currentInputProps(container: HTMLElement): InputProps {
  const reactKey = Object.keys(container).find(key => key.startsWith('__reactContainer'));
  const host = reactKey
    ? (container as unknown as Record<string, { stateNode?: { current?: Fiber } }>)[reactKey]
    : undefined;
  let found: InputProps | undefined;
  const walk = (fiber: Fiber | null | undefined) => {
    if (!fiber || found) return;
    if (fiber.type === 'input' && fiber.memoizedProps?.placeholder === 'Type your own answer...') {
      found = fiber.memoizedProps;
      return;
    }
    walk(fiber.child);
    walk(fiber.sibling);
  };
  walk(host?.stateNode?.current);
  if (!found) throw new Error('custom answer input props not found');
  return found;
}

async function typeAnswer(container: HTMLElement, value: string) {
  await act(async () => {
    currentInputProps(container).onChange?.({ target: { value } });
  });
}

async function pressEnter(container: HTMLElement) {
  const preventDefault = jest.fn();
  await act(async () => {
    currentInputProps(container).onKeyDown?.({
      key: 'Enter',
      shiftKey: false,
      preventDefault,
      nativeEvent: { isComposing: false },
    });
  });
  return preventDefault;
}

const singleQuestion: QuestionInfo[] = [
  {
    question: 'Which approach?',
    header: 'Approach',
    options: [{ label: 'Option A', description: 'First' }],
  },
];

const multipleQuestions: QuestionInfo[] = [
  {
    question: 'Which approach?',
    header: 'Approach',
    options: [{ label: 'Option A', description: 'First' }],
  },
  {
    question: 'Which database?',
    header: 'Database',
    options: [{ label: 'Postgres', description: 'SQL' }],
  },
];

function createAnswerQuestionMock() {
  return jest.fn<(requestId: string, answers: string[][]) => Promise<void>>(async () => {});
}

let QuestionToolCard: typeof QuestionToolCardComponent;
let QuestionContextProvider: typeof QuestionContextProviderComponent;

beforeAll(async () => {
  ({ QuestionToolCard } = await import('./QuestionToolCard'));
  ({ QuestionContextProvider } = await import('./QuestionContext'));
});

describe('QuestionToolCard keyboard submission', () => {
  let domCleanup: (() => void) | undefined;
  let root: Root | undefined;

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = undefined;
    }
    domCleanup?.();
    domCleanup = undefined;
  });

  function renderCard(
    questions: QuestionInfo[],
    answerQuestion: (requestId: string, answers: string[][]) => Promise<void>
  ): HTMLElement {
    const dom = installLinkedomDom();
    domCleanup = dom.cleanup;
    root = createRoot(dom.container);
    act(() => {
      root?.render(
        createElement(
          QuestionContextProvider,
          {
            questionRequestIds: new Map(),
            cloudAgentSessionId: null,
            organizationId: null,
            answerQuestion,
            children: null,
          },
          createElement(QuestionToolCard, {
            questions,
            requestId: 'req_1',
            status: 'running',
          })
        )
      );
    });
    return dom.container;
  }

  it('submits a single typed answer on Enter', async () => {
    const answerQuestion = createAnswerQuestionMock();
    const container = renderCard(singleQuestion, answerQuestion);

    await typeAnswer(container, 'My own approach');
    expect(await pressEnter(container)).toHaveBeenCalled();

    expect(answerQuestion).toHaveBeenCalledWith('req_1', [['My own approach']]);
  });

  it('advances to the next question on Enter instead of submitting', async () => {
    const answerQuestion = createAnswerQuestionMock();
    const container = renderCard(multipleQuestions, answerQuestion);

    await typeAnswer(container, 'My own approach');
    await pressEnter(container);

    expect(answerQuestion).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Which database?');
  });

  it('submits all answers when Enter is pressed on the last question', async () => {
    const answerQuestion = createAnswerQuestionMock();
    const container = renderCard(multipleQuestions, answerQuestion);

    await typeAnswer(container, 'My own approach');
    await pressEnter(container);
    await typeAnswer(container, 'Postgres');
    await pressEnter(container);

    expect(answerQuestion).toHaveBeenCalledWith('req_1', [['My own approach'], ['Postgres']]);
  });

  it('does nothing on Enter when no answer has been given', async () => {
    const answerQuestion = createAnswerQuestionMock();
    const container = renderCard(singleQuestion, answerQuestion);

    await pressEnter(container);

    expect(answerQuestion).not.toHaveBeenCalled();
  });
});
