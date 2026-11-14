import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { sessionSurface } from '@/lib/ssh/session/surface';
import { type SshSession } from '@/lib/ssh/session/types';
import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { SshTerminalScreen } from './ssh-terminal-screen';

const state = vi.hoisted(() => ({
  session: null as SshSession | null,
  retrySession: vi.fn(),
}));

vi.mock('expo-router', () => ({
  usePathname: () => '/ssh/session/session',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: object) => (options ? `${key} ${JSON.stringify(options)}` : key),
  }),
}));
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('react-native-keyboard-controller', () => ({
  KeyboardAvoidingView: 'KeyboardAvoidingView',
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ssh/session/ssh-session-overlays', () => ({
  SshSessionOverlays: 'SshSessionOverlays',
}));
vi.mock('@/components/ssh/session/ssh-terminal-closed', () => ({
  SshTerminalClosed: 'SshTerminalClosed',
}));
vi.mock('@/components/ssh/snippets/snippets-sheet', () => ({ SnippetsSheet: 'SnippetsSheet' }));
vi.mock('@/components/ssh/session/ssh-host-key-blocked', () => ({
  SshHostKeyBlocked: 'SshHostKeyBlocked',
}));
vi.mock('@/components/ssh/session/ssh-session-stage', () => ({
  SshSessionStage: 'SshSessionStage',
}));
vi.mock('@/components/ssh/session/ssh-session-switcher', () => ({
  SshSessionSwitcher: 'SshSessionSwitcher',
}));
vi.mock('@/components/ssh/session/terminal-key-bar', () => ({ TerminalKeyBar: 'TerminalKeyBar' }));
vi.mock('@/components/ssh/session/terminal-input', () => ({
  blurShell: vi.fn(),
  sendToShell: vi.fn(),
}));
vi.mock('@/components/ssh/session/terminal-paste', () => ({
  useTerminalPaste: () => ({ sheet: null, pasteFromClipboard: vi.fn() }),
}));
vi.mock('@/components/ssh/session/terminal-surface', () => ({
  TerminalSurface: 'TerminalSurface',
}));
vi.mock('@/components/ssh/session/use-terminal-shell', () => ({
  useTerminalShell: (_id: string, session: SshSession) => ({
    terminalRef: { current: null },
    displayedShellId: session.shellId,
    surface: sessionSurface(session.phase, session.shellId !== null),
    inputReady: session.phase.kind === 'connected',
  }),
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icon-button', () => ({ IconButton: 'IconButton' }));
vi.mock('@/components/ui/icons', () => ({
  FolderOpen: 'FolderOpen',
  MoreHorizontal: 'MoreHorizontal',
  RefreshCw: 'RefreshCw',
  Rows3: 'Rows3',
  WifiOff: 'WifiOff',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/lib/utils', () => ({ cn: (...classes: string[]) => classes.join(' ') }));
vi.mock('@/lib/hooks/use-terminal-font-size', () => ({
  useTerminalFontSize: () => ({ fontSize: 14, setFontSize: vi.fn() }),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));
vi.mock('@/lib/ssh/session/manager', () => ({
  closeSession: vi.fn(),
  decideHostKey: vi.fn(),
  endShell: vi.fn(),
  retrySession: state.retrySession,
}));
vi.mock('@/lib/ssh/session/use-idle-notify-arming', () => ({ useIdleNotifyArming: vi.fn() }));
vi.mock('@/lib/ssh/session/use-sessions', () => ({
  useSshSession: () => state.session,
  useSshSessions: () => [state.session],
  useSshSessionsRehydrated: () => true,
}));

let mounted: ReactTestRenderer | undefined = undefined;

beforeEach(() => {
  vi.clearAllMocks();
  state.session = {
    id: 'session',
    hostId: 'host',
    label: 'fixture',
    target: 'user@fixture:22',
    startedAt: 1,
    phase: { kind: 'connecting', attempt: 3 },
    shellId: 'shell-1',
    nativeSessionId: null,
    pendingCommand: null,
  };
});

afterEach(() => {
  act(() => {
    mounted?.unmount();
  });
  mounted = undefined;
});

function mount() {
  act(() => {
    mounted = TestRenderer.create(<SshTerminalScreen sessionId="session" />);
  });
  if (mounted === undefined) {
    throw new Error('SSH terminal did not mount');
  }
  return mounted;
}

function renderedText(screen: ReactTestRenderer) {
  return screen.root
    .findAllByType('Text')
    .flatMap(node => node.children.filter(child => typeof child === 'string'))
    .join(' ');
}

it('shows the active reconnect attempt without an ineffective retry action or disconnected message', () => {
  const screen = mount();
  const rendered = renderedText(screen);
  expect(rendered).toContain('ssh.session.reconnectingTitle');
  expect(rendered).toContain('ssh.session.reconnectingStage');
  expect(rendered).toContain('user@fixture:22');
  expect(
    screen.root.findByProps({ children: 'ssh.session.reconnectingTitle {"attempt":3}' })
  ).toBeDefined();
  expect(rendered).not.toContain('ssh.session.reason.disconnected');
  expect(rendered).not.toContain('ssh.session.retryNow');
  expect(screen.root.findAllByType('Button')).toHaveLength(0);
});

it('retries immediately between attempts and replaces the stale reason and action while connecting', () => {
  if (state.session === null) {
    throw new Error('Missing session fixture');
  }
  state.session = {
    ...state.session,
    phase: { kind: 'reconnecting', attempt: 4, reason: 'disconnected' },
  };
  const screen = mount();
  expect(renderedText(screen)).toContain('ssh.session.reason.disconnected');
  expect(renderedText(screen)).toContain('ssh.session.retryNow');
  const { onPress } = screen.root.findByType('Button').props as { onPress: () => void };
  act(() => {
    onPress();
  });
  expect(state.retrySession).toHaveBeenCalledExactlyOnceWith('session');

  state.session = { ...state.session, phase: { kind: 'connecting', attempt: 1 } };
  act(() => {
    screen.update(<SshTerminalScreen sessionId="session" />);
  });
  const rendered = renderedText(screen);
  expect(rendered).toContain('ssh.session.reconnectingStage');
  expect(rendered).not.toContain('ssh.session.reason.disconnected');
  expect(rendered).not.toContain('ssh.session.retryNow');
  expect(screen.root.findAllByType('Button')).toHaveLength(0);
});
