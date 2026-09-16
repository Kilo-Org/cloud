import { resolveIncomingUrl } from '@kilocode/app-shared/universal-links';
import { describe, expect, it } from 'vitest';

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
} from './agent-controls';

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
    expect(swift).toContain('OpenURLIntent(url: URL(string:');
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

describe('agent-controls-copy.json', () => {
  it('covers every supported language and nothing else', () => {
    expect(Object.keys(copy).toSorted()).toEqual(SUPPORTED_LANGUAGES.toSorted());
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
