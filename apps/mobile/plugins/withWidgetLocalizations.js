const fs = require('fs');
const path = require('path');
const plist = require('@expo/plist').default;
const { withDangerousMod, withXcodeProject } = require('expo/config-plugins');

// Localizes the widget extension.
//
// expo-widgets writes the extension's Info.plist with four keys and no
// localization list, so iOS treats the extension as English-only. Two things
// break: the Live Activity and every widget family lay out left-to-right on an
// Arabic or Hebrew device, and the widget gallery copy stays English. The main
// app declares the same list for the same reason — see `CFBundleLocalizations`
// in app.config.ts.
//
// The gallery copy is bundle metadata, not app copy: expo-widgets emits
// `.configurationDisplayName("…")` and `.description("…")` as Swift string
// literals, which bind to SwiftUI's `LocalizedStringKey` overloads and resolve
// against `Localizable.strings` in the extension bundle. So the English strings
// are the keys, and this writes one `<tag>.lproj/Localizable.strings` per
// language. It never goes through i18next, which is why the translations live in
// `widget-gallery-copy.json` beside this file rather than in the app catalogs.
//
// Both mods must run after the `expo-widgets` plugin, which rewrites the
// Info.plist and creates the target. Mods run in reverse registration order, so
// this plugin is registered BEFORE 'expo-widgets' in app.config.ts.
const TARGET_NAME = 'ExpoWidgetsTarget';

/**
 * A path this plugin writes: `<TARGET_NAME>/<tag>.lproj/Localizable.strings`. An
 * earlier run's phase may list a language this run no longer writes, and its
 * `.lproj` directory is gone, so the phase is always rebuilt from the current
 * list. Any other path in a phase is another writer's file and is never dropped.
 */
const OWNED_STRINGS_PATH = new RegExp(`^${TARGET_NAME}/[^/]+\\.lproj/Localizable\\.strings$`);

/** One `.strings` entry. Only the quote and the backslash need escaping. */
const stringsLine = (key, value) =>
  `"${key.replace(/[\\"]/g, '\\$&')}" = "${value.replace(/[\\"]/g, '\\$&')}";`;

/**
 * The `Resources` build phases the target references, each with the uuid the
 * target names it by. A reference that names no phase is ignored.
 *
 * A build phase's tasks are named after the phase, so two `Resources` phases on
 * one target copy the same files twice and XCBuild stops the whole target with
 * "Unexpected duplicate tasks". The `xcode` library's `addBuildPhase` appends a
 * phase on every call, so a second run of this mod over a kept project
 * (`expo prebuild --no-clean`) is what puts the second phase there.
 */
function resourcesPhaseRefs(project, targetUuid) {
  const section = project.hash.project.objects.PBXResourcesBuildPhase ?? {};
  return (project.pbxNativeTargetSection()[targetUuid]?.buildPhases ?? [])
    .map(reference => ({ uuid: reference.value, phase: section[reference.value] }))
    .filter(entry => entry.phase !== undefined);
}

/**
 * Drop one `Resources` phase: the target's reference to it, the phase object and
 * its `_comment`. The `PBXBuildFile` entries the phase carried stay in the
 * project — `addBuildPhase` reuses them when it attaches the same path again — so
 * dropping a phase leaves no orphan object behind.
 */
function removeResourcesPhase(project, targetUuid, uuid) {
  const section = project.hash.project.objects.PBXResourcesBuildPhase;
  const target = project.pbxNativeTargetSection()[targetUuid];
  target.buildPhases = target.buildPhases.filter(reference => reference.value !== uuid);
  // The computed-key delete (`delete section[uuid]`) is the lint-forbidden form.
  Reflect.deleteProperty(section, uuid);
  Reflect.deleteProperty(section, `${uuid}_comment`);
}

/**
 * The project path a phase entry copies, resolved through its `PBXBuildFile` and
 * the `PBXFileReference` that names the path. The entry's own comment cannot
 * identify the file: `xcode` writes the basename there, and every `.lproj` file
 * this phase copies is called `Localizable.strings`. A path that carries no space
 * is written unquoted, but the parser hands back whatever the file wrote, so the
 * surrounding quotes come off here.
 */
function entryFilePath(project, entry) {
  const buildFile = (project.hash.project.objects.PBXBuildFile ?? {})[entry.value];
  const fileRef = buildFile?.fileRef;
  const path = (project.hash.project.objects.PBXFileReference ?? {})[fileRef]?.path;
  return typeof path === 'string' ? path.replaceAll('"', '') : path;
}

module.exports = function withWidgetLocalizations(config, { languages, copy } = {}) {
  if (!Array.isArray(languages) || languages.length === 0) {
    throw new Error('withWidgetLocalizations needs a non-empty `languages` array');
  }
  const missing = languages.filter(tag => !copy?.[tag]);
  if (missing.length > 0) {
    throw new Error(`withWidgetLocalizations: no gallery copy for ${missing.join(', ')}`);
  }
  const english = copy.en;
  if (!english) {
    throw new Error('withWidgetLocalizations: the gallery copy needs an `en` entry');
  }

  // The build phase that copies the `.lproj` directories into the appex. The
  // file references are relative to the project root, so they resolve without
  // being added to the target's group.
  const withResources = cfg =>
    withXcodeProject(cfg, projectConfig => {
      const project = projectConfig.modResults;
      // The uuid, not `pbxTargetByName`: that returns the target body, which
      // carries no uuid, and `addBuildPhase` silently falls back to the first
      // target — the app — when the uuid is undefined.
      const targets = project.pbxNativeTargetSection();
      const targetUuid = Object.keys(targets).find(
        key => !key.endsWith('_comment') && targets[key].name === TARGET_NAME
      );
      if (!targetUuid) {
        throw new Error(
          `withWidgetLocalizations: the ${TARGET_NAME} target is missing — this plugin ran before expo-widgets`
        );
      }
      const files = languages.map(tag => `${TARGET_NAME}/${tag}.lproj/Localizable.strings`);
      const existing = resourcesPhaseRefs(project, targetUuid);
      // Never drop a file this plugin did not write. The phase is this plugin's,
      // but a future writer could attach its own, and a rebuild that deleted the
      // phase would take its file with it. Name it and stop instead.
      const foreign = [];
      for (const { phase: carried } of existing) {
        for (const entry of carried.files ?? []) {
          const path = entryFilePath(project, entry);
          if (path === undefined || !OWNED_STRINGS_PATH.test(path)) {
            foreign.push(path ?? `an unresolved entry (${entry.value ?? 'no uuid'})`);
          }
        }
      }
      if (foreign.length > 0) {
        throw new Error(
          `withWidgetLocalizations: the ${TARGET_NAME} Resources build phase carries files this plugin does not write (${foreign.join(', ')}); refusing to drop them`
        );
      }
      // `addBuildPhase` appends a phase every time it runs, and a `--no-clean`
      // prebuild re-runs this mod against the project an earlier run wrote. Adding
      // again there would leave two `Resources` phases copying the same `.lproj`
      // files — two tasks for one output, "Unexpected duplicate tasks" — so drop
      // what the target carries and add the one phase this run needs. The phase
      // is rebuilt from the current language list either way, which a re-run over
      // a changed list needs: the dropped phase also lists languages this run no
      // longer writes, and their `.lproj` directories are gone.
      for (const { uuid } of existing) {
        removeResourcesPhase(project, targetUuid, uuid);
      }
      const phase = project.addBuildPhase(
        files,
        'PBXResourcesBuildPhase',
        'Resources',
        targetUuid,
        'app_extension',
        '""'
      );
      if (!targets[targetUuid].buildPhases.some(entry => entry.value === phase.uuid)) {
        throw new Error(
          `withWidgetLocalizations: the Resources phase did not attach to ${TARGET_NAME}`
        );
      }
      // The proof plugins/withAgentControls.js keeps for the target's Sources
      // phase, for the same reason: one phase, each file through exactly one
      // entry, and every entry backed by a `PBXBuildFile` the project carries.
      const phases = resourcesPhaseRefs(project, targetUuid);
      const buildFiles = project.hash.project.objects.PBXBuildFile ?? {};
      const defects = [];
      if (phases.length !== 1) {
        defects.push(`${phases.length} Resources build phases, expected exactly one`);
      }
      const entries = phases[0]?.phase.files ?? [];
      for (const entry of entries) {
        if (entry.value !== undefined && buildFiles[entry.value] === undefined) {
          defects.push(
            `${entryFilePath(project, entry) ?? entry.value} points at a PBXBuildFile the project does not carry`
          );
        }
      }
      for (const file of files) {
        const count = entries.filter(entry => entryFilePath(project, entry) === file).length;
        if (count !== 1) {
          defects.push(`${file} in Resources appears ${count} times, expected exactly one`);
        }
      }
      const required = new Set(files);
      for (const path of new Set(entries.map(entry => entryFilePath(project, entry)))) {
        if (path === undefined || !required.has(path)) {
          defects.push(
            `${path ?? 'an unresolved entry'} in Resources is not a .lproj this plugin writes`
          );
        }
      }
      if (defects.length > 0) {
        throw new Error(
          `withWidgetLocalizations: the ${TARGET_NAME} Resources build phase would fail XCBuild ("Unexpected duplicate tasks"): ${defects.join('; ')}`
        );
      }
      return projectConfig;
    });

  return withResources(
    withDangerousMod(config, [
      'ios',
      async modConfig => {
        const targetRoot = path.join(modConfig.modRequest.platformProjectRoot, TARGET_NAME);
        const infoPlistPath = path.join(targetRoot, 'Info.plist');
        if (!fs.existsSync(infoPlistPath)) {
          throw new Error(`withWidgetLocalizations: ${infoPlistPath} is missing`);
        }
        const parsed = plist.parse(fs.readFileSync(infoPlistPath, 'utf8'));
        parsed.CFBundleLocalizations = [...languages];
        parsed.CFBundleDevelopmentRegion = 'en';
        fs.writeFileSync(infoPlistPath, plist.build(parsed));

        for (const tag of languages) {
          const dir = path.join(targetRoot, `${tag}.lproj`);
          fs.mkdirSync(dir, { recursive: true });
          const lines = [
            stringsLine(english.displayName, copy[tag].displayName),
            stringsLine(english.description, copy[tag].description),
          ];
          fs.writeFileSync(path.join(dir, 'Localizable.strings'), `${lines.join('\n')}\n`, 'utf8');
        }
        return modConfig;
      },
    ])
  );
};
