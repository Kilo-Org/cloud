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
