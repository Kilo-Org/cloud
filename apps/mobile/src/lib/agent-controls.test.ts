import { resolveIncomingUrl } from '@kilocode/app-shared/universal-links';
import { IOSConfig } from 'expo/config-plugins';
import { afterEach, describe, expect, it, vi } from 'vitest';

import agentControlsCopy from '../../plugins/agent-controls-copy.json';
import { SUPPORTED_LANGUAGES } from '@/i18n/languages';
import {
  AGENT_CONTROLS,
  AGENT_CONTROLS_BUNDLE_CALL,
  AGENT_SHORTCUTS_META_DATA,
  AGENT_SHORTCUTS_RESOURCE,
  agentControlsSwift,
  agentShortcutStrings,
  agentShortcutsXml,
  injectAgentControlBundle,
  sourceFileEntryCount,
  targetSourcesBuildPhases,
} from './agent-controls';
import {
  attachMock,
  runControlsXcodeMod,
  SWIFT_FILE,
  TARGET_NAME,
  TARGET_UUID,
  widgetTargetProject,
} from './agent-controls.test-helpers';

// The extension's bundle copy, one object per language tag. The English values
// are the keys Swift binds, so they are what the generated code must carry.
const copy: Record<string, Record<string, string>> = agentControlsCopy;

/** Every copy key the generated Swift binds: the label and its description. */
const boundCopyKeys = AGENT_SHORTCUTS_META_DATA.flatMap(metadata => [
  metadata.copyKey,
  metadata.descriptionCopyKey,
]);

function copyValue(tag: string, key: string): string {
  const value = copy[tag]?.[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`the control copy is missing \`${tag}.${key}\``);
  }
  return value;
}

function generatedSwift(): string {
  return agentControlsSwift({ copy, urls: AGENT_CONTROLS });
}

/** Every `kiloapp://` url the source spells, in order. */
function foundUrls(source: string): string[] {
  return source.match(/kiloapp:\/\/[^"'\s<]*/g) ?? [];
}

describe('AGENT_CONTROLS', () => {
  it('names exactly the two controls the request asks for', () => {
    expect(AGENT_CONTROLS.map(control => control.id)).toEqual(['new-agent', 'waiting-agent']);
    expect(AGENT_CONTROLS.map(control => control.copyKey)).toEqual([
      'newAgent',
      'openWaitingAgent',
    ]);
    expect(new Set(AGENT_CONTROLS.map(control => control.url)).size).toBe(AGENT_CONTROLS.length);
  });

  it('uses the app’s existing glanceable url form', () => {
    for (const control of AGENT_CONTROLS) {
      expect(control.url.startsWith('kiloapp:///cloud/sessions/'), control.id).toBe(true);
    }
  });

  // The controls never re-implement an action: the app's universal-link table
  // turns each url into the route that already owns the behaviour, so the
  // contract cannot drift from the routing table without failing here.
  it('resolves every url through the universal-link table', () => {
    const expectedRoutes = new Map([
      ['new-agent', '/(app)/agent-chat/new'],
      ['waiting-agent', '/(app)/agent-chat/waiting'],
    ]);
    for (const control of AGENT_CONTROLS) {
      const expected = expectedRoutes.get(control.id);
      expect(expected, `no expected route for ${control.id}`).toBeDefined();
      expect(resolveIncomingUrl(control.url), control.id).toBe(expected);
    }
  });
});

describe('the generated control surfaces', () => {
  const contractUrls = AGENT_CONTROLS.map(control => control.url);

  // Mirrors app.config.ts's `android.package`; the launcher activity is its
  // `.MainActivity`. A change there must update this and the plugin together.
  const androidTarget = {
    targetPackage: 'com.kilocode.kiloapp',
    targetClass: 'com.kilocode.kiloapp.MainActivity',
  };

  // One definition, two surfaces: each generator renders every contract url
  // exactly once and may not spell a url of its own.
  function expectOnlyContractUrls(source: string): void {
    expect(foundUrls(source).toSorted()).toEqual(contractUrls.toSorted());
  }

  it('the Swift carries every contract url exactly once, and no other', () => {
    expectOnlyContractUrls(generatedSwift());
  });

  it('the Android static-shortcut XML carries every contract url exactly once, and no other', () => {
    expectOnlyContractUrls(agentShortcutsXml({ urls: AGENT_CONTROLS, ...androidTarget }));
  });

  it('the Android static-shortcut XML names the resource file, the app target, and the labels', () => {
    const xml = agentShortcutsXml({ urls: AGENT_CONTROLS, ...androidTarget });
    for (const url of contractUrls) {
      expect(xml).toContain(`android:data="${url}"`);
    }
    // The labels the plugin must define as string resources, short and long.
    expect(AGENT_SHORTCUTS_META_DATA.map(metadata => metadata.shortLabelResource)).toEqual([
      'kilo_shortcut_new_agent_short',
      'kilo_shortcut_open_waiting_agent_short',
    ]);
    // The static shortcut ids the launcher matches, and the id
    // scripts/assert-agent-shortcuts.mjs reads out of the generated tree.
    expect(AGENT_SHORTCUTS_META_DATA.map(metadata => metadata.shortcutId)).toEqual([
      'kilo_agent_shortcuts_new_agent',
      'kilo_agent_shortcuts_waiting_agent',
    ]);
    for (const metadata of AGENT_SHORTCUTS_META_DATA) {
      expect(xml).toContain(`@string/${metadata.shortLabelResource}`);
      expect(xml).toContain(`@string/${metadata.longLabelResource}`);
    }
    // One VIEW intent per shortcut, aimed at the app's own launcher activity.
    expect(xml.match(/<intent\b/g)).toHaveLength(AGENT_CONTROLS.length);
    expect(xml.match(/android.intent.action.VIEW/g)).toHaveLength(AGENT_CONTROLS.length);
    expect(xml).toContain(`android:targetPackage="${androidTarget.targetPackage}"`);
    expect(xml).toContain(`android:targetClass="${androidTarget.targetClass}"`);
    // The resource file the manifest's `android.app.shortcuts` meta-data points at.
    expect(xml).toContain(AGENT_SHORTCUTS_RESOURCE);
    // The launcher falls back to the app icon: no drawable asset is added.
    expect(xml).not.toContain('android:icon');
  });

  it('the Swift declares an intent and a control per entry, plus the bundle', () => {
    const swift = generatedSwift();
    expect(swift).toContain('import AppIntents');
    expect(swift).toContain('ControlWidgetButton(action: AgentNewAgentIntent())');
    expect(swift).toContain('ControlWidgetButton(action: AgentWaitingAgentIntent())');
    expect(swift).toContain('struct AgentControlsBundle: WidgetBundle');
    // AppIntents' OpenURLIntent is `init(_:)`; the labeled form does not exist
    // and fails the widget extension compile ("extraneous argument label
    // 'url:' in call"), which fails the whole iOS build.
    expect(swift).toContain('opensIntent: OpenURLIntent(URL(string:');
    expect(swift).not.toContain('OpenURLIntent(url:');
  });

  it('the Swift binds the English copy as the .strings keys', () => {
    const swift = generatedSwift();
    for (const key of boundCopyKeys) {
      expect(swift, key).toContain(copyValue('en', key));
    }
  });
});

describe('injectAgentControlBundle', () => {
  const template = [
    '@main',
    'struct ExportWidgets0: WidgetBundle {',
    '  var body: some Widget {',
    '    ActiveAgentsWidget()',
    '    WidgetLiveActivity()',
    '  }',
    '}',
  ].join('\n');

  it('splices the control bundle into the generated body', () => {
    const injected = injectAgentControlBundle(template);
    const bodyStart = injected.indexOf('var body: some Widget {');
    const callAt = injected.indexOf(AGENT_CONTROLS_BUNDLE_CALL);
    expect(callAt, 'the bundle call is missing').toBeGreaterThan(bodyStart);
    // Inside the body, not after it.
    expect(callAt).toBeLessThan(injected.indexOf('ActiveAgentsWidget()'));
    expect(injected).toContain('if #available(iOS 18.0, *) {');
    // The generated widgets survive the splice untouched.
    expect(injected).toContain('ActiveAgentsWidget()');
    expect(injected).toContain('WidgetLiveActivity()');
    expect(injected.replace(AGENT_CONTROLS_BUNDLE_CALL, '')).toContain('var body: some Widget');
  });

  it('throws a named error when the anchor is missing', () => {
    expect(() => injectAgentControlBundle('struct X {}\n')).toThrow(/injectAgentControlBundle/);
    expect(() => injectAgentControlBundle('')).toThrow(/injectAgentControlBundle/);
  });
});

describe('targetSourcesBuildPhases', () => {
  // The defect this guards: the controls plugin appended a second `Sources`
  // build phase to the widget extension, and XCBuild rejects a target with two
  // phases of the same name — "Unexpected duplicate tasks" — before it compiles
  // anything. The selector must therefore see every phase the target carries,
  // so a duplicate cannot hide behind the first match.
  it('reads every Sources phase the target carries and skips other phases', () => {
    const indexPhase = { files: [{ value: 'bf-index', comment: 'index.swift in Sources' }] };
    const controlsPhase = {
      files: [{ value: 'bf-controls', comment: 'AgentControls.swift in Sources' }],
    };
    const project = {
      hash: {
        project: {
          objects: {
            PBXSourcesBuildPhase: {
              'phase-index': indexPhase,
              'phase-controls': controlsPhase,
            },
          },
        },
      },
      pbxNativeTargetSection: () => ({
        target: {
          name: 'ExpoWidgetsTarget',
          buildPhases: [
            { value: 'phase-index', comment: 'Sources' },
            { value: 'phase-frameworks', comment: 'Frameworks' },
            { value: 'phase-controls', comment: 'Sources' },
          ],
        },
      }),
    };
    expect(targetSourcesBuildPhases(project, 'target')).toEqual([indexPhase, controlsPhase]);
  });

  it('returns nothing for a target with no Sources phase', () => {
    const project = {
      hash: { project: { objects: { PBXSourcesBuildPhase: {} } } },
      pbxNativeTargetSection: () => ({
        target: { name: 'ExpoWidgetsTarget', buildPhases: [{ value: 'phase-frameworks' }] },
      }),
    };
    expect(targetSourcesBuildPhases(project, 'target')).toEqual([]);
  });
});

describe('withAgentControls — the widget target carries one Compile Sources phase', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('joins the phase expo-widgets created instead of appending a second one', async () => {
    const project = widgetTargetProject(1);
    const attach = attachMock(project, 1);

    await runControlsXcodeMod(project);

    expect(project.addBuildPhase).not.toHaveBeenCalled();
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith({
      filepath: SWIFT_FILE,
      groupName: TARGET_NAME,
      project,
      targetUuid: TARGET_UUID,
    });
    const phases = targetSourcesBuildPhases(project, TARGET_UUID);
    expect(phases).toHaveLength(1);
    expect(phases[0]?.files.map(file => file.comment)).toEqual([
      'index.swift in Sources',
      `${SWIFT_FILE} in Sources`,
    ]);
  });

  it('names the duplicate-phase failure instead of adding a third phase', async () => {
    const project = widgetTargetProject(2);
    await expect(runControlsXcodeMod(project)).rejects.toThrow(/2 Sources build phases/);
    expect(project.addBuildPhase).not.toHaveBeenCalled();
  });

  // Idempotency: the next prebuild must not be able to reintroduce a duplicate.
  it('leaves one entry and attaches once when the mod runs twice', async () => {
    const project = widgetTargetProject(1);
    const attach = attachMock(project, 1);

    await runControlsXcodeMod(project);
    await runControlsXcodeMod(project);

    expect(attach).toHaveBeenCalledTimes(1);
    const phases = targetSourcesBuildPhases(project, TARGET_UUID);
    expect(phases).toHaveLength(1);
    expect(sourceFileEntryCount(phases[0], SWIFT_FILE)).toBe(1);
  });

  // Self-heal: a staler run doubled the entry; this one keeps the first and
  // drops the surplus, `PBXBuildFile` object included, without attaching a third.
  it('drops a doubled entry and its PBXBuildFile instead of attaching a third', async () => {
    const project = widgetTargetProject(1);
    project.hash.project.objects.PBXBuildFile['bf-controls-0'] = {};
    project.hash.project.objects.PBXBuildFile['bf-controls-1'] = {};
    targetSourcesBuildPhases(project, TARGET_UUID)[0]?.files.push(
      { value: 'bf-controls-0', comment: `${SWIFT_FILE} in Sources` },
      { value: 'bf-controls-1', comment: `${SWIFT_FILE} in Sources` }
    );
    const attach = vi.spyOn(IOSConfig.XcodeUtils, 'addBuildSourceFileToGroup');

    await runControlsXcodeMod(project);

    expect(attach).not.toHaveBeenCalled();
    const phases = targetSourcesBuildPhases(project, TARGET_UUID);
    expect(sourceFileEntryCount(phases[0], SWIFT_FILE)).toBe(1);
    expect(project.hash.project.objects.PBXBuildFile['bf-controls-1']).toBeUndefined();
  });

  // The guard the amendment asks for: uniqueness, not presence. An attach that
  // doubles the entry must fail the prebuild, not reach XCBuild.
  it('rejects when the attach helper appends a second entry', async () => {
    const project = widgetTargetProject(1);
    const attach = attachMock(project, 2);

    await expect(runControlsXcodeMod(project)).rejects.toThrow(/appears 2 times/);
    expect(attach).toHaveBeenCalledTimes(1);
  });
});

describe('agent-controls-copy.json', () => {
  it('covers every supported language and nothing else', () => {
    expect(Object.keys(copy).toSorted()).toEqual(SUPPORTED_LANGUAGES.toSorted());
  });

  it('pins the English labels the device scenes tap', () => {
    // The Control Center / Lock Screen / launcher scenes step on these strings; a
    // mismatch makes the waiting control unfindable and the proof unexecutable.
    expect(copyValue('en', 'newAgent')).toBe('New Agent');
    expect(copyValue('en', 'openWaitingAgent')).toBe('Open Waiting Agent');
  });

  it('covers every copy key the Swift binds, in every language', () => {
    for (const tag of SUPPORTED_LANGUAGES) {
      for (const key of boundCopyKeys) {
        // copyValue throws on a missing or empty value, which fails the test.
        expect(copyValue(tag, key), `${tag}.${key}`).toBeTruthy();
      }
    }
  });

  it('expands to .strings pairs keyed by the English copy the Swift binds', () => {
    const pairs = agentShortcutStrings(copy);
    const swift = generatedSwift();
    for (const tag of SUPPORTED_LANGUAGES) {
      const expected = AGENT_SHORTCUTS_META_DATA.flatMap(metadata => [
        [copyValue('en', metadata.copyKey), copyValue(tag, metadata.copyKey)],
        [copyValue('en', metadata.descriptionCopyKey), copyValue(tag, metadata.descriptionCopyKey)],
      ]);
      const languagePairs = pairs[tag] ?? [];
      expect(languagePairs, tag).toEqual(expected);
      for (const [key] of languagePairs) {
        expect(swift, key).toContain(key);
      }
    }
  });
});
