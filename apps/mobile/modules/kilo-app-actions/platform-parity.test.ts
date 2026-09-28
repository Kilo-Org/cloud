// Cross-platform parity: the four app actions behave the same on iOS and on
// Android, and the capability each platform actually has.
//
// The two platform suites (`ios-app-intents.test.ts`,
// `android-app-actions.test.ts`) each hold their own tree against the JS
// contract (`src/lib/app-actions/app-action-contract.ts`); neither compares
// the two platforms, and the owner's amendment makes the parity itself the
// requirement — the behaviour the user sees must match. This suite reads both
// native trees in one place and compares them, so the pull request can cite
// it for what each platform actually built.
//
// Like the other native-module suites, this one runs in node and reads the
// sources the app ships; nothing here proves a device.

// eslint-disable-next-line import/no-nodejs-modules -- vitest-only parity check, runs in node, never bundled into the app
import { readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only parity check, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  APP_ACTION_IDS,
  APP_ACTION_SLUGS,
  type AppActionId,
  type AppActionRequest,
  appActionUrl,
  parseAppActionUrl,
} from '../../src/lib/app-actions/app-action-contract';

const IOS_DIRECTORY = './ios/';
const ANDROID_MAIN = './android/src/main/';
const ANDROID_KOTLIN = `${ANDROID_MAIN}java/expo/modules/kiloappactions/`;

function readSource(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
}

const intentsSource = readSource(`${IOS_DIRECTORY}KiloAppIntents.swift`);
const bridgeSource = readSource(`${IOS_DIRECTORY}KiloAppActionBridge.swift`);
const iosModuleSource = readSource(`${IOS_DIRECTORY}KiloAppActionsModule.swift`);
const manifestSource = readSource(`${ANDROID_MAIN}AndroidManifest.xml`);
const androidModuleSource = readSource(`${ANDROID_KOTLIN}KiloAppActionsModule.kt`);
const activitySource = readSource(`${ANDROID_KOTLIN}KiloActionActivity.kt`);
const shortcutsXml = readSource(`${ANDROID_MAIN}res/xml/shortcuts.xml`);

/** One native source file, with the name failure messages cite. */
type NamedSource = readonly [file: string, source: string];

const IOS_SOURCES: readonly NamedSource[] = [
  ['KiloAppIntents.swift', intentsSource],
  ['KiloAppActionBridge.swift', bridgeSource],
  ['KiloAppActionsModule.swift', iosModuleSource],
];

const ANDROID_SOURCES: readonly NamedSource[] = [
  ['AndroidManifest.xml', manifestSource],
  ['KiloAppActionsModule.kt', androidModuleSource],
  ['KiloActionActivity.kt', activitySource],
  ['shortcuts.xml', shortcutsXml],
];

const BOTH_TREES: readonly NamedSource[] = [...IOS_SOURCES, ...ANDROID_SOURCES];

const CONTRACT_SLUGS: string[] = APP_ACTION_IDS.map(id => APP_ACTION_SLUGS[id]);

/** The custom intent action prefix the Android entry points answer. */
const ACTION_PREFIX = 'com.kilocode.kiloapp.action.';

/** `StartAgent` → `START_AGENT`, the identifier form the Android entry points use. */
function actionName(action: AppActionId): string {
  return action.replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/** The manifest and capability declaration action string for one contract action. */
function actionString(action: AppActionId): string {
  return `${ACTION_PREFIX}${actionName(action)}`;
}

/** The values, sorted for an order-insensitive comparison. */
function sorted(values: readonly string[]): string[] {
  return values.toSorted((left, right) => left.localeCompare(right));
}

/** A `kiloapp:///actions/<slug>…` literal, with the slug it names. */
const ACTION_URL = /kiloapp:\/\/\/actions\/([a-z][a-z-]*)[^\s"'<>`)\]]*/g;

/** Every action URL literal a platform's sources carry, named by file. */
function actionLiterals(sources: readonly NamedSource[]): {
  file: string;
  literal: string;
  slug: string;
}[] {
  return sources.flatMap(([file, source]) =>
    [...source.matchAll(ACTION_URL)].map(match => ({
      file,
      literal: match[0],
      slug: match[1] ?? '',
    }))
  );
}

/** The contract slug of a payload `action` spelling — an id or a slug. */
function slugOfSpelling(value: string): string | null {
  for (const id of APP_ACTION_IDS) {
    if (id === value) {
      return APP_ACTION_SLUGS[id];
    }
  }
  return CONTRACT_SLUGS.includes(value) ? value : null;
}

/**
 * The action slugs one tree declares, in whatever spelling the platform uses:
 * the `kiloapp:///actions/<slug>` targets, the payload `action` values the
 * entry points send (iOS names the id `StartAgent` for the bridge, Android
 * names the slug in its `SLUG_BY_ACTION` table), and Android's slug table
 * itself.
 */
function declaredSlugs(sources: readonly NamedSource[]): string[] {
  const slugs = new Set<string>();
  for (const { slug } of actionLiterals(sources)) {
    slugs.add(slug);
  }
  for (const [, source] of sources) {
    for (const [, value] of source.matchAll(/"action"\s*:\s*"([A-Za-z-]+)"/g)) {
      const slug = slugOfSpelling(value ?? '');
      if (slug !== null) {
        slugs.add(slug);
      }
    }
    for (const pair of source.matchAll(/(ACTION_[A-Z_]+) to "([a-z][a-z-]*)"/g)) {
      slugs.add(pair[2] ?? '');
    }
  }
  return [...slugs];
}

/** One request per action, with the fields the grammar requires. */
const REPRESENTATIVE: Record<AppActionId, AppActionRequest> = {
  StartAgent: { action: 'StartAgent', prompt: 'Summarize the open pull request' },
  OpenNeedsInput: { action: 'OpenNeedsInput' },
  OpenSession: { action: 'OpenSession', sessionId: 'session-under-test' },
  OpenPullRequest: { action: 'OpenPullRequest', pullRequest: 'https://github.com/o/r/pull/7' },
};

/**
 * The request a literal parses to. A complete literal parses directly; a bare
 * target (the iOS `KiloAppActionTarget` constants) carries no query — the
 * entry point appends the fields at run time — so the proof is the literal
 * completed with the grammar's own query. Null when neither parses.
 */
function parsedActionRequest(literal: string, slug: string): AppActionRequest | null {
  const parsed = parseAppActionUrl(literal);
  if (parsed !== null) {
    return parsed;
  }
  const action = APP_ACTION_IDS.find(id => APP_ACTION_SLUGS[id] === slug);
  if (action === undefined) {
    return null;
  }
  const completed = appActionUrl(REPRESENTATIVE[action]);
  const question = completed.indexOf('?');
  const query = question === -1 ? '' : completed.slice(question);
  return parseAppActionUrl(`${literal}${query}`);
}

/** The body of `struct <name>: … { … }`, braces balanced. */
function swiftStruct(name: string): string {
  const declaration = intentsSource.indexOf(`struct ${name}:`);
  expect(declaration, `${name} is not declared`).toBeGreaterThanOrEqual(0);
  const open = intentsSource.indexOf('{', declaration);
  let depth = 0;
  for (let index = open; index < intentsSource.length; index += 1) {
    if (intentsSource[index] === '{') {
      depth += 1;
    } else if (intentsSource[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return intentsSource.slice(open, index + 1);
      }
    }
  }
  throw new Error(`${name} is never closed`);
}

const iosLiterals = actionLiterals(IOS_SOURCES);
const androidLiterals = actionLiterals(ANDROID_SOURCES);

describe('the same four actions on both platforms', () => {
  it('carries, taken together, exactly the contract slugs', () => {
    // Neither platform may add a fifth: the slugs of every
    // `kiloapp:///actions/…` literal in the two trees, taken together, are
    // exactly `APP_ACTION_SLUGS`.
    const union = new Set([...iosLiterals, ...androidLiterals].map(({ slug }) => slug));
    expect(sorted([...union])).toEqual(sorted(CONTRACT_SLUGS));
  });

  it('contributes all four actions from each tree, in its own spelling', () => {
    // Neither platform may ship a subset. iOS runs `StartAgent` through the
    // bridge payload (`"action": "StartAgent"` — the id form the contract
    // parses) and the open actions through their URL targets; Android
    // declares the slug of every entry point in its `SLUG_BY_ACTION` table
    // and its URL dialect.
    expect(sorted(declaredSlugs(IOS_SOURCES)), 'the iOS tree').toEqual(sorted(CONTRACT_SLUGS));
    expect(sorted(declaredSlugs(ANDROID_SOURCES)), 'the Android tree').toEqual(
      sorted(CONTRACT_SLUGS)
    );
  });
});

describe('the same native identifiers on both platforms', () => {
  it('declares one App Intent per action id, and no fifth', () => {
    for (const id of APP_ACTION_IDS) {
      expect(intentsSource, `${id} has no App Intent`).toContain(`struct ${id}Intent: AppIntent {`);
    }
    expect(intentsSource.match(/: AppIntent \{/g)).toHaveLength(APP_ACTION_IDS.length);
  });

  it('lists exactly one AppShortcut per action in the AppShortcutsProvider', () => {
    const provider = swiftStruct('KiloAppShortcuts');
    expect(provider.match(/AppShortcut\(/g)).toHaveLength(APP_ACTION_IDS.length);
    for (const id of APP_ACTION_IDS) {
      expect(provider, `${id} is not in the Shortcuts gallery`).toContain(`intent: ${id}Intent()`);
    }
  });

  it('declares one exported intent-filter per action id, and no fifth', () => {
    const filters = [
      ...manifestSource.matchAll(/<intent-filter[^>]*>([\s\S]*?)<\/intent-filter>/g),
    ].map(match => match[1] ?? '');
    const customActionFilters = filters.filter(filter => filter.includes(ACTION_PREFIX));
    expect(customActionFilters).toHaveLength(APP_ACTION_IDS.length);
    const declared = customActionFilters.map(
      filter => /android:name="(com\.kilocode\.kiloapp\.action\.[A-Z_]+)"/.exec(filter)?.[1] ?? ''
    );
    expect(sorted(declared)).toEqual(sorted(APP_ACTION_IDS.map(action => actionString(action))));
  });

  it('declares one capability per action in the file the manifest references', () => {
    // `shortcuts.xml` is the single capability declaration file; the manifest's
    // `android.app.shortcuts` meta-data is what makes it effective.
    const capabilities = [...shortcutsXml.matchAll(/<capability\s+android:name="([^"]+)"/g)].map(
      match => match[1] ?? ''
    );
    expect(sorted(capabilities)).toEqual(
      sorted(APP_ACTION_IDS.map(action => actionString(action)))
    );
  });
});

describe('one code path on both platforms', () => {
  it('registers the one shared JS dispatcher under the same module name', () => {
    // `registerAppActionDispatcher` (s3) is the only dispatcher: each
    // platform's Expo module hands the same JS handler to its native entry
    // points, and the JS side requires the same module name on both.
    expect(iosModuleSource).toContain('AsyncFunction("registerAppActionDispatcher")');
    expect(androidModuleSource).toContain('Function("registerAppActionDispatcher")');
    expect(iosModuleSource).toContain('Name("KiloAppActions")');
    expect(androidModuleSource).toContain('Name("KiloAppActions")');
  });

  it('drops the registered dispatcher when the runtime goes away, on both platforms', () => {
    // The bridge/dispatcher outlives the module on both platforms, so each
    // module's `OnDestroy` is what releases the JS dispatcher it registered.
    expect(androidModuleSource).toContain('OnDestroy');
    expect(androidModuleSource).toContain('AppActionDispatcher.clear()');
    expect(iosModuleSource).toContain('OnDestroy');
    expect(iosModuleSource).toContain('KiloAppActionBridge.shared.unregister()');
    expect(bridgeSource).toContain('func unregister()');
  });

  it('carries an action URL the contract parses in every literal of either tree', () => {
    for (const { file, literal, slug } of [...iosLiterals, ...androidLiterals]) {
      expect(
        parsedActionRequest(literal, slug),
        `${file} carries an action URL the contract cannot parse: ${literal}`
      ).not.toBeNull();
    }
  });

  it('reimplements no action in either native source', () => {
    // No tRPC procedure, no session-create call, no route resolver: the
    // native side only translates its entry point into the contract payload
    // the shared dispatcher runs.
    for (const [file, source] of BOTH_TREES) {
      expect(source, `${file} must not call tRPC`).not.toMatch(/\btrpc\b/i);
      expect(source, `${file} must not create a session itself`).not.toContain(
        'prepareAgentSession'
      );
      expect(source, `${file} must not resolve a session route itself`).not.toContain(
        'getAgentSessionPath'
      );
      expect(source, `${file} must not resolve a review route itself`).not.toContain(
        'providerPrRoutePath'
      );
    }
  });
});

describe('the same payload and result surface', () => {
  /** The contract's request fields per action (`AppActionRequest`, s1). */
  const REQUEST_FIELDS: Record<AppActionId, readonly string[]> = {
    StartAgent: ['action', 'prompt', 'repository', 'sessionId'],
    OpenNeedsInput: ['action'],
    OpenSession: ['action', 'sessionId'],
    OpenPullRequest: ['action', 'pullRequest'],
  };
  const ALL_FIELDS = sorted([...new Set(Object.values(REQUEST_FIELDS).flat())]);

  it('builds the JSON keys of the action it handles on iOS', () => {
    // The one native payload iOS builds is `StartAgent`'s, through the bridge.
    const body = swiftStruct('StartAgentIntent');
    const keys = new Set<string>();
    for (const [, key] of body.matchAll(/"(\w+)":/g)) {
      keys.add(key ?? '');
    }
    for (const [, key] of body.matchAll(/payload\["(\w+)"\]/g)) {
      keys.add(key ?? '');
    }
    expect(sorted([...keys])).toEqual(sorted(REQUEST_FIELDS.StartAgent));
  });

  it('builds the JSON keys of the contract fields on Android', () => {
    // One payload builder serves all four entry points: `action`, plus every
    // contract field the intent carries.
    const keys = new Set<string>();
    for (const [, key] of activitySource.matchAll(/\.put\("(\w+)"/g)) {
      keys.add(key ?? '');
    }
    for (const [, key] of activitySource.matchAll(/"(\w+)" to EXTRA_[A-Z_]+/g)) {
      keys.add(key ?? '');
    }
    expect(sorted([...keys])).toEqual(ALL_FIELDS);
  });

  it('carries the awaited result back to the caller on both platforms', () => {
    // iOS: the App Intent's perform returns the bridge's answer — the session
    // id a StartAgent run created on success — and a refusal throws with the
    // pipeline's message for Shortcuts to show.
    expect(bridgeSource).toContain(
      'func perform(payload: [String: String]) async throws -> String'
    );
    expect(bridgeSource, 'the session id on success').toContain('return sessionId');
    expect(bridgeSource, 'the JS message on failure').toContain('nonBlank(decoded.message)');
    expect(swiftStruct('StartAgentIntent')).toContain(
      '.result(value: try await KiloAppActionBridge.shared.perform(payload: payload))'
    );
    // Android: a caller that asked for a result gets the dispatcher's real
    // outcome through setResult, even across a cold start.
    expect(activitySource).toContain('AppActionDispatcher.await(payload)');
    expect(activitySource).toMatch(/putExtra\(KiloActionContract\.EXTRA_RESULT, result\)/);
    expect(activitySource).toContain('setResult(');
  });
});

describe('the mechanism each platform has', () => {
  it('declares the Shortcuts-app gallery exactly once and only on iOS', () => {
    // The statement the pull request must carry, as an assertion: the
    // AppShortcutsProvider — the Shortcuts-app gallery — is iOS's mechanism
    // and exists exactly once; Android has none, because Android has no
    // Shortcuts-app gallery. Android's surface is the exported entry points
    // plus the App Actions declarations, which surface through the Assistant
    // and the launcher and additionally need the Play Console capability
    // configuration.
    const declared = BOTH_TREES.flatMap(([file, source]) =>
      [...source.matchAll(/AppShortcutsProvider/g)].map(() => file)
    );
    expect(
      declared,
      'Android has no Shortcuts-app gallery: its surface is the exported entry points plus the App Actions declarations, which surface through the Assistant and the launcher and additionally need the Play Console capability configuration — so the AppShortcutsProvider exists exactly once, in the iOS tree'
    ).toEqual(['KiloAppIntents.swift']);
  });
});
