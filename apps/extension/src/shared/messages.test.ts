import { describe, expect, it } from 'vitest';
import {
  createGetSidebarStateMessage,
  createSidebarStateMessage,
  createToggleSidebarMessage,
  isGetSidebarStateMessage,
  isSidebarStateMessage,
  isToggleSidebarMessage,
} from './messages';

describe('sidebar messages', () => {
  it('creates a toggle message with the stable extension protocol type', () => {
    expect.assertions(1);
    expect(createToggleSidebarMessage()).toStrictEqual({
      type: 'kilo.sidebar.toggle',
    });
  });

  it('creates a state request message with the stable extension protocol type', () => {
    expect.assertions(1);
    expect(createGetSidebarStateMessage()).toStrictEqual({
      type: 'kilo.sidebar.getState',
    });
  });

  it('creates a sidebar state response with an explicit boolean state', () => {
    expect.assertions(1);
    expect(createSidebarStateMessage(true)).toStrictEqual({
      isOpen: true,
      type: 'kilo.sidebar.state',
    });
  });

  it('accepts only the known sidebar message shapes', () => {
    expect.assertions(5);
    expect(isToggleSidebarMessage({ type: 'kilo.sidebar.toggle' })).toBe(true);
    expect(isGetSidebarStateMessage({ type: 'kilo.sidebar.getState' })).toBe(true);
    expect(isSidebarStateMessage({ isOpen: false, type: 'kilo.sidebar.state' })).toBe(true);
    expect(isSidebarStateMessage({ type: 'kilo.sidebar.state' })).toBe(false);
    expect(isToggleSidebarMessage({ type: 'kilo.sidebar.unknown' })).toBe(false);
  });
});
