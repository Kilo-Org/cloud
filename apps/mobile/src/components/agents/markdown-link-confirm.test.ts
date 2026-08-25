import { beforeEach, describe, expect, it, vi } from 'vitest';

import { confirmAndOpenMarkdownLink, formatLinkHost } from './markdown-link-confirm';

const { alert } = vi.hoisted(() => ({ alert: vi.fn() }));
vi.mock('react-native', () => ({ Alert: { alert } }));

const { openExternalUrl } = vi.hoisted(() => ({ openExternalUrl: vi.fn() }));
vi.mock('@/lib/external-link', () => ({ openExternalUrl }));

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: toastError } }));

const { trusted, getTrustedHostsHasLoaded, isTrustedHost, trustHost } = vi.hoisted(() => {
  const trustedHosts = new Set<string>();
  const hasLoaded = vi.fn(() => true);
  const trust = vi.fn((host: string) => {
    trustedHosts.add(host);
  });
  const isTrusted = vi.fn((host: string) => trustedHosts.has(host));
  return {
    trusted: trustedHosts,
    getTrustedHostsHasLoaded: hasLoaded,
    trustHost: trust,
    isTrustedHost: isTrusted,
  };
});
vi.mock('@/lib/hooks/use-trusted-hosts', () => ({
  getTrustedHostsHasLoaded,
  isTrustedHost,
  trustHost,
}));

type AlertButtons = { text: string; style?: string; onPress?: () => void }[];

type AlertCall = [string, string, AlertButtons];

beforeEach(() => {
  alert.mockReset();
  openExternalUrl.mockReset();
  toastError.mockReset();
  trusted.clear();
  getTrustedHostsHasLoaded.mockImplementation(() => true);
  trustHost.mockClear();
  isTrustedHost.mockClear();
});

describe('formatLinkHost', () => {
  it('lowercases the hostname', () => {
    expect(formatLinkHost('https://Example.COM/path')).toBe('example.com');
  });

  it('keeps a non-default port', () => {
    expect(formatLinkHost('https://example.com:8080/p')).toBe('example.com:8080');
    expect(formatLinkHost('http://example.com:3000')).toBe('example.com:3000');
  });

  it('drops a default port', () => {
    expect(formatLinkHost('https://example.com:443/p')).toBe('example.com');
    expect(formatLinkHost('http://example.com:80/p')).toBe('example.com');
  });

  it('returns null for an unparseable value', () => {
    expect(formatLinkHost('not a url')).toBeNull();
    expect(formatLinkHost('https://')).toBeNull();
  });
});

describe('confirmAndOpenMarkdownLink', () => {
  it('shows the host Alert with Cancel, Open, and Trust this host in order', () => {
    confirmAndOpenMarkdownLink('https://example.com/path', { label: 'link' });

    expect(alert).toHaveBeenCalledTimes(1);
    const [title, message, buttons] = alert.mock.calls[0] as AlertCall;
    expect(title).toBe('Open external link?');
    expect(message).toBe('This link opens example.com in your browser.');
    expect(buttons).toHaveLength(3);
    expect(buttons[0]).toMatchObject({ text: 'Cancel', style: 'cancel' });
    expect(buttons[1]?.text).toBe('Open');
    expect(buttons[2]?.text).toBe('Trust this host');
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it('opens without trusting when the user picks Open', () => {
    confirmAndOpenMarkdownLink('https://example.com/path', { label: 'link' });

    const buttons = (alert.mock.calls[0] as AlertCall)[2];
    buttons[1]?.onPress?.();

    expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/path', { label: 'link' });
    expect(trustHost).not.toHaveBeenCalled();
    expect(isTrustedHost('example.com')).toBe(false);
  });

  it('trusts the host and opens when the user picks Trust this host', () => {
    confirmAndOpenMarkdownLink('https://example.com/path', { label: 'link' });

    const buttons = (alert.mock.calls[0] as AlertCall)[2];
    buttons[2]?.onPress?.();

    expect(trustHost).toHaveBeenCalledWith('example.com');
    expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/path', { label: 'link' });
  });

  it('skips the Alert and opens directly once the host is trusted', () => {
    confirmAndOpenMarkdownLink('https://example.com/path', { label: 'link' });
    const buttons = (alert.mock.calls[0] as AlertCall)[2];
    buttons[2]?.onPress?.();

    alert.mockClear();
    openExternalUrl.mockClear();
    confirmAndOpenMarkdownLink('https://example.com/path', { label: 'link' });

    expect(alert).not.toHaveBeenCalled();
    expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/path', { label: 'link' });
  });

  it('still shows the Alert while the store has not loaded', () => {
    // Host is trusted in memory, but the store has not finished loading: never
    // skip the confirm before load.
    trustHost('example.com');
    getTrustedHostsHasLoaded.mockReturnValue(false);

    confirmAndOpenMarkdownLink('https://example.com/path', { label: 'link' });

    expect(alert).toHaveBeenCalledTimes(1);
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it('toasts for an invalid HTTP(S) href and never opens', () => {
    confirmAndOpenMarkdownLink('https://', { label: 'link' });

    expect(toastError).toHaveBeenCalledWith("This link can't be opened.");
    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it('opens a non-HTTP(S) scheme without showing the Alert', () => {
    confirmAndOpenMarkdownLink('mailto:hello@kilo.ai', { label: 'link' });

    expect(openExternalUrl).toHaveBeenCalledWith('mailto:hello@kilo.ai', { label: 'link' });
    expect(alert).not.toHaveBeenCalled();
  });
});
