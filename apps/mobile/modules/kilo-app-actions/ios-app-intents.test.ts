// eslint-disable-next-line import/no-nodejs-modules -- vitest-only contract check, runs in node, never bundled into the app
import { readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only contract check, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import APP_INTENT_COPY from '../../plugins/app-intent-copy.json';
import {
  assertIntentCopy,
  INTENT_COPY_KEYS,
  missingIntentCopyKeys,
  renderLocalizableStrings,
} from '../../plugins/app-intent-copy.js';
import {
  APP_ACTION_IDS,
  APP_ACTION_SLUGS,
  type AppActionId,
  type AppActionRequest,
  appActionUrl,
  parseAppActionUrl,
} from '../../src/lib/app-actions/app-action-contract';
import { SUPPORTED_LANGUAGES } from '../../src/i18n/languages';

// The native module is not built on this host, so this suite reads the sources
// it ships. Each check is a contract between two files that must not drift: the
// Swift intents and the JS grammar (s1), the Swift copy and the plugin's
// translations, and the module handshake and the JS dispatcher registration.

const iosModuleDirectory = new URL('ios/', import.meta.url);

function readSource(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, iosModuleDirectory)), 'utf8');
}

const intents = readSource('KiloAppIntents.swift');
const bridge = readSource('KiloAppActionBridge.swift');
const actionsModule = readSource('KiloAppActionsModule.swift');
const podspec = readSource('KiloAppActions.podspec');
const configSource = readFileSync(
  fileURLToPath(new URL('../../app.config.ts', import.meta.url)),
  'utf8'
);

/** The English copy, which is both the `.strings` key and the fallback. */
const ENGLISH_COPY = APP_INTENT_COPY.en;

/** The intent type per action, in the provider's order. */
const INTENT_TYPES = {
  StartAgent: 'StartAgentIntent',
  OpenNeedsInput: 'OpenNeedsInputIntent',
  OpenSession: 'OpenSessionIntent',
  OpenPullRequest: 'OpenPullRequestIntent',
} as const satisfies Record<AppActionId, string>;

/** The actions that open the app themselves; `StartAgent` runs in the background. */
const OPEN_ACTIONS = ['OpenNeedsInput', 'OpenSession', 'OpenPullRequest'] as const;

/** The body of `struct <name>: … { … }`, braces balanced. */
function swiftStruct(name: string): string {
  const declaration = intents.indexOf(`struct ${name}:`);
  expect(declaration, `${name} is not declared`).toBeGreaterThanOrEqual(0);
  const open = intents.indexOf('{', declaration);
  let depth = 0;
  for (let index = open; index < intents.length; index += 1) {
    if (intents[index] === '{') {
      depth += 1;
    } else if (intents[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return intents.slice(open, index + 1);
      }
    }
  }
  throw new Error(`${name} is never closed`);
}

/** The value the struct declares for `openAppWhenRun`, or null when it does not. */
function openAppWhenRun(body: string): string | null {
  return /openAppWhenRun[^=]*=\s*(true|false)/.exec(body)?.[1] ?? null;
}

describe('the four App Intents', () => {
  it.each(APP_ACTION_IDS)('declares the %s intent', action => {
    expect(intents).toContain(`struct ${INTENT_TYPES[action]}: AppIntent {`);
  });

  it('declares every copy string the plugin translates', () => {
    for (const [key, value] of Object.entries(ENGLISH_COPY)) {
      expect(intents, `${key} is missing from the Swift copy`).toContain(`static let ${key}:`);
      expect(intents, `${key}'s copy is missing`).toContain(value);
    }
  });

  it('declares no OS surface beyond the provider', () => {
    expect(intents).not.toContain('SiriTipView');
    expect(intents).not.toMatch(/donat/i);
    expect(intents).not.toContain('INIntent');
  });

  it('opens the app for the open actions and stays closed for StartAgent', () => {
    for (const action of OPEN_ACTIONS) {
      expect(openAppWhenRun(swiftStruct(INTENT_TYPES[action])), `${action} must open the app`).toBe(
        'true'
      );
    }
    expect(openAppWhenRun(swiftStruct(INTENT_TYPES.StartAgent))).toBe('false');
  });

  it('lists every action in the AppShortcutsProvider', () => {
    expect(intents).toContain('struct KiloAppShortcuts: AppShortcutsProvider {');
    const provider = swiftStruct('KiloAppShortcuts');
    expect(provider.match(/AppShortcut\(/g)).toHaveLength(APP_ACTION_IDS.length);
    for (const action of APP_ACTION_IDS) {
      expect(provider).toContain(`intent: ${INTENT_TYPES[action]}()`);
    }
    // The provider requires a phrase per shortcut, and every phrase must carry
    // the app name. Nothing else is declared: no tips, no donations.
    expect(provider.match(/phrases: \[/g)).toHaveLength(APP_ACTION_IDS.length);
    expect(provider.match(/\\\(\.applicationName\)/g)).toHaveLength(APP_ACTION_IDS.length);
  });
});

describe('the Swift action URLs', () => {
  const literals = [...intents.matchAll(/kiloapp:\/\/\/actions\/[a-z-]+/g)].map(match => match[0]);

  /** One request per action, used to compare the Swift slug against the grammar. */
  const REPRESENTATIVE: Record<AppActionId, AppActionRequest> = {
    StartAgent: { action: 'StartAgent', prompt: 'Summarize the open pull request' },
    OpenNeedsInput: { action: 'OpenNeedsInput' },
    OpenSession: { action: 'OpenSession', sessionId: 'session-under-test' },
    OpenPullRequest: {
      action: 'OpenPullRequest',
      pullRequest: 'https://github.com/Kilo-Org/cloud/pull/1',
    },
  };

  function actionOf(literal: string): AppActionId {
    const slug = literal.slice(literal.lastIndexOf('/') + 1);
    const action = APP_ACTION_IDS.find(id => APP_ACTION_SLUGS[id] === slug);
    if (action === undefined) {
      throw new Error(`${literal} names no action the JS grammar knows`);
    }
    return action;
  }

  it('declares one URL per open action', () => {
    expect(literals).toHaveLength(OPEN_ACTIONS.length);
    expect(new Set(literals).size).toBe(OPEN_ACTIONS.length);
  });

  it.each(literals)('%s parses with parseAppActionUrl', literal => {
    const request = REPRESENTATIVE[actionOf(literal)];
    const url = appActionUrl(request);
    expect(url.startsWith(literal)).toBe(true);
    expect(parseAppActionUrl(url)).toEqual(request);
  });

  it('sends the payload and query fields the grammar reads', () => {
    for (const field of ['action', 'prompt', 'repository', 'sessionId', 'pullRequest']) {
      expect(intents, `${field} is not sent`).toContain(`"${field}"`);
    }
  });
});

describe('the native handshake', () => {
  it('registers the JS dispatcher under the module name the JS side requires', () => {
    expect(actionsModule).toContain('AsyncFunction("registerAppActionDispatcher")');
    expect(actionsModule).toContain('Name("KiloAppActions")');
    expect(actionsModule).toContain('KiloAppActionBridge.shared');
    expect(bridge).toContain('static let shared = KiloAppActionBridge()');
  });

  it('bounds the wait for registration and reports a failure', () => {
    expect(bridge).toContain('waitUntilRegistered');
    expect(bridge).toMatch(/registrationTimeout: TimeInterval = 25/);
    expect(bridge).toContain('KiloAppActionError.dispatcherUnavailable');
    expect(bridge).toContain('func perform(payload: [String: String]) async throws -> String');
  });

  it('reads the result fields the JS contract answers with', () => {
    // The `AppActionResult` fields of src/lib/app-actions/app-action-contract.ts:
    // a renamed field here would silently turn every run into a malformed result.
    for (const field of ['ok', 'sessionId', 'message', 'retryable']) {
      expect(bridge, `${field} is not read from the answer`).toContain(`getProperty("${field}")`);
    }
  });

  it('ships the pod the module config autolinks', () => {
    expect(podspec).toContain("s.name = 'KiloAppActions'");
    expect(podspec).toContain("s.platforms = { :ios => '16.4' }");
    expect(podspec).toContain("s.source_files = '**/*.swift'");
  });
});

describe('the App Intent copy', () => {
  it('holds exactly the keys the plugin renders', () => {
    expect(Object.keys(ENGLISH_COPY).toSorted()).toEqual([...INTENT_COPY_KEYS].toSorted());
  });

  it('renders one escaped line per key for en', () => {
    const lines = renderLocalizableStrings(APP_INTENT_COPY, 'en').split('\n');
    expect(lines.at(-1)).toBe('');
    const entries = lines.slice(0, -1);
    expect(entries).toHaveLength(INTENT_COPY_KEYS.length);
    expect(entries.toSorted()).toEqual(
      Object.values(ENGLISH_COPY)
        .map(value => `"${value}" = "${value}";`)
        .toSorted()
    );
    expect(entries[0]).toBe('"Start agent" = "Start agent";');
  });

  it('escapes a quote and a backslash in the key and the value', () => {
    const copy = { en: { ...ENGLISH_COPY, startAgent: 'Say "hi" \\ now' } };
    expect(renderLocalizableStrings(copy, 'en')).toContain(
      String.raw`"Say \"hi\" \\ now" = "Say \"hi\" \\ now";`
    );
  });

  it('rejects a copy missing a key', () => {
    const partial = { en: { startAgent: 'Start agent' } };
    expect(missingIntentCopyKeys(partial, 'en')).toEqual(
      INTENT_COPY_KEYS.filter(key => key !== 'startAgent')
    );
    expect(missingIntentCopyKeys({ en: { ...ENGLISH_COPY, openSession: '  ' } }, 'en')).toEqual([
      'openSession',
    ]);
    expect(() => renderLocalizableStrings(partial, 'en')).toThrow(/missing/);
    expect(() => {
      assertIntentCopy(partial, 'de');
    }).toThrow(/de/);
  });
});

describe('app.config.ts', () => {
  it('registers the app-target localizations with every supported language', () => {
    expect(configSource).toContain("from './plugins/app-intent-copy.json'");
    expect(configSource).toContain("'./plugins/withAppIntentLocalizations'");
    expect(configSource).toContain('languages: [...SUPPORTED_LANGUAGES]');
  });

  it('declares no language the app does not support', () => {
    for (const tag of Object.keys(APP_INTENT_COPY)) {
      expect(SUPPORTED_LANGUAGES, `${tag} is not a supported language`).toContain(tag);
      expect(missingIntentCopyKeys(APP_INTENT_COPY, tag)).toEqual([]);
    }
  });

  it('aborts a prebuild whose language has no copy', () => {
    // `app.config.ts` declares all of SUPPORTED_LANGUAGES. The translation
    // slice fills the tags beyond `en`, the same way the widget gallery's copy
    // is complete; until then this validation — the widget plugin's own
    // contract — fails the prebuild instead of shipping English labels.
    expect(() => {
      assertIntentCopy({ en: ENGLISH_COPY }, 'de');
    }).toThrow(/de/);
  });
});
