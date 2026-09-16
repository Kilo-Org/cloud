const fs = require('fs');
const path = require('path');

const { withDangerousMod, withXcodeProject, IOSConfig } = require('expo/config-plugins');

const {
  AGENT_CONTROLS,
  agentControlsSwift,
  agentShortcutStrings,
  injectAgentControlBundle,
  targetSourcesBuildPhases,
} = require('../src/lib/agent-controls.js');

// iOS agent controls: the Control Center control, the Lock Screen control
// slots, and the Action button all bind the same `ControlWidget`s.
//
// expo-widgets owns `ios/ExpoWidgetsTarget` and deletes + rewrites the whole
// directory on every prebuild, so this plugin runs after it (mods run in reverse
// registration order) and:
//   1. writes AgentControls.swift beside the generated widget sources;
//   2. splices `AgentControlsBundle().body` into the generated @main bundle;
//   3. attaches AgentControls.swift to the Sources build phase expo-widgets
//      created for the extension — a Swift file that is not in that phase is
//      never compiled, and a second `Sources` phase is not an option: XCBuild
//      fails the target with "Unexpected duplicate tasks";
//   4. appends the control copy to the `<tag>.lproj/Localizable.strings` that
//      plugins/withWidgetLocalizations.js has already written, which is why this
//      plugin is registered BEFORE that one in app.config.ts.
//
// The copy is the extension's own bundle metadata (plugins/agent-controls-copy.json),
// not app copy: Swift binds the English string as a `LocalizedStringKey` and
// resolves it against the extension's Localizable.strings, exactly like the
// widget gallery copy the same lproj files already carry.
const TARGET_NAME = 'ExpoWidgetsTarget';
const SWIFT_FILE = 'AgentControls.swift';
const CONTROL_COPY = require('./agent-controls-copy.json');

/** One `.strings` entry. Only the quote and the backslash need escaping. */
const stringsLine = (key, value) =>
  `"${key.replace(/[\\"]/g, '\\$&')}" = "${value.replace(/[\\"]/g, '\\$&')}";`;

module.exports = function withAgentControls(config) {
  const withControlBundle = withDangerousMod(config, [
    'ios',
    async modConfig => {
      const targetRoot = path.join(modConfig.modRequest.platformProjectRoot, TARGET_NAME);
      if (!fs.existsSync(targetRoot)) {
        throw new Error(
          `withAgentControls: the ${TARGET_NAME} directory is missing — this plugin ran before expo-widgets`
        );
      }
      const indexSwiftPath = path.join(targetRoot, 'index.swift');
      if (!fs.existsSync(indexSwiftPath)) {
        throw new Error(
          `withAgentControls: ${indexSwiftPath} is missing — this plugin ran before expo-widgets`
        );
      }

      fs.writeFileSync(
        path.join(targetRoot, SWIFT_FILE),
        agentControlsSwift({ copy: CONTROL_COPY, urls: AGENT_CONTROLS }),
        'utf8'
      );
      fs.writeFileSync(
        indexSwiftPath,
        injectAgentControlBundle(fs.readFileSync(indexSwiftPath, 'utf8')),
        'utf8'
      );

      for (const [tag, pairs] of Object.entries(agentShortcutStrings(CONTROL_COPY))) {
        const stringsPath = path.join(targetRoot, `${tag}.lproj`, 'Localizable.strings');
        if (!fs.existsSync(stringsPath)) {
          throw new Error(
            `withAgentControls: ${stringsPath} is missing — this plugin must be registered before ./plugins/withWidgetLocalizations`
          );
        }
        const existing = fs.readFileSync(stringsPath, 'utf8');
        const lines = pairs
          // `key !== value` skips the English file, where the key is its own
          // value; `includes` keeps a re-run from appending a duplicate entry.
          .filter(([key, value]) => key !== value && !existing.includes(`"${key}" =`))
          .map(([key, value]) => stringsLine(key, value));
        if (lines.length === 0) {
          continue;
        }
        const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
        fs.appendFileSync(stringsPath, `${separator}${lines.join('\n')}\n`, 'utf8');
      }

      return modConfig;
    },
  ]);

  // The uuid, not `pbxTargetByName`: that returns the target body, which carries
  // no uuid, and the xcode phase helpers fall back to the first target — the app
  // — when the uuid is undefined.
  return withXcodeProject(withControlBundle, projectConfig => {
    const project = projectConfig.modResults;
    const targets = project.pbxNativeTargetSection();
    const targetUuid = Object.keys(targets).find(
      key => !key.endsWith('_comment') && targets[key].name === TARGET_NAME
    );
    if (!targetUuid) {
      throw new Error(
        `withAgentControls: the ${TARGET_NAME} target is missing — this plugin ran before expo-widgets`
      );
    }

    // Attach the file to the Sources phase expo-widgets built for the
    // extension, never to a phase of this plugin's own. XCBuild names each
    // build phase's tasks after the phase, so a second `Sources` phase on one
    // target fails the whole build with "Unexpected duplicate tasks" before a
    // single file compiles; `addBuildPhase` appends exactly that second phase.
    // The file joins the PBXGroup expo-widgets created beside the widget
    // sources, so its reference is written the way index.swift's is (path
    // relative to the group, `sourceTree = "<group>"`).
    const before = targetSourcesBuildPhases(project, targetUuid);
    if (before.length !== 1) {
      throw new Error(
        `withAgentControls: ${TARGET_NAME} carries ${before.length} Sources build phases, expected exactly one — this plugin ran before expo-widgets, or a duplicate phase was added`
      );
    }
    IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
      filepath: SWIFT_FILE,
      groupName: TARGET_NAME,
      project,
      targetUuid,
    });

    // The state XCBuild accepts: one Sources phase, carrying the file.
    const after = targetSourcesBuildPhases(project, targetUuid);
    if (after.length !== 1) {
      throw new Error(
        `withAgentControls: ${TARGET_NAME} ended with ${after.length} Sources build phases — XCBuild fails a target with duplicate phases ("Unexpected duplicate tasks")`
      );
    }
    if (!after[0]?.files.some(entry => entry.comment === `${SWIFT_FILE} in Sources`)) {
      throw new Error(
        `withAgentControls: ${SWIFT_FILE} is not in the ${TARGET_NAME} Sources build phase`
      );
    }
    return projectConfig;
  });
};
