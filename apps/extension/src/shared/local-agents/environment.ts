/* eslint-disable typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type over interface */
import { buildExtensionHello } from './envelope';
import type { LocalAgentCapabilities, LocalAgentExtensionHello } from './envelope';

/*
 * Values the extension announces in `ext.hello`, derived from the APIs this
 * build actually exposes. Firefox has no `debugger` API (so no trusted input),
 * and its tab groups appear only from Firefox 139.
 */

export type LocalAgentApiAvailability = {
  hasDebugger: boolean;
  hasScripting: boolean;
  hasTabGroups: boolean;
  hasWebRequest: boolean;
};

export type LocalAgentBrowserIdentity = { name: string; version: string };

const UNKNOWN_BROWSER: LocalAgentBrowserIdentity = { name: 'Unknown', version: '0' };
const UNKNOWN_VERSION = '0.0.0';
const UNKNOWN_PLATFORM = 'Unknown';

const matchVersion = (pattern: RegExp, userAgent: string): string | null => {
  const match = pattern.exec(userAgent);

  return match?.[1] ?? null;
};

export const parseBrowserFromUserAgent = (userAgent: string): LocalAgentBrowserIdentity => {
  const edge = matchVersion(/\bEdg\/(\d+(?:\.\d+)*)/u, userAgent);

  if (edge !== null) {
    return { name: 'Edge', version: edge };
  }

  const firefox = matchVersion(/\bFirefox\/(\d+(?:\.\d+)*)/u, userAgent);

  if (firefox !== null) {
    return { name: 'Firefox', version: firefox };
  }

  const chrome = matchVersion(/\bChrome\/(\d+(?:\.\d+)*)/u, userAgent);

  if (chrome !== null) {
    return { name: 'Chrome', version: chrome };
  }

  const safari = matchVersion(/\bVersion\/(\d+(?:\.\d+)*).*Safari/u, userAgent);

  if (safari !== null) {
    return { name: 'Safari', version: safari };
  }

  return UNKNOWN_BROWSER;
};

export const parsePlatformFromUserAgent = (userAgent: string): string => {
  if (/\bCrOS\b/u.test(userAgent)) {
    return 'ChromeOS';
  }

  if (/Mac OS X|Macintosh/u.test(userAgent)) {
    return 'macOS';
  }

  if (/Windows/u.test(userAgent)) {
    return 'Windows';
  }

  if (/Android/u.test(userAgent)) {
    return 'Android';
  }

  if (/Linux/u.test(userAgent)) {
    return 'Linux';
  }

  return UNKNOWN_PLATFORM;
};

export const deriveCapabilities = (
  availability: LocalAgentApiAvailability
): LocalAgentCapabilities => ({
  console: availability.hasDebugger || availability.hasScripting,
  dialogs: availability.hasDebugger || availability.hasScripting,
  fileUpload: availability.hasDebugger || availability.hasScripting,
  network: availability.hasDebugger || availability.hasWebRequest,
  tabGroups: availability.hasTabGroups,
  trustedInput: availability.hasDebugger,
});

export const createLocalAgentHello = ({
  availability,
  extensionVersion,
  userAgent,
}: {
  availability: LocalAgentApiAvailability;
  extensionVersion: string | undefined;
  userAgent: string;
}): LocalAgentExtensionHello => {
  const browser = parseBrowserFromUserAgent(userAgent);

  return buildExtensionHello({
    browser,
    capabilities: deriveCapabilities(availability),
    extensionVersion: extensionVersion ?? UNKNOWN_VERSION,
    profileLabel: `${browser.name} on ${parsePlatformFromUserAgent(userAgent)}`,
  });
};
