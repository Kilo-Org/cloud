import { describe, expect, it } from 'vitest';

import APP_INTENT_COPY from '../../plugins/app-intent-copy.json';
import {
  assertIntentCopy,
  INTENT_COPY_KEYS,
  missingIntentCopyKeys,
  renderLocalizableStrings,
} from '../../plugins/app-intent-copy.js';
import { mergeIntoResourcesPhase } from '../../plugins/app-intent-resources.js';
import { SUPPORTED_LANGUAGES } from '../../src/i18n/languages';

/** The English copy, which is both the `.strings` key and the fallback. */
const ENGLISH_COPY = APP_INTENT_COPY.en;

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

describe('the App Intent copy', () => {
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

  it('fails the prebuild when the app target has no Resources phase', () => {
    const { created, project, target } = projectAfterAddBuildPhase();
    target.buildPhases = [{ value: 'sources-phase', comment: 'Sources' }];
    expect(() => {
      mergeIntoResourcesPhase(project, 'app-target', created);
    }).toThrow(/no Resources phase to extend/);
  });
});
