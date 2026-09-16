import { describe, expect, it, vi } from 'vitest';

import withWidgetLocalizations from '../../plugins/withWidgetLocalizations';

// The extension expo-widgets generates and the plugin that copies the widget
// gallery copy into its `.lproj` directories. `addBuildPhase` is the xcode
// library's append-only call: every run of the plugin adds a phase, so a
// `--no-clean` re-run over a project an earlier run wrote used to leave two
// `Resources` phases copying the same `.lproj` files. XCBuild then runs two
// tasks for one output and fails the whole extension with "Unexpected duplicate
// tasks" (the failure this slice repairs), so the plugin drops the phases the
// target carries before adding the one phase this run needs, and proves what it
// left behind. These tests exercise exactly that mod, with the same fake
// project shape the Sources-phase tests use.
const TARGET_NAME = 'ExpoWidgetsTarget';
const TARGET_UUID = 'target-widgets';

const LANGUAGES = ['en', 'ar'];
const COPY = {
  en: { displayName: 'Agents', description: 'See your agents' },
  ar: { displayName: 'الوكلاء', description: 'شاهد وكلاءك' },
};
/** The files the plugin copies, in the order the phase must carry them. */
const STRINGS_FILES = LANGUAGES.map(tag => `${TARGET_NAME}/${tag}.lproj/Localizable.strings`);

type Entry = { value?: string; comment?: string };
type Phase = { files: Entry[] };
type Target = { name: string; buildPhases: { value: string; comment: string }[] };
type FakeProject = {
  hash: {
    project: {
      objects: {
        PBXNativeTarget: Record<string, Target>;
        PBXResourcesBuildPhase: Record<string, Phase>;
        PBXBuildFile: Record<string, { fileRef?: string }>;
        PBXFileReference: Record<string, { path: string }>;
      };
    };
  };
  pbxNativeTargetSection: () => Record<string, Target>;
  addBuildPhase: ReturnType<typeof vi.fn>;
};

/**
 * The widget target as the xcode library hands it to the mod. `phaseCount`
 * models how many `Resources` phases an earlier run left behind; each one
 * carries every `.lproj` file, the way the real project stores them.
 * `duplicateFirst` models a phase that copies one file twice, which is the
 * state the plugin's uniqueness proof has to reject.
 */
function widgetProject(
  phaseCount: number,
  options: { duplicateFirst?: boolean; foreignFile?: string } = {}
) {
  const resources: Record<string, Phase> = {};
  const buildFiles: Record<string, { fileRef?: string }> = {};
  const fileReferences: Record<string, { path: string }> = {};
  const fileRefByPath = new Map<string, string>();
  // The xcode library hands the mod its live `PBXNativeTarget` section, and the
  // plugin's `removeResourcesPhase` replaces the target's `buildPhases` array on
  // that object. A fresh wrapper per call — or a captured array the target no
  // longer holds — would swallow the change, so every phase reference goes
  // through the target object itself.
  const target: Target = { name: TARGET_NAME, buildPhases: [] };
  const nativeTargets: Record<string, Target> = { [TARGET_UUID]: target };
  let added = 0;

  const attach = (uuid: string, file: string) => {
    let fileRef = fileRefByPath.get(file);
    if (fileRef === undefined) {
      fileRef = `ref-${fileRefByPath.size}`;
      fileRefByPath.set(file, fileRef);
      fileReferences[fileRef] = { path: file };
    }
    const buildFile = `bf-${Object.keys(buildFiles).length}`;
    buildFiles[buildFile] = { fileRef };
    resources[uuid]?.files.push({ value: buildFile, comment: 'Localizable.strings in Resources' });
  };

  for (let index = 0; index < phaseCount; index += 1) {
    const uuid = `resources-${index}`;
    resources[uuid] = { files: [] };
    target.buildPhases.push({ value: uuid, comment: 'Resources' });
    for (const file of STRINGS_FILES) {
      attach(uuid, file);
    }
    if (options.foreignFile !== undefined) {
      attach(uuid, options.foreignFile);
    }
  }

  const project: FakeProject = {
    hash: {
      project: {
        objects: {
          PBXNativeTarget: nativeTargets,
          PBXResourcesBuildPhase: resources,
          PBXBuildFile: buildFiles,
          PBXFileReference: fileReferences,
        },
      },
    },
    pbxNativeTargetSection: () => nativeTargets,
    addBuildPhase: vi.fn((files: string[]) => {
      const uuid = `resources-added-${added}`;
      added += 1;
      resources[uuid] = { files: [] };
      target.buildPhases.push({ value: uuid, comment: 'Resources' });
      for (const [index, file] of files.entries()) {
        attach(uuid, file);
        if (options.duplicateFirst && index === 0) {
          attach(uuid, file);
        }
      }
      return { uuid };
    }),
  };
  return project;
}

/** Run the plugin's xcodeproj mod against `project`, the way prebuild does. */
async function runLocalizationsXcodeMod(project: FakeProject): Promise<void> {
  const config = withWidgetLocalizations(
    { name: 'Kilo' },
    { languages: LANGUAGES, copy: COPY }
  ) as unknown as {
    mods: { ios: { xcodeproj: (modConfig: Record<string, unknown>) => Promise<unknown> } };
  };
  await config.mods.ios.xcodeproj({
    modRequest: { platformProjectRoot: '/tmp/ios' },
    modResults: project,
  });
}

/** The uuids of the target's `Resources` phases, in target order. */
function resourcesPhaseIds(project: FakeProject): string[] {
  return (project.pbxNativeTargetSection()[TARGET_UUID]?.buildPhases ?? [])
    .filter(reference => reference.comment === 'Resources')
    .map(reference => reference.value);
}

/** The project path each entry of one phase copies, resolved through its build file. */
function phaseFiles(project: FakeProject, phaseId: string): (string | undefined)[] {
  const { PBXResourcesBuildPhase, PBXBuildFile, PBXFileReference } = project.hash.project.objects;
  return (PBXResourcesBuildPhase[phaseId]?.files ?? []).map(entry => {
    const buildFile = entry.value === undefined ? undefined : PBXBuildFile[entry.value];
    const fileRef = buildFile?.fileRef;
    return fileRef === undefined ? undefined : PBXFileReference[fileRef]?.path;
  });
}

describe('withWidgetLocalizations — one Resources phase, each .lproj exactly once', () => {
  // The defect: a `--no-clean` prebuild runs the mod over the project an earlier
  // run wrote, and `addBuildPhase` appended a second `Resources` phase carrying
  // the same files. The mod now drops what the target carries first.
  it('drops the phases an earlier run left and adds exactly one', async () => {
    const project = widgetProject(2);

    await runLocalizationsXcodeMod(project);

    const phases = resourcesPhaseIds(project);
    expect(phases).toHaveLength(1);
    expect(phaseFiles(project, phases[0] ?? '')).toEqual(STRINGS_FILES);
  });

  // The heal has to be idempotent: the next `--no-clean` prebuild meets this
  // mod's own output and must still end with one phase per file.
  it('is idempotent across a repeated run', async () => {
    const project = widgetProject(1);

    await runLocalizationsXcodeMod(project);
    await runLocalizationsXcodeMod(project);

    const phases = resourcesPhaseIds(project);
    expect(phases).toHaveLength(1);
    expect(phaseFiles(project, phases[0] ?? '')).toEqual(STRINGS_FILES);
  });

  // A phase that lists one `.lproj` twice is the same failure by another route:
  // two tasks write the same `.strings`. The proof has to be uniqueness, not
  // presence, so the prebuild fails here instead of at XCBuild's plan.
  it('rejects a phase that copies one .lproj twice', async () => {
    const project = widgetProject(0, { duplicateFirst: true });

    await expect(runLocalizationsXcodeMod(project)).rejects.toThrow(/appears 2 times/);
  });

  it('rejects a project whose target is missing', async () => {
    const project = widgetProject(0);
    project.pbxNativeTargetSection = () => ({});

    await expect(runLocalizationsXcodeMod(project)).rejects.toThrow(/target is missing/);
  });

  // Rebuilding the phase must never take another writer's file with it: a phase
  // that carries one is a stop, not a silent delete.
  it('refuses to drop a file it does not write', async () => {
    const project = widgetProject(1, { foreignFile: 'ExpoWidgetsTarget/Assets.car' });

    await expect(runLocalizationsXcodeMod(project)).rejects.toThrow(
      /carries files this plugin does not write/
    );
    expect(resourcesPhaseIds(project)).toHaveLength(1);
  });
});
