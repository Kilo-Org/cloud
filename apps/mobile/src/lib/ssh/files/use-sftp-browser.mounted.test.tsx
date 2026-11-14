import { afterEach, expect, it, vi } from 'vitest';
import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';
import { type SftpBrowser, useSftpBrowser } from './use-sftp-browser';

const ssh = vi.hoisted(() => ({
  openSftp: vi.fn(() => Promise.resolve('channel')),
  resolvePath: vi.fn(() => Promise.resolve('/home/user')),
  listDirectory: vi.fn(() => Promise.resolve([])),
  closeSftp: vi.fn(() => Promise.resolve()),
}));
vi.mock('../native', () => ({
  sshPackage: () => Promise.resolve(ssh),
  nativeErrorCode: () => 'Protocol',
}));
let mounted: ReactTestRenderer | undefined = undefined;
let browser: SftpBrowser = {
  phase: { kind: 'waiting' },
  path: null,
  entries: [],
  loading: false,
  refreshing: false,
  sftpId: null,
  open: vi.fn<() => void>(),
  refresh: vi.fn<() => void>(),
};
function Probe() {
  browser = useSftpBrowser('connection');
  return null;
}
afterEach(() => {
  act(() => mounted?.unmount());
  vi.clearAllMocks();
});
it('retries the first requested directory even before any listing succeeds', async () => {
  ssh.listDirectory.mockRejectedValueOnce(new Error('offline'));
  await act(async () => {
    mounted = TestRenderer.create(<Probe />);
    await Promise.resolve();
  });
  expect(browser.phase.kind).toBe('error');
  expect(browser.path).toBeNull();
  await act(async () => {
    browser.refresh();
    await Promise.resolve();
  });
  expect(ssh.listDirectory).toHaveBeenNthCalledWith(2, 'channel', '/home/user');
  expect(browser.phase.kind).toBe('ready');
  expect(browser.path).toBe('/home/user');
});
it('closes an opened channel when home resolution fails', async () => {
  ssh.resolvePath.mockRejectedValueOnce(new Error('home unavailable'));
  await act(async () => {
    mounted = TestRenderer.create(<Probe />);
    await Promise.resolve();
  });
  expect(browser.phase.kind).toBe('error');
  expect(ssh.closeSftp).toHaveBeenCalledExactlyOnceWith('channel');
  expect(browser.sftpId).toBeNull();
});
