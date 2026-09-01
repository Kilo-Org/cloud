/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/components/ui/selectable-text.mounted.test.tsx) */
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import {
  buildProps,
  errorState,
  findByTestID,
  host,
  makeAssistantMessage,
  modal,
  reactNativeMock,
  readyState,
  renderSheet,
  retryButton,
  safeAreaMock,
  textValues,
  updateSheet,
} from './child-session-sheet-test-helpers';
import { QueryError } from '@/components/query-error';
import { i18n } from '@/i18n';
import { ChildSessionModelLabel } from './child-session-model-label';

describe('ChildSessionSheet title layout', () => {
  it.each([
    {
      state: 'loading',
      hydrationState: { status: 'loading' } as const,
      messages: [],
      sessionError: null,
      expectedText: i18n.t('agentChat.childSessionSheet.loading'),
      retryCount: 0,
    },
    {
      state: 'ready',
      hydrationState: readyState,
      messages: [makeAssistantMessage()],
      sessionError: null,
      expectedText: 'child text',
      retryCount: 0,
    },
    {
      state: 'empty',
      hydrationState: readyState,
      messages: [],
      sessionError: null,
      expectedText: i18n.t('agentChat.childSessionSheet.noMessages'),
      retryCount: 0,
    },
    {
      state: 'retryable error',
      hydrationState: errorState,
      messages: [],
      sessionError: null,
      expectedText: 'Failed',
      retryCount: 1,
    },
    {
      state: 'terminal error',
      hydrationState: readyState,
      messages: [],
      sessionError: 'Runtime failure',
      expectedText: 'Runtime failure',
      retryCount: 0,
    },
  ])('keeps the selected title wrapped during $state', async state => {
    const props = {
      ...buildProps({
        getChildMessages: () => state.messages,
        hydrationState: state.hydrationState,
      }),
      title: 'Inspect performance child 01',
      sessionError: state.sessionError,
    };
    const renderer = await renderSheet(props);
    const header = host(renderer.root, 'SheetHeader');

    expect(header.props).toMatchObject({ title: 'Inspect performance child 01', wrapTitle: true });
    expect(header.props.onDone).toBe(props.onClose);
    expect(textValues(renderer.root)).toContain(state.expectedText);
    expect(
      renderer.root.findAll(
        node => (node.type as string) === 'Pressable' && node.props.accessibilityLabel === 'Retry'
      )
    ).toHaveLength(state.retryCount);
  });
});

describe('ChildSessionSheet mounted', () => {
  it('keeps the wrapped title, live rows, and Retry through hydration recovery', async () => {
    const messages = [makeAssistantMessage()];
    const props = buildProps({
      getChildMessages: () => messages,
      hydrationState: { status: 'loading' },
    });
    const renderer = await renderSheet(props);
    const list = host(renderer.root, 'FlashList');
    const header = host(renderer.root, 'SheetHeader');

    await updateSheet(renderer, { ...props, hydrationState: errorState });

    expect(textValues(renderer.root)).toContain('child text');
    expect(renderer.root.findAllByType(QueryError)).toHaveLength(1);
    expect(textValues(renderer.root)).toContain('Failed');
    expect(retryButton(renderer.root).props.accessibilityState).toEqual({
      disabled: false,
      busy: false,
    });
    expect(host(renderer.root, 'FlashList')).toBe(list);

    await updateSheet(renderer, props);

    expect(host(renderer.root, 'SheetHeader')).toBe(header);
    expect(header.props).toMatchObject({ title: props.title, wrapTitle: true });
    expect(textValues(renderer.root)).toEqual(expect.arrayContaining(['child text', 'Failed']));
    expect(retryButton(renderer.root).props.accessibilityState).toEqual({
      disabled: true,
      busy: true,
    });
    expect(host(renderer.root, 'FlashList')).toBe(list);

    await updateSheet(renderer, { ...props, hydrationState: readyState });

    expect(host(renderer.root, 'SheetHeader')).toBe(header);
    expect(header.props).toMatchObject({ title: props.title, wrapTitle: true });
    expect(renderer.root.findAllByType(QueryError)).toHaveLength(0);
    expect(host(renderer.root, 'FlashList')).toBe(list);
  });
  it('renders the model row when child messages carry model data', async () => {
    const messages = [makeAssistantMessage()];
    const renderer = await renderSheet(
      buildProps({
        getChildMessages: () => messages,
        hydrationState: readyState,
      })
    );

    const labels = renderer.root.findAllByType(ChildSessionModelLabel);
    expect(labels).toHaveLength(1);
    expect(labels[0]?.props).toMatchObject({ modelLabel: 'Test Model' });

    const a11yNodes = renderer.root.findAll(
      node => node.props.accessibilityLabel === 'Model: Test Model'
    );
    expect(a11yNodes).toHaveLength(1);
  });

  it('renders no model row for an empty transcript', async () => {
    const renderer = await renderSheet(
      buildProps({
        getChildMessages: () => [],
        hydrationState: readyState,
      })
    );

    expect(renderer.root.findAllByType(ChildSessionModelLabel)).toHaveLength(0);
  });

  it('renders the QueryError and no model row when hydration fails', async () => {
    const renderer = await renderSheet(
      buildProps({
        getChildMessages: () => [],
        hydrationState: errorState,
      })
    );

    expect(renderer.root.findAllByType(ChildSessionModelLabel)).toHaveLength(0);
    const errors = renderer.root.findAllByType(QueryError);
    expect(errors).toHaveLength(1);
  });
});

describe('ChildSessionSheet sheet surface', () => {
  it('renders the native pageSheet Modal on iOS and preserves onDismiss', async () => {
    const onClose = vi.fn<() => void>();
    const onDismiss = vi.fn<() => void>();
    const renderer = await renderSheet({
      ...buildProps({ getChildMessages: () => [], hydrationState: readyState }),
      onClose,
      onDismiss,
    });

    const modalNode = modal(renderer.root);
    expect(modalNode.props.animationType).toBe('slide');
    expect(modalNode.props.presentationStyle).toBe('pageSheet');
    expect(modalNode.props.transparent).toBeUndefined();
    expect(modalNode.props.onRequestClose).toBe(onClose);
    expect(modalNode.props.onDismiss).toBe(onDismiss);

    expect(findByTestID(renderer.root, 'session-page-sheet-surface')).toHaveLength(0);
  });

  it('renders an opaque full-window Modal padded by the top inset on Android', async () => {
    reactNativeMock.Platform.OS = 'android';
    safeAreaMock.useSafeAreaInsets.mockReturnValue({ top: 24, bottom: 34, left: 0, right: 0 });

    const renderer = await renderSheet(
      buildProps({ getChildMessages: () => [], hydrationState: readyState })
    );

    const modalNode = modal(renderer.root);
    expect(modalNode.props.transparent).toBeUndefined();

    const surface = findByTestID(renderer.root, 'session-page-sheet-surface');
    expect(surface).toHaveLength(1);
    // flex-1 fills the window; the padding clears the system status bar.
    expect(surface[0]?.props.className).toContain('flex-1');
    expect(surface[0]?.props.style).toEqual({ paddingTop: 24 });
  });

  it('closes when Android Back fires onRequestClose', async () => {
    reactNativeMock.Platform.OS = 'android';
    const onClose = vi.fn<() => void>();
    const renderer = await renderSheet({
      ...buildProps({ getChildMessages: () => [], hydrationState: readyState }),
      onClose,
    });

    await act(async () => {
      await Promise.resolve();
      (modal(renderer.root).props.onRequestClose as () => void)();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes the loading child once when Done is pressed', async () => {
    const props = {
      ...buildProps({ getChildMessages: () => [], hydrationState: { status: 'loading' } }),
    };
    let closeCount = 0;
    props.onClose = () => {
      closeCount += 1;
      props.visible = false;
    };
    const renderer = await renderSheet(props);

    await act(async () => {
      (host(renderer.root, 'SheetHeader').props.onDone as () => void)();
      await Promise.resolve();
    });
    await updateSheet(renderer, props);

    expect(modal(renderer.root).props.visible).toBe(false);
    expect(closeCount).toBe(1);
  });
});
