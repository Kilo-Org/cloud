import { IOSConfig } from 'expo/config-plugins';
import { vi } from 'vitest';

import withAgentControls from '../../plugins/withAgentControls';
import { targetSourcesBuildPhases } from './agent-controls';

/** The extension expo-widgets generates and the Swift file the plugin attaches. */
export const TARGET_UUID = 'target-controls';
export const TARGET_NAME = 'ExpoWidgetsTarget';
export const SWIFT_FILE = 'AgentControls.swift';

// The project shape the xcode library hands the mod: the phase objects live in
// `hash.project.objects.PBXSourcesBuildPhase` and the target references them by
// uuid. `addBuildPhase` is the xcode library's always-appends-a-new-phase call —
// the one that put a second `Sources` phase on the target and failed the whole
// build at plan time.
export function widgetTargetProject(phaseCount: number) {
  const phases: Record<string, { files: { value: string; comment: string }[] }> = {};
  const buildPhases: { value: string; comment: string }[] = [];
  const buildFiles: Record<string, unknown> = {};
  for (let index = 0; index < phaseCount; index += 1) {
    const uuid = `phase-sources-${index}`;
    const buildFile = `bf-index-${index}`;
    // Every phase entry resolves to a `PBXBuildFile` object, the way the xcode
    // library writes one — an entry without one is the dangling reference the
    // plugin's phase proof rejects.
    buildFiles[buildFile] = {};
    phases[uuid] = { files: [{ value: buildFile, comment: 'index.swift in Sources' }] };
    buildPhases.push({ value: uuid, comment: 'Sources' });
  }
  buildPhases.push({ value: 'phase-frameworks', comment: 'Frameworks' });
  return {
    hash: { project: { objects: { PBXSourcesBuildPhase: phases, PBXBuildFile: buildFiles } } },
    pbxNativeTargetSection: () => ({ [TARGET_UUID]: { name: TARGET_NAME, buildPhases } }),
    addBuildPhase: vi.fn(),
  };
}

/** Run the plugin's xcodeproj mod against `project`, the way prebuild does. */
export async function runControlsXcodeMod(
  project: ReturnType<typeof widgetTargetProject>
): Promise<void> {
  // `withXcodeProject` files its callback under `mods.ios.xcodeproj`; the
  // plugin's return type is `ExpoConfig`, which does not carry the mods the
  // compiler runs later.
  const config = withAgentControls({ name: 'Kilo' }) as unknown as {
    mods: { ios: { xcodeproj: (modConfig: Record<string, unknown>) => Promise<unknown> } };
  };
  await config.mods.ios.xcodeproj({
    modRequest: { platformProjectRoot: '/tmp/ios' },
    modResults: project,
  });
}

/**
 * Mock the attach helper: each call appends `times` `AgentControls.swift in
 * Sources` entries to the target's Sources phase — the doubled attach the
 * uniqueness assert exists to catch.
 */
export function attachMock(project: ReturnType<typeof widgetTargetProject>, times: number) {
  return vi.spyOn(IOSConfig.XcodeUtils, 'addBuildSourceFileToGroup').mockImplementation(() => {
    const files = targetSourcesBuildPhases(project, TARGET_UUID)[0]?.files;
    for (let index = 0; index < times; index += 1) {
      const uuid = `bf-controls-${index}`;
      project.hash.project.objects.PBXBuildFile[uuid] = {};
      files?.push({ value: uuid, comment: `${SWIFT_FILE} in Sources` });
    }
    return project as never;
  });
}
