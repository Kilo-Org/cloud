/* eslint-disable import/no-nodejs-modules -- vitest-only guard, reads Swift sources under Node, never bundled into the app */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Source-contract guard for the iOS launcher-surfaces module.
//
// The host that runs this suite has no Xcode and no iOS simulator, and CI does
// not build the iOS app, so the Quick Action rules below cannot be exercised
// by a running test. They are pinned against the sources instead, the way
// `launcher-surfaces-native-api.test.ts` pins the Android API-level guards.
//
// Why they matter:
// - `UIApplicationShortcutItem.type` must be unique across the app. The deep-link
//   url is not: the longest-waiting session is often also the last-opened one, so
//   Needs input and Open last session would share one type. The url therefore
//   travels in `userInfo`.
// - The url a cold start parks in UserDefaults must not survive sign-out, or it
//   routes the next account to the previous account's session.
// - UIKit re-delivers the launched item through
//   `application(_:performActionFor:completionHandler:)` while the parked copy
//   still waits for the JS mount. Opening it there too navigates twice for one
//   tap, so the callback must leave the parked copy to the mount. Expo's
//   subscriber manager ignores a subscriber's launch return value
//   (`ExpoAppDelegateSubscriberManager.swift:36`), so `return false` cannot be
//   that guard; the parked url itself is the marker.

const IOS_DIR = fileURLToPath(new URL('../../modules/kilo-launcher-surfaces/ios', import.meta.url));

function readSource(name: string): string {
  return readFileSync(join(IOS_DIR, name), 'utf8');
}

/** The body between the braces of the nth `func <name>(` declaration, or ''. */
function functionBody(source: string, name: string, occurrence = 0): string {
  const matches = [...source.matchAll(new RegExp(String.raw`func\s+${name}\s*\(`, 'g'))];
  const signature = matches[occurrence];
  if (signature === undefined) {
    return '';
  }
  const open = source.indexOf('{', signature.index);
  if (open === -1) {
    return '';
  }
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open + 1, index);
      }
    }
  }
  return '';
}

describe('iOS Quick Action type contract', () => {
  const moduleSource = readSource('KiloLauncherSurfacesModule.swift');

  it('gives the three actions three distinct stable types', () => {
    const types = [...moduleSource.matchAll(/static let (\w+)Type = "([^"]+)"/g)].map(match => ({
      name: match[1],
      value: match[2],
    }));
    expect(types.map(type => type.name)).toEqual(['newAgent', 'needsInput', 'openLastSession']);
    expect(new Set(types.map(type => type.value)).size).toBe(types.length);
    for (const { name } of types) {
      expect(moduleSource).toContain(`identifier: KiloLauncherSurfacesShortcut.${name}Type`);
    }
  });

  it('builds an item whose type is the identifier and whose url is userInfo data', () => {
    const body = functionBody(moduleSource, 'shortcut');
    expect(body).toContain('type: identifier');
    expect(body).toContain(
      'userInfo: [KiloLauncherSurfacesShortcut.urlUserInfoKey: url as NSString]'
    );
    // The url is data: using it as the type is the collision the contract forbids.
    expect(body).not.toMatch(/type:\s*url\b/);
  });
});

describe('iOS Quick Action url handoff contract', () => {
  const storeSource = readSource('KiloLauncherSurfacesStore.swift');
  const moduleSource = readSource('KiloLauncherSurfacesModule.swift');
  const subscriberSource = readSource('KiloLauncherSurfacesAppDelegateSubscriber.swift');

  it('reads the tapped action url from userInfo, not from the shortcut type', () => {
    expect(subscriberSource).toMatch(
      /var launcherUrl: String\? \{[\s\S]*?userInfo\?\[KiloLauncherSurfacesShortcut\.urlUserInfoKey\] as\? String/
    );
    expect(functionBody(subscriberSource, 'application')).toContain('launcherUrl');
    expect(subscriberSource).not.toMatch(/\bitem\.type\b|\bshortcutItem\.type\b/);
  });

  it('clears the parked cold-start url on the sign-out path', () => {
    expect(functionBody(storeSource, 'clearPendingLaunchUrl')).toContain(
      'removeObject(forKey: pendingLaunchUrlKey)'
    );
    expect(functionBody(moduleSource, 'clearDynamicSurfaces')).toContain(
      'KiloLauncherSurfacesStore.clearPendingLaunchUrl()'
    );
  });

  it('stores and consumes the parked url under one key', () => {
    expect(functionBody(storeSource, 'storePendingLaunchUrl')).toContain('pendingLaunchUrlKey');
    expect(functionBody(storeSource, 'consumePendingLaunchUrl')).toContain('pendingLaunchUrlKey');
  });

  it('reads the parked url without dropping it, so only consume clears the slot', () => {
    const body = functionBody(storeSource, 'pendingLaunchUrl');
    expect(body).not.toBe('');
    expect(body).toContain('pendingLaunchUrlKey');
    expect(body).not.toContain('removeObject');
  });

  it('skips the action callback for the cold-start item it already parked', () => {
    const callbackBody = functionBody(subscriberSource, 'application', 1);
    expect(callbackBody).not.toBe('');
    // The callback runs for the item the launch already parked while the JS
    // mount has not consumed it yet: opening both is two navigations for one
    // tap, so the parked url is checked before `application.open`.
    expect(callbackBody).toContain('KiloLauncherSurfacesStore.pendingLaunchUrl()');
    expect(callbackBody.indexOf('KiloLauncherSurfacesStore.pendingLaunchUrl()')).toBeLessThan(
      callbackBody.indexOf('application.open')
    );
    // The check must not swallow a later warm tap: the mount empties the slot by
    // consuming it, and this callback leaves the parked copy for the mount.
    expect(callbackBody).not.toContain('consumePendingLaunchUrl');
  });
});
