// eslint-disable-next-line import/no-nodejs-modules -- vitest-only contract check, runs in node, never bundled into the app
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only contract check, runs in node, never bundled into the app
import { tmpdir } from 'node:os';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only contract check, runs in node, never bundled into the app
import { join } from 'node:path';
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
import { mergeIntoResourcesPhase } from '../../plugins/app-intent-resources.js';
import { installPublisher, sourceFiles } from '../../plugins/kilo-app-intents-sources.js';
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

const intents = readSource('AppIntents/KiloAppIntents.swift');
const jsBridgeSource = readFileSync(
  fileURLToPath(new URL('../../src/lib/app-actions/native-bridge.ts', import.meta.url)),
  'utf8'
);
const collectorSource = readFileSync(
  fileURLToPath(new URL('../../src/lib/system-search-collect.ts', import.meta.url)),
  'utf8'
);
const configSource = readFileSync(
  fileURLToPath(new URL('../../app.config.ts', import.meta.url)),
  'utf8'
);
const pluginSource = readFileSync(
  fileURLToPath(new URL('../../plugins/withAppIntentLocalizations.js', import.meta.url)),
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

/** The actions that also carry a `kiloapp://` URL; `StartAgent` passes a payload instead. */
const URL_ACTIONS = ['OpenNeedsInput', 'OpenSession', 'OpenPullRequest'] as const;

/** The lines that hand a label to the App Intents metadata extractor. */
const LABEL_LINE =
  /static var title: LocalizedStringResource|@Parameter\(title:|shortTitle:|String\(localized:/;

/** The body of the braced block `declaration` opens in `source`, braces balanced. */
function swiftBlock(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  expect(start, `${declaration} is not declared`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') {
      depth += 1;
    } else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open, index + 1);
      }
    }
  }
  throw new Error(`${declaration} is never closed`);
}

/** The body of `struct <name>: … { … }` in the intents source. */
function swiftStruct(name: string): string {
  return swiftBlock(intents, `struct ${name}:`);
}

/** The value the struct declares for `openAppWhenRun`, or null when it does not. */
function openAppWhenRun(body: string): string | null {
  return /openAppWhenRun[^=]*=\s*(true|false)/.exec(body)?.[1] ?? null;
}

/**
 * The project the plugin's `addBuildPhase` call returns into: the app target's
 * own Resources phase, carrying Expo's members, with the phase this plugin
 * created beside it.
 */
function projectAfterAddBuildPhase() {
  const existing = {
    isa: 'PBXResourcesBuildPhase',
    buildActionMask: 2_147_483_647,
    files: [{ value: 'info-plist', comment: 'InfoPlist.strings in Resources' }],
    runOnlyForDeploymentPostprocessing: 0,
  };
  const created = {
    isa: 'PBXResourcesBuildPhase',
    buildActionMask: 2_147_483_647,
    files: [{ value: 'localizable', comment: 'Localizable.strings in Resources' }],
    runOnlyForDeploymentPostprocessing: 0,
  };
  const resourcesPhases: Record<string, unknown> = {
    'existing-phase': existing,
    'existing-phase_comment': 'Resources',
    'created-phase': created,
    'created-phase_comment': 'Resources',
  };
  const target = {
    productType: '"com.apple.product-type.application"',
    buildPhases: [
      { value: 'sources-phase', comment: 'Sources' },
      { value: 'existing-phase', comment: 'Resources' },
      { value: 'created-phase', comment: 'Resources' },
    ],
  };
  return {
    created: { uuid: 'created-phase', buildPhase: created },
    existing,
    project: {
      // The properties the helper reads off the project expo's
      // `withXcodeProject` hands a mod: `pbxNativeTargetSection()` and the
      // PBX sections in the project hash. There is no
      // `pbxResourcesBuildPhaseSection()` on it.
      hash: { project: { objects: { PBXResourcesBuildPhase: resourcesPhases } } },
      pbxNativeTargetSection: () => ({
        'app-target': target,
        'app-target_comment': 'Kilo',
      }),
    },
    resourcesPhases,
    target,
  };
}

describe('the four App Intents', () => {
  it.each(APP_ACTION_IDS)('declares the %s intent', action => {
    expect(intents).toContain(`struct ${INTENT_TYPES[action]}: AppIntent {`);
  });

  it('spells every label the plugin translates as a literal', () => {
    // App Intents metadata is extracted from these sources at build time, and
    // `appintentsmetadataprocessor` halts the target for anything but a literal
    // — the ios job failed with "'LocalizedStringResource' must be initialized
    // with a call to its initializer or a string literal" — so the copy cannot
    // live behind a shared table. Every literal here is a key the plugin's
    // `Localizable.strings` carries.
    const labels = intents.split('\n').filter(line => LABEL_LINE.test(line));
    // Four titles, four shortcut titles, the failure copy, and five parameters:
    // one per action plus the session `StartAgent` takes as well — and, beside
    // that, the named-session action's own title and its entity parameter.
    expect(labels).toHaveLength(APP_ACTION_IDS.length * 3 + 4);
    const copy = new Set(Object.values(ENGLISH_COPY));
    for (const line of labels) {
      const literal = /"([^"]+)"/.exec(line)?.[1];
      expect(literal, `${line.trim()} is not a literal label`).toBeDefined();
      expect(copy.has(literal ?? ''), `${literal} is not copy the plugin renders`).toBe(true);
    }
  });

  it('declares no OS surface beyond the provider', () => {
    expect(intents).not.toContain('SiriTipView');
    expect(intents).not.toMatch(/donat/i);
    expect(intents).not.toContain('INIntent');
  });

  it('opens the app for every action', () => {
    for (const action of APP_ACTION_IDS) {
      expect(openAppWhenRun(swiftStruct(INTENT_TYPES[action])), `${action} must open the app`).toBe(
        'true'
      );
    }
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
    expect(literals).toHaveLength(URL_ACTIONS.length);
    expect(new Set(literals).size).toBe(URL_ACTIONS.length);
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

describe('the session entity catalog', () => {
  const entity = readSource('AppIntents/KiloSessionEntity.swift');
  const catalog = readSource('KiloSessionCatalog.swift');
  const visible = readSource('AppIntents/KiloVisibleSession.swift');
  const module = readSource('KiloAppActionsModule.swift');

  it('resolves a session by id, by list, and by title', () => {
    expect(entity).toContain('struct KiloSessionEntity: AppEntity {');
    expect(entity).toContain('struct KiloSessionEntityQuery: EntityQuery, EntityStringQuery {');
    // `EntityQuery` draws the picker and resolves a saved value; the string
    // query is what lets Siri match a spoken title. Both are required, and a
    // plain `EntityQuery` is not enough.
    expect(entity).toContain('func entities(for identifiers: [String]) async throws');
    expect(entity).toContain('func suggestedEntities() async throws');
    expect(entity).toContain('func entities(matching string: String) async throws');
  });

  it('never answers an ambiguous name with one arbitrary session', () => {
    // The query returns every match, so the system asks. An exact title narrows
    // to that title's rows rather than picking the first of a containment set.
    expect(entity).toContain('let exact = entries.filter');
    expect(entity).toContain(': exact');
  });

  it('stores only the two fields the picker needs', () => {
    const entry = swiftBlock(catalog, 'struct KiloSessionCatalogEntry:');
    expect(entry.match(/\blet \w+: String/g)).toHaveLength(2);
    expect(entry).toContain('let id: String');
    expect(entry).toContain('let title: String');
  });

  it('keeps the catalog to the same bound the collector applies', () => {
    expect(catalog).toContain('static let maxEntries = 50');
    expect(collectorSource).toContain('const SESSION_CATALOG_MAX_ENTRIES = 50;');
    expect(collectorSource).toContain('.slice(0, SESSION_CATALOG_MAX_ENTRIES)');
  });

  it('names the functions and the entries key the JS bridge uses', () => {
    // One name per call, spelled the same on both sides: the JS wrapper is the
    // only caller, and a rename on either side has to fail here rather than at
    // run time on a device.
    for (const name of [
      'replaceSessionCatalog',
      'clearSessionCatalog',
      'setSessionCatalogLock',
      'setSessionCatalogVisible',
      'setVisibleSession',
    ]) {
      expect(module, `${name} is not exported`).toContain(`func ${name}(`);
      expect(jsBridgeSource, `${name} is not called`).toContain(`${name}?:`);
    }
    expect(catalog).toContain('"kilo-app-actions-session-catalog"');
  });

  it('keeps every title out of the answers the lock covers', () => {
    // The entity queries answer Siri and Shortcuts from a launch the lock
    // surface never draws on, so the store decides: this process starts closed,
    // opens when the app says it is unlocked, and closes again once the app has
    // been in the background past the interval the lock allows. Nothing is
    // wiped on those edges — the account boundaries own that — because a run
    // the system starts still has to resolve the session a saved shortcut
    // names.
    expect(catalog).toContain('guard defaults.bool(forKey: lockEnabledKey)');
    expect(catalog).toContain('guard visibility.isVisible else');
    expect(catalog).toContain('UIApplication.didEnterBackgroundNotification');
    expect(catalog).toContain('UIApplication.didBecomeActiveNotification');
    expect(catalog).toContain('static func setVisible(');
    expect(module).toContain('func setSessionCatalogVisible(visible: Bool)');
    // The switch and the interval arrive together, and turning the lock off
    // drops the window with them.
    expect(module).toContain('func setSessionCatalogLock(enabled: Bool, intervalMs: Double)');
    expect(catalog).toContain('defaults.removeObject(forKey: backgroundedAtKey)');
    // Visibility is this process's, never the stored one: a persisted `true`
    // would open the window a fresh launch has to keep closed.
    expect(catalog).not.toContain('set(visible, forKey:');

    const mountSource = readFileSync(
      fileURLToPath(new URL('../../src/lib/system-search-index-mount.tsx', import.meta.url)),
      'utf8'
    );
    // The mount hides and shows, and never wipes, on the lock's edges.
    expect(mountSource).toContain("setSessionCatalogVisibleBestEffort(status === 'unlocked')");
    expect(mountSource).toContain('setSessionCatalogLockBestEffort(enabled, BACKGROUND_LOCK_MS)');
    expect(mountSource).not.toContain('clearSessionCatalogBestEffort');
    // The interval has one source: the lock provider the app itself applies.
    const lockSource = readFileSync(
      fileURLToPath(new URL('../../src/lib/app-unlock-context.tsx', import.meta.url)),
      'utf8'
    );
    expect(lockSource).toContain('export const BACKGROUND_LOCK_MS');
  });

  it('keeps the entity inside the deployment target the app builds for', () => {
    // The app target builds for a floor below iOS 18, so the entity cannot
    // declare a `@Property`: its synthesized `init()` needs a newer runtime and
    // the whole target fails to compile.
    expect(entity).not.toContain('@Property');
    expect(entity).toContain('let id: String');
    expect(entity).toContain('let title: String');
    // A stored session is rebuilt by its identifier, so the query has to answer
    // for identifiers as well as for titles.
    expect(entity).toContain('func entities(for identifiers: [String])');
    expect(entity).toContain('func suggestedEntities()');
    expect(entity).toContain('func entities(matching string: String)');
    // The identity lookup goes to the identifier resolver, so a run a person
    // already configured still resolves while the lock withholds the list.
    expect(entity).toContain('KiloSessionCatalogStore.entries(forIdentifiers: identifiers)');
    expect(entity).not.toContain('let wanted = Set(identifiers)');
    // Listing and spoken matching stay behind the lock.
    expect(entity).toContain(
      'KiloSessionCatalogStore.entries().map(KiloSessionEntity.init(entry:))'
    );
    // The resolver hands back the session without its title while withheld.
    expect(catalog).toContain('static func entries(forIdentifiers identifiers: [String])');
    expect(catalog).toContain('let withheld = isWithheld()');
    expect(catalog).toContain('KiloSessionCatalogEntry(id: $0.id, title: "")');
  });

  it('guards the on-screen cue behind the iOS 18.2 runtime', () => {
    // `NSUserActivity.appEntityIdentifier` starts at iOS 18.2. The app's floor
    // is 16.4, so the publisher must return without touching the property and
    // every older action keeps running.
    expect(visible).toContain('guard #available(iOS 18.2, *) else {');
    expect(visible).toContain('activity.appEntityIdentifier = EntityIdentifier(');
  });

  it('declares the new intent without a new slug or a new provider entry', () => {
    const intent = swiftStruct('OpenNamedSessionIntent');
    expect(intent).toContain('@Parameter(title: "Session")');
    expect(intent).toContain('var session: KiloSessionEntity');
    expect(intent).toContain('KiloAppActionTarget.openSession');
    expect(intent).not.toContain('kiloapp:///');
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

  it('hands the Focus-filter catalog to that single app-target writer', () => {
    // The app target has exactly one `<tag>.lproj/Localizable.strings`. The
    // Focus-filter copy travels to the App Intent plugin with
    // `additionalStrings`; declaring it for Expo's `withLocales` too (the
    // `ios['Localizable.strings']` key) registers a second copy of the same
    // bundle file and the ios job fails with "Multiple commands produce".
    // The fork is the capability: `.lproj/Localizable.strings` is an Xcode
    // bundle resource and the App Intent metadata that reads it is iOS-only.
    // Android's action surface (exported entry points plus
    // `res/xml/shortcuts.xml`) is held by `android-app-actions.test.ts`, so no
    // part of the user-visible behaviour is missing there.
    expect(configSource).toContain('additionalStrings: focusFilterCatalog');
    expect(configSource, 'a second Localizable.strings producer').not.toContain(
      "'Localizable.strings'"
    );
    expect(configSource).not.toContain('withFocusFilterLocalizations');
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

describe('the app-target Resources phase', () => {
  it('leaves the app target one Resources phase', () => {
    // Xcode keeps one per target: with a second it warns "target has multiple
    // Copy Bundle Resources build phases, which may cause it to build
    // incorrectly" and reports the app's generated asset symbols as
    // unprocessable. Both appeared only once this plugin ran.
    const { created, project, resourcesPhases, target } = projectAfterAddBuildPhase();
    mergeIntoResourcesPhase(project, 'app-target', created);

    const phases = target.buildPhases.filter(entry => entry.value in resourcesPhases);
    expect(phases.map(entry => entry.value)).toEqual(['existing-phase']);
    expect(Object.keys(resourcesPhases)).toEqual(['existing-phase', 'existing-phase_comment']);
  });

  it('moves the created members into the phase Expo already has', () => {
    const { created, existing, project } = projectAfterAddBuildPhase();
    mergeIntoResourcesPhase(project, 'app-target', created);

    expect(existing.files.map(file => file.value)).toEqual(['info-plist', 'localizable']);
  });

  it('runs that merge in the prebuild mod, after the phase is attached', () => {
    expect(pluginSource).toContain('mergeIntoResourcesPhase(project, targetUuid, phase);');
  });

  it('fails the prebuild when the app target has no Resources phase', () => {
    const { created, project, target } = projectAfterAddBuildPhase();
    target.buildPhases = [{ value: 'sources-phase', comment: 'Sources' }];
    expect(() => {
      mergeIntoResourcesPhase(project, 'app-target', created);
    }).toThrow(/no Resources phase to extend/);
  });
});

// The intents compile in the app target and the pod excludes their directory:
// a Swift file the plugin does not copy is compiled by neither target and
// nothing fails. The set is the directory's own, so these checks pin the
// derivation, both mods that consume it, and the AppDelegate edit.

const INTENTS_PLUGIN = readFileSync(
  fileURLToPath(new URL('../../plugins/withKiloAppIntents.js', import.meta.url)),
  'utf8'
);

/** The directory the app target compiles, relative to the project root. */
const APP_TARGET_PATH = join('modules', 'kilo-app-actions', 'ios', 'AppIntents');

/** A generated `AppDelegate` in the shape the App Intents plugin edits. */
const APP_DELEGATE = `import ExpoModulesCore
import KiloAppActions

@main
class AppDelegate: ExpoAppDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
`;

/** A generated `AppDelegate` still carrying the declaration this plugin retired. */
const APP_DELEGATE_WITH_RETIRED_PACKAGE = `import AppIntents
import ExpoModulesCore

@available(iOS 17.0, *)
struct KiloAppIntentsPackage: AppIntentsPackage {
  static var includedPackages: [any AppIntentsPackage.Type] {
    []
  }
}

@main
class AppDelegate: ExpoAppDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
`;

describe('the app-target source set', () => {
  it('reads every Swift file in the directory, and nothing else', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'kilo-app-intents-'));
    const directory = join(projectRoot, APP_TARGET_PATH);
    mkdirSync(directory, { recursive: true });
    for (const name of ['KiloSecond.swift', 'KiloFirst.swift', 'notes.md']) {
      writeFileSync(join(directory, name), '');
    }

    expect(sourceFiles(projectRoot)).toEqual(['KiloFirst.swift', 'KiloSecond.swift']);
  });

  it('holds every Swift file in the intents directory', () => {
    const onDisk = readdirSync(new URL('ios/AppIntents/', import.meta.url))
      .filter(name => name.endsWith('.swift'))
      .sort();

    expect(sourceFiles(fileURLToPath(new URL('../../', import.meta.url)))).toEqual(onDisk);
  });

  it('compiles that set in both prebuild mods', () => {
    // A hand-kept list here would skip a new file silently; the copy mod and
    // the Sources phase mod must both read the directory.
    expect(INTENTS_PLUGIN).not.toContain('SOURCE_FILES');
    expect(INTENTS_PLUGIN.match(/sourceFiles\(cfg\.modRequest\.projectRoot\)/g)).toHaveLength(2);
  });

  it('registers the plugin that compiles them in app.config.ts', () => {
    expect(configSource).toContain("'./plugins/withKiloAppIntents'");
  });

  it('keeps the intents out of the pod, which has no bundle for them', () => {
    const podspec = readSource('KiloAppActions.podspec');
    expect(podspec).toContain("s.exclude_files = '**/AppIntents/**/*'");

    for (const name of readdirSync(iosModuleDirectory).filter(entry => entry.endsWith('.swift'))) {
      const source = readSource(name);
      expect(
        source,
        `${name} declares an App Intents type and must live in ios/AppIntents`
      ).not.toMatch(
        /: AppIntent \{|: AppEntity \{|: AppShortcutsProvider \{|: (EntityQuery|EntityStringQuery)\b/
      );
    }
  });
});

describe('the app-target publisher install', () => {
  it('starts the visible-session publisher before React', () => {
    const lines = installPublisher(APP_DELEGATE).split('\n');
    const install = lines.findIndex(line => line.includes('KiloVisibleSessionBridge.install'));
    const react = lines.findIndex(line => line.includes('let delegate = ReactNativeDelegate()'));

    expect(install).toBeGreaterThanOrEqual(0);
    expect(install).toBeLessThan(react);
    expect(lines[install]).toContain('KiloVisibleSession.publish)');
  });

  it('imports the module internally, so the app target reaches the bridge', () => {
    const source = installPublisher(APP_DELEGATE);

    expect(source).toContain('internal import KiloAppActions');
    expect(source).not.toMatch(/^import KiloAppActions$/m);
  });

  it('is idempotent', () => {
    const installed = installPublisher(APP_DELEGATE);
    expect(installPublisher(installed)).toBe(installed);
  });

  it('drops the retired package declaration and its import together', () => {
    const installed = installPublisher(APP_DELEGATE_WITH_RETIRED_PACKAGE);

    expect(installed).not.toContain('KiloAppIntentsPackage');
    expect(installed).not.toMatch(/^import AppIntents$/m);
    expect(installed).toContain('import ExpoModulesCore');
  });

  it('fails a prebuild whose AppDelegate has no ReactNativeDelegate initialization', () => {
    expect(() => installPublisher('class AppDelegate {}\n')).toThrow(/ReactNativeDelegate/);
  });
});
