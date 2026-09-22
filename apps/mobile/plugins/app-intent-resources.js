// The Xcode project edit `withAppIntentLocalizations` needs: the app target
// keeps one Copy Bundle Resources phase.
//
// The app template already has that phase, and `addBuildPhase` always creates a
// new one, so the target ends up with two. Xcode warns "target has multiple
// Copy Bundle Resources build phases, which may cause it to build incorrectly"
// and reports the app's generated asset symbols as unprocessable — both
// appeared only once that plugin ran. So the members of the phase it created
// move into the phase the target already has, and the empty one is dropped. The
// widget extension `withWidgetLocalizations` attaches to has no Resources phase
// of its own, which is why only the app target needs this.
//
// Pure helpers: nothing here reads a file or touches the project's build
// settings, so the contract test exercises the merge without a prebuild.

/**
 * Move a created Resources phase's members into the target's own Resources
 * phase, and drop the created one.
 *
 * The file references keep the shape `addBuildPhase` created them with —
 * project-root relative and ungrouped — because that is what resolves a
 * `.lproj` member to `<tag>.lproj/` inside the app bundle.
 *
 * @param {object} project the Xcode project the prebuild mod holds
 * @param {string} targetUuid the app target's uuid
 * @param {{ uuid: string, buildPhase: { files: unknown[] } }} created the phase `addBuildPhase` returned
 * @returns {void}
 */
function mergeIntoResourcesPhase(project, targetUuid, created) {
  // The project object expo's `withXcodeProject` hands a mod is the `xcode`
  // package's, and its PBX sections are reachable only through this hash: it
  // has `pbxNativeTargetSection()` but no `pbxResourcesBuildPhaseSection()`.
  const phases = project.hash.project.objects.PBXResourcesBuildPhase;
  const target = project.pbxNativeTargetSection()[targetUuid];
  const existing = target.buildPhases.find(
    entry => entry.value !== created.uuid && phases[entry.value] !== undefined
  );
  if (!existing) {
    throw new Error('withAppIntentLocalizations: the app target has no Resources phase to extend');
  }
  phases[existing.value].files.push(...created.buildPhase.files);
  target.buildPhases = target.buildPhases.filter(entry => entry.value !== created.uuid);
  delete phases[created.uuid];
  delete phases[`${created.uuid}_comment`];
}

module.exports = {
  mergeIntoResourcesPhase,
};
