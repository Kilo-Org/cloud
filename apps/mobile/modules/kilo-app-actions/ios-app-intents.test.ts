// The App Intents compile in the app target, not in the static pod: the pod
// has no bundle for the system to load intents metadata from, so
// `plugins/withKiloAppIntents` copies every Swift file in `ios/AppIntents` into
// the generated application target and the podspec excludes that directory.
//
// The native module is not built on this host, so this suite reads the same
// file set the app target compiles — derived from the directory, never a hand
// list — and checks the contracts between the sources, the JS grammar and the
// copy the plugin renders.

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

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const POD_DIRECTORY = new URL('ios/', import.meta.url);
const INTENTS_DIRECTORY = new URL('ios/AppIntents/', import.meta.url);

/** The directory the plugin compiles, relative to the project root. */
const APP_TARGET_PATH = join('modules', 'kilo-app-actions', 'ios', 'AppIntents');

/** The app-target set, read by the plugin's own directory listing. */
const COPIED_FILES: string[] = sourceFiles(PROJECT_ROOT);

/** One file the app target compiles, with the name failure messages cite. */
type CopiedSource = { name: string; source: string };

const COPIED: CopiedSource[] = COPIED_FILES.map(name => ({
  name,
  source: readFileSync(new URL(name, INTENTS_DIRECTORY), 'utf8'),
}));

function copiedSource(name: string): string {
  const found = COPIED.find(entry => entry.name === name);
  if (found === undefined) {
    throw new Error(`${name} is not in the app-target set: ${COPIED_FILES.join(', ')}`);
  }
  return found.source;
}

const intents = copiedSource('KiloAppIntents.swift');
const configSource = readFileSync(new URL('../../app.config.ts', import.meta.url), 'utf8');
const localizationPluginSource = readFileSync(
  new URL('../../plugins/withAppIntentLocalizations.js', import.meta.url),
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
  /static var title: LocalizedStringResource|@Parameter\(title:|shortTitle:|String\(localized:|typeDisplayRepresentation:/;

/** A `LocalizedStringResource` the metadata processor accepts: a literal or an explicit literal init. */
const LITERAL_RESOURCE =
  /LocalizedStringResource = "[^"]*"|LocalizedStringResource\(stringLiteral:/;

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
    let factory = ExpoReactNativeFactory(delegate: delegate)
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

describe('the sources the app target compiles', () => {
  it('takes the set from the directory, not from a hand-kept list', () => {
    // The pod excludes `ios/AppIntents`, so a Swift file the plugin does not
    // copy is compiled by neither target and nothing fails. Every `.swift` file
    // in the directory must be in the set, and nothing else may be.
    const projectRoot = mkdtempSync(join(tmpdir(), 'kilo-app-intents-'));
    const directory = join(projectRoot, APP_TARGET_PATH);
    mkdirSync(directory, { recursive: true });
    for (const name of ['KiloSecond.swift', 'KiloFirst.swift', 'notes.md']) {
      writeFileSync(join(directory, name), '');
    }

    expect(sourceFiles(projectRoot)).toEqual(['KiloFirst.swift', 'KiloSecond.swift']);
  });

  it('holds every Swift file in the intents directory', () => {
    const onDisk = readdirSync(INTENTS_DIRECTORY)
      .filter(name => name.endsWith('.swift'))
      .sort();

    expect(COPIED_FILES).toEqual(onDisk);
  });

  it('keeps the intents out of the pod, which has no bundle for them', () => {
    // A second copy of these sources in the static pod is a duplicate-symbol
    // build failure at best and an unloadable intent at worst.
    const podspec = readFileSync(new URL('KiloAppActions.podspec', POD_DIRECTORY), 'utf8');
    expect(podspec).toContain("s.exclude_files = '**/AppIntents/**/*'");

    for (const name of readdirSync(POD_DIRECTORY).filter(entry => entry.endsWith('.swift'))) {
      const source = readFileSync(new URL(name, POD_DIRECTORY), 'utf8');
      expect(
        source,
        `${name} declares an App Intents type and must live in ios/AppIntents`
      ).not.toMatch(
        /: AppIntent \{|: AppEntity \{|: AppShortcutsProvider \{|: (EntityQuery|EntityStringQuery)\b/
      );
    }
  });
});

describe('the four App Intents', () => {
  it.each(APP_ACTION_IDS)('declares the %s intent', action => {
    expect(intents).toContain(`struct ${INTENT_TYPES[action]}: AppIntent {`);
  });

  it('opens the app for every action', () => {
    const declared = [...intents.matchAll(/struct (\w+): AppIntent \{/g)].map(match => match[1]);
    expect(declared).toEqual(expect.arrayContaining(Object.values(INTENT_TYPES)));
    for (const name of declared) {
      expect(openAppWhenRun(swiftStruct(name ?? '')), `${name} must open the app`).toBe('true');
    }
  });

  it('gates the title-based action to the runtime that has entity queries', () => {
    // Saved identifier-based shortcuts keep running on the older supported
    // runtimes, so the additive action carries the availability gate instead
    // of the whole file.
    expect(intents).toContain(
      '@available(iOS 17.0, *)\nstruct OpenNamedSessionIntent: AppIntent {'
    );
    expect(openAppWhenRun(swiftStruct('OpenNamedSessionIntent'))).toBe('true');
    expect(swiftStruct('OpenNamedSessionIntent')).toContain('var session: KiloSessionEntity');
  });

  it('keeps the title-based action out of the phrase provider', () => {
    // The four existing phrases stay exactly as they are: the action is listed
    // from the metadata Xcode extracts, so a phrase buys nothing and a change
    // to the provider would rewrite what people already say.
    const provider = swiftStruct('KiloAppShortcuts');
    expect(provider).not.toContain('OpenNamedSessionIntent');
    expect(provider.match(/AppShortcut\(/g)).toHaveLength(APP_ACTION_IDS.length);
    for (const action of APP_ACTION_IDS) {
      expect(provider).toContain(`intent: ${INTENT_TYPES[action]}()`);
    }
    // The provider requires a phrase per shortcut, and every phrase must carry
    // the app name. Nothing else is declared: no tips, no donations.
    expect(provider.match(/phrases: \[/g)).toHaveLength(APP_ACTION_IDS.length);
    expect(provider.match(/\\\(\.applicationName\)/g)).toHaveLength(APP_ACTION_IDS.length);
  });

  it('declares no OS surface beyond the provider', () => {
    for (const { name, source } of COPIED) {
      expect(source, `${name} tips the system`).not.toContain('SiriTipView');
      expect(source, `${name} donates to the system`).not.toMatch(/donat/i);
      expect(source, `${name} declares a legacy intent`).not.toContain('INIntent');
    }
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

  it('passes the picked entity through the same open-session target', () => {
    // The typed action adds a discovery surface, not a second dispatcher: the
    // entity resolves to an id and the id goes to the same URL.
    const body = swiftStruct('OpenNamedSessionIntent');
    expect(body).toContain('KiloAppActionTarget.openSession');
    expect(body).toContain('"sessionId": session.id');
  });
});

describe('the App Intent copy', () => {
  it('spells every label the plugin translates as a literal', () => {
    // App Intents metadata is extracted from these sources at build time, and
    // `appintentsmetadataprocessor` halts the target for anything but a literal
    // — the ios job failed with "'LocalizedStringResource' must be initialized
    // with a call to its initializer or a string literal" — so the copy cannot
    // live behind a shared table. Every literal here is a key the plugin's
    // `Localizable.strings` carries, and every key is spelled by a source.
    const labels = COPIED.flatMap(({ source }) =>
      source.split('\n').filter(line => LABEL_LINE.test(line))
    );
    for (const line of labels) {
      expect(line, `${line.trim()} is not a literal label`).toMatch(/"([^"]+)"/);
    }
    const literals = labels.map(line => /"([^"]+)"/.exec(line)?.[1]);

    expect(new Set(literals)).toEqual(new Set(Object.values(ENGLISH_COPY)));
  });

  it('initializes every localized resource from a literal', () => {
    for (const { name, source } of COPIED) {
      const resources = source
        .split('\n')
        .filter(line => line.includes('LocalizedStringResource'))
        .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line));
      for (const line of resources) {
        expect(line, `${name}: ${line.trim()}`).toMatch(LITERAL_RESOURCE);
      }
    }
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

describe('App Intent catalog validation', () => {
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

describe('the app-target publisher install', () => {
  it('starts the visible-session publisher before React', () => {
    const lines = installPublisher(APP_DELEGATE).split('\n');
    const install = lines.findIndex(line => line.includes('KiloVisibleSessionBridge.install'));
    const react = lines.findIndex(line => line.includes('let delegate = ReactNativeDelegate()'));

    expect(install).toBeGreaterThanOrEqual(0);
    expect(install).toBeLessThan(react);
    // The app delegate belongs to the app target, so it imports the pod's
    // module internally: the intent sources reach the publisher that way.
    expect(lines[install]).toContain('KiloVisibleSession.publish)');
    expect(installPublisher(APP_DELEGATE)).toContain('internal import KiloAppActions');
  });

  it('is idempotent', () => {
    const installed = installPublisher(APP_DELEGATE);
    expect(installPublisher(installed)).toBe(installed);
  });

  it('drops the retired package declaration and its import together', () => {
    const installed = installPublisher(APP_DELEGATE_WITH_RETIRED_PACKAGE);

    expect(installed).not.toContain('KiloAppIntentsPackage');
    expect(installed).not.toMatch(/^import AppIntents$/m);
    expect(installed).toContain('internal import KiloAppActions');
    expect(installed).toContain('import ExpoModulesCore');
  });

  it('fails a prebuild whose AppDelegate has no ReactNativeDelegate initialization', () => {
    expect(() => installPublisher('class AppDelegate {}\n')).toThrow(/ReactNativeDelegate/);
  });
});

describe('app.config.ts', () => {
  it('registers the plugin that compiles the intents in the app target', () => {
    expect(configSource).toContain("'./plugins/withKiloAppIntents'");
  });

  it('registers the app-target localizations with every supported language', () => {
    expect(configSource).toContain("from './plugins/app-intent-copy.json'");
    expect(configSource).toContain("'./plugins/withAppIntentLocalizations'");
    expect(configSource).toContain('languages: [...SUPPORTED_LANGUAGES]');
    expect(configSource).toContain('copy: APP_INTENT_COPY');
  });

  it('hands the Focus-filter catalog to that single app-target writer', () => {
    // The app target has exactly one `<tag>.lproj/Localizable.strings`. The
    // Focus-filter copy travels to the App Intent plugin with
    // `additionalStrings`; declaring it for Expo's `withLocales` too (the
    // `ios['Localizable.strings']` key) registers a second copy of the same
    // bundle file and the ios job fails with "Multiple commands produce".
    // The fork is the capability: `.lproj/Localizable.strings` is an Xcode
    // bundle resource and the App Intent metadata that reads it is iOS-only.
    expect(configSource).toContain('additionalStrings: focusFilterCatalog');
    expect(configSource, 'a second Localizable.strings producer').not.toContain(
      "'Localizable.strings'"
    );
    expect(configSource).not.toContain('withFocusFilterLocalizations');
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
    expect(localizationPluginSource).toContain(
      'mergeIntoResourcesPhase(project, targetUuid, phase);'
    );
  });

  it('fails the prebuild when the app target has no Resources phase', () => {
    const { created, project, target } = projectAfterAddBuildPhase();
    target.buildPhases = [{ value: 'sources-phase', comment: 'Sources' }];
    expect(() => {
      mergeIntoResourcesPhase(project, 'app-target', created);
    }).toThrow(/no Resources phase to extend/);
  });
});
