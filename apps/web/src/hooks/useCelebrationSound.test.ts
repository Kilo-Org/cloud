import React, { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { useCelebrationSound } from './useCelebrationSound';

let mockEnabled = true;
jest.mock('@/hooks/useLocalStorage', () => ({
  useLocalStorage: () => [mockEnabled, jest.fn()],
}));

it('loads no audio on mount, creates it on first enabled play, and releases it on unmount', async () => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Audio: globalThis.Audio,
    React: (globalThis as { React?: typeof React }).React,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT,
  };
  const audio = {
    play: jest.fn(async () => {}),
    pause: jest.fn(),
    src: '',
    preload: '',
    currentTime: 0,
  };
  const Audio = jest.fn(() => audio);
  Object.assign(globalThis, {
    window,
    document: window.document,
    Audio,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = window.document.getElementById('root');
  if (!container) throw new Error('Missing test root');
  const root = createRoot(container);
  let sound: ReturnType<typeof useCelebrationSound> | undefined;
  function Harness() {
    sound = useCelebrationSound();
    return null;
  }
  try {
    mockEnabled = false;
    act(() => root.render(createElement(Harness)));
    expect(Audio).not.toHaveBeenCalled();
    act(() => sound?.play());
    expect(Audio).not.toHaveBeenCalled();
    mockEnabled = true;
    act(() => root.render(createElement(Harness)));
    await act(async () => {
      sound?.play();
      sound?.play();
    });
    expect(Audio).toHaveBeenCalledTimes(1);
    expect(Audio).toHaveBeenCalledWith('/sounds/celebration.wav');
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(audio.preload).toBe('none');
  } finally {
    act(() => root.unmount());
    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(audio.src).toBe('');
    Object.assign(globalThis, previous);
  }
});
