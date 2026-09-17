import { IOSConfig } from 'expo/config-plugins';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  retainOneSourceFileEntry,
  sourceFileEntryCount,
  sourcePhaseDefects,
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

/** The widget target's single Sources phase, or a failure that names the gap. */
function widgetSourcesPhase(project: ReturnType<typeof widgetTargetProject>) {
  const [phase] = targetSourcesBuildPhases(project, TARGET_UUID);
  if (phase === undefined) {
    throw new Error('the widget target carries no Sources phase');
  }
  return phase;
}

describe('sourcePhaseDefects', () => {
  it('is empty for a phase whose entries are unique and resolve to a PBXBuildFile', () => {
    const project = widgetTargetProject(1);
    expect(sourcePhaseDefects(project, widgetSourcesPhase(project))).toEqual([]);
  });

  it('names a doubled entry and an entry with no PBXBuildFile', () => {
    const project = widgetTargetProject(1);
    const phase = widgetSourcesPhase(project);
    phase.files.push(
      { value: 'bf-index-0', comment: 'index.swift in Sources' },
      { value: 'bf-gone', comment: 'ActiveAgentsWidget.swift in Sources' }
    );
    expect(sourcePhaseDefects(project, phase)).toEqual([
      'index.swift in Sources appears 2 times',
      'ActiveAgentsWidget.swift in Sources points at a PBXBuildFile the project does not carry',
    ]);
  });
});

describe('retainOneSourceFileEntry', () => {
  // A surplus entry can name the same `PBXBuildFile` the kept entry does. The
  // heal must not delete it: the surviving phase entry would reference a build
  // file the project no longer carries, and Xcode reads that as a damaged
  // project.
  it('keeps the surviving entry’s PBXBuildFile when a surplus entry names the same object', () => {
    const project = widgetTargetProject(1);
    project.hash.project.objects.PBXBuildFile['bf-controls-0'] = {};
    const phase = widgetSourcesPhase(project);
    const comment = `${SWIFT_FILE} in Sources`;
    phase.files.push({ value: 'bf-controls-0', comment }, { value: 'bf-controls-0', comment });

    expect(retainOneSourceFileEntry(project, phase, SWIFT_FILE)).toBe(1);
    expect(sourceFileEntryCount(phase, SWIFT_FILE)).toBe(1);
    expect(project.hash.project.objects.PBXBuildFile['bf-controls-0']).toBeDefined();
    expect(sourcePhaseDefects(project, phase)).toEqual([]);
  });
});

describe('withAgentControls — the phase proof covers every source file', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Whichever writer doubles an entry, the prebuild must fail here, not at
  // XCBuild's plan.
  it('rejects a doubled entry of another source file in the phase', async () => {
    const project = widgetTargetProject(1);
    widgetSourcesPhase(project).files.push({
      value: 'bf-index-0',
      comment: 'index.swift in Sources',
    });
    attachMock(project, 1);

    await expect(runControlsXcodeMod(project)).rejects.toThrow(
      /index\.swift in Sources appears 2 times/
    );
  });

  // A heal that drops a doubled entry while deleting the `PBXBuildFile` the
  // survivor still points at leaves a project Xcode calls damaged; the proof
  // has to see that too.
  it('rejects a phase entry whose PBXBuildFile the project does not carry', async () => {
    const project = widgetTargetProject(1);
    widgetSourcesPhase(project).files.push({
      value: 'bf-gone',
      comment: 'ActiveAgentsWidget.swift in Sources',
    });
    attachMock(project, 1);

    await expect(runControlsXcodeMod(project)).rejects.toThrow(/does not carry/);
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
