import React, { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createRequire } from 'node:module';
import { useAuiState } from '@assistant-ui/react';
import { CloudChatRuntimeProvider } from './CloudChatRuntimeProvider';
import { fixtureAssistant, fixtureText } from './__fixtures__/transcript';
import type * as MessageProjection from './message-projection';
import type { CloudProjectionInput } from './presentation-types';

const mockProject = jest.fn();
jest.mock('./message-projection', () => {
  const actual = jest.requireActual<typeof MessageProjection>('./message-projection');
  return {
    ...actual,
    createCloudMessageProjector: () => {
      const project = actual.createCloudMessageProjector();
      return (input: CloudProjectionInput) => {
        mockProject(input);
        return project(input);
      };
    },
  };
});

function installDom() {
  const requireFromHere = createRequire(__filename);
  const requireFromNext = createRequire(requireFromHere.resolve('next/package.json'));
  const { window, document } = (
    requireFromNext('linkedom') as {
      parseHTML: (html: string) => { window: Record<string, unknown>; document: Document };
    }
  ).parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  const values = {
    React,
    window,
    document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    getComputedStyle: () => ({ animationName: 'none', display: 'block' }),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => undefined,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(values).map(name => [name, globals[name]]));
  Object.assign(globals, values);
  const container = document.getElementById('root');
  if (!container) throw new Error('ChildSessionSection test root missing');
  return {
    container,
    cleanup: () => previous.forEach((value, name) => (globals[name] = value)),
  };
}

function TranscriptProbe() {
  const messages = useAuiState(state => state.thread.messages);
  return createElement(
    'div',
    { id: 'transcript' },
    messages
      .map(message =>
        message.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('')
      )
      .join('')
  );
}

it('pauses hidden projection, keeps other children live, and catches up when activated', async () => {
  const dom = installDom();
  const root = createRoot(dom.container);
  const onNew = async () => {};
  const render = async (active: boolean, text: string, tab: string) => {
    await act(async () =>
      root.render(
        createElement(CloudChatRuntimeProvider, {
          active,
          projection: {
            messages: [fixtureAssistant('message', [fixtureText('part', text)])],
            isStreaming: true,
          },
          state: {
            isLoading: false,
            isRunning: true,
            isReadOnly: false,
            isSendDisabled: false,
            canInterrupt: true,
          },
          onNew,
          children: [
            createElement(TranscriptProbe, { key: 'transcript' }),
            createElement('span', { key: 'tab', id: 'tab' }, tab),
          ],
        })
      )
    );
  };
  try {
    await render(true, 'first', 'chat');
    expect(dom.container.querySelector('#transcript')?.textContent).toBe('first');
    mockProject.mockClear();
    await render(false, 'second', 'terminal');
    await render(false, 'latest', 'file');
    expect(mockProject).not.toHaveBeenCalled();
    expect(dom.container.querySelector('#transcript')?.textContent).toBe('first');
    expect(dom.container.querySelector('#tab')?.textContent).toBe('file');
    await render(true, 'latest', 'chat');
    expect(mockProject).toHaveBeenCalledTimes(1);
    expect(dom.container.querySelector('#transcript')?.textContent).toBe('latest');
  } finally {
    await act(async () => root.unmount());
    dom.cleanup();
  }
});
