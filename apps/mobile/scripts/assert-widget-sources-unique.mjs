import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The iOS build fails with `error: Unexpected duplicate tasks` when one target
// has two build phases of the same name, or compiles one source file twice:
// XCBuild builds two tasks that write the same output. expo-widgets generates
// the widget extension and plugins/withAgentControls.js attaches
// AgentControls.swift to its Compile Sources phase, so this script counts what
// the plugin's own assert proves — read the generated project and fail unless
// the phase carries every file exactly once, and AgentControls.swift at all.
//
// Keep in step with plugins/withAgentControls.js: the same two values name the
// target and the file on both sides.
const TARGET_NAME = 'ExpoWidgetsTarget';
const SWIFT_FILE = 'AgentControls.swift';

const mobileDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const projectPath = join(mobileDir, 'ios', 'Kilo.xcodeproj', 'project.pbxproj');

let project;
try {
  project = readFileSync(projectPath, 'utf8');
} catch (error) {
  console.error(
    `Cannot read ${projectPath} (run \`expo prebuild --platform ios\` first): ${error.message}`
  );
  process.exit(1);
}

/** Every `PBXNativeTarget` block, keyed by the name its `name` field carries. */
function nativeTargetBodies(source) {
  const bodies = [];
  // The xcode library writes `<uuid> /* <name> */ = { ... };` with tab
  // indentation; the block ends at the closing `};` on its own indented line.
  const pattern = /[0-9A-F]{24} \/\* [^*]+ \*\/ = \{\n\t*isa = PBXNativeTarget;([\s\S]*?)\n\t+\};/g;
  for (const match of source.matchAll(pattern)) {
    const body = match[1];
    const name = /name = "?([^";]+)"?;/.exec(body)?.[1];
    bodies.push({ name, body });
  }
  return bodies;
}

const target = nativeTargetBodies(project).find(body => body.name === TARGET_NAME);
if (target === undefined) {
  console.error(`No PBXNativeTarget named "${TARGET_NAME}" in ${projectPath}`);
  process.exit(1);
}

const buildPhases = /buildPhases = \(([\s\S]*?)\);/.exec(target.body)?.[1];
const sourcesPhaseIds = [...(buildPhases ?? '').matchAll(/([0-9A-F]{24}) \/\* Sources \*\//g)].map(
  match => match[1]
);
if (sourcesPhaseIds.length === 0) {
  console.error(`"${TARGET_NAME}" carries no Compile Sources build phase in ${projectPath}`);
  process.exit(1);
}

/** The build-file uuid and `in Sources` name each entry of the phase's files list carries. */
function phaseSourceEntries(phaseId) {
  const pattern = new RegExp(
    `${phaseId} \\/\\* Sources \\*\\/ = \\{\\s*isa = PBXSourcesBuildPhase;[\\s\\S]*?files = \\(([\\s\\S]*?)\\);`
  );
  const files = pattern.exec(project)?.[1];
  if (files === undefined) {
    return undefined;
  }
  return [...files.matchAll(/([0-9A-F]{24}) \/\* (.+?) in Sources \*\//g)].map(match => ({
    uuid: match[1],
    file: match[2],
  }));
}

/** Every uuid the `PBXBuildFile` section carries, `_comment` keys excluded. */
const liveBuildFiles = new Set(
  [...project.matchAll(/^\t\t([0-9A-F]{24}) \/\* [^*]+ \*\/ = \{isa = PBXBuildFile;/gm)].map(
    match => match[1]
  )
);

/** @type {Map<string, number>} */
const counts = new Map();
const dangling = [];
let resolvedPhases = 0;
for (const phaseId of sourcesPhaseIds) {
  const entries = phaseSourceEntries(phaseId);
  if (entries === undefined) {
    continue;
  }
  resolvedPhases += 1;
  for (const { uuid, file } of entries) {
    counts.set(file, (counts.get(file) ?? 0) + 1);
    // An entry whose build file the project no longer carries is the dangling
    // reference a heal leaves when it deletes the `PBXBuildFile` the surviving
    // entry still points at; Xcode reads it as a damaged project.
    if (!liveBuildFiles.has(uuid)) {
      dangling.push(`${file} in Sources (${uuid})`);
    }
  }
}

const failures = [];
if (resolvedPhases !== 1) {
  failures.push(
    `"${TARGET_NAME}" carries ${resolvedPhases} Compile Sources phases, expected exactly one`
  );
}
for (const [file, count] of counts) {
  if (count !== 1) {
    failures.push(`${file} in Sources appears ${count} times, expected exactly one`);
  }
}
for (const entry of dangling) {
  failures.push(`${entry} points at a PBXBuildFile the project does not carry`);
}
if ((counts.get(SWIFT_FILE) ?? 0) === 0) {
  failures.push(`${SWIFT_FILE} in Sources is missing`);
}

// The same proof for the `Resources` phase plugins/withWidgetLocalizations.js
// attaches: it copies each `<tag>.lproj/Localizable.strings` into the appex, so a
// second `Resources` phase — what the plugin's append-only `addBuildPhase` left
// on a `--no-clean` re-run before it dropped the phase first — or one file listed
// twice copies the same `.strings` twice and fails with the same
// "Unexpected duplicate tasks".
const resourcesPhaseIds = [
  ...(buildPhases ?? '').matchAll(/([0-9A-F]{24}) \/\* Resources \*\//g),
].map(match => match[1]);

/** The build-file uuid each Resources phase entry carries, without its basename comment. */
function phaseResourceEntries(phaseId) {
  const pattern = new RegExp(
    `${phaseId} \\/\\* Resources \\*\\/ = \\{\\s*isa = PBXResourcesBuildPhase;[\\s\\S]*?files = \\(([\\s\\S]*?)\\);`
  );
  const files = pattern.exec(project)?.[1];
  if (files === undefined) {
    return undefined;
  }
  return [...files.matchAll(/([0-9A-F]{24}) \/\* (.+?) in Resources \*\//g)].map(match => ({
    uuid: match[1],
  }));
}

// A phase entry's comment cannot name the file: `xcode` writes the basename
// there, and every `.lproj` file this phase copies is called `Localizable.strings`.
// Resolve the path through the `PBXBuildFile` and the `PBXFileReference` it names.
const fileReferencePaths = new Map(
  [
    ...project.matchAll(
      /^\t\t([0-9A-F]{24}) \/\* [^*]+ \*\/ = \{isa = PBXFileReference;([^\n]*)\};$/gm
    ),
  ].map(match => [match[1], /path = "?([^";]+)"?;/.exec(match[2])?.[1]])
);
const buildFileRefs = new Map(
  [
    ...project.matchAll(
      /^\t\t([0-9A-F]{24}) \/\* [^*]+ \*\/ = \{isa = PBXBuildFile; fileRef = ([0-9A-F]{24}) \/\* [^*]+ \*\/; \};$/gm
    ),
  ].map(match => [match[1], match[2]])
);
const entryFilePath = uuid => fileReferencePaths.get(buildFileRefs.get(uuid));

// The `.lproj` directories the prebuild wrote are the list the phase has to
// carry, so the check never has to name the languages.
let expectedStrings = [];
try {
  expectedStrings = readdirSync(join(mobileDir, 'ios', TARGET_NAME))
    .filter(name => name.endsWith('.lproj'))
    .map(name => `${TARGET_NAME}/${name}/Localizable.strings`);
} catch (error) {
  failures.push(`Cannot list ${join(mobileDir, 'ios', TARGET_NAME)}: ${error.message}`);
}

/** @type {Map<string, number>} */
const resourceCounts = new Map();
const danglingResources = [];
let resolvedResourcePhases = 0;
for (const phaseId of resourcesPhaseIds) {
  const entries = phaseResourceEntries(phaseId);
  if (entries === undefined) {
    continue;
  }
  resolvedResourcePhases += 1;
  for (const { uuid } of entries) {
    const file = entryFilePath(uuid);
    if (file === undefined) {
      danglingResources.push(`${uuid} in Resources`);
      continue;
    }
    resourceCounts.set(file, (resourceCounts.get(file) ?? 0) + 1);
    if (!liveBuildFiles.has(uuid)) {
      danglingResources.push(`${file} in Resources (${uuid})`);
    }
  }
}

if (resolvedResourcePhases !== 1) {
  failures.push(
    `"${TARGET_NAME}" carries ${resolvedResourcePhases} Resources phases, expected exactly one`
  );
}
for (const file of new Set([...expectedStrings, ...resourceCounts.keys()])) {
  const count = resourceCounts.get(file) ?? 0;
  if (!expectedStrings.includes(file)) {
    failures.push(`${file} in Resources is not a .lproj the project writes`);
  } else if (count !== 1) {
    failures.push(`${file} in Resources appears ${count} times, expected exactly one`);
  }
}
for (const entry of danglingResources) {
  failures.push(`${entry} points at a PBXBuildFile the project does not carry`);
}

console.log(`${TARGET_NAME} Compile Sources phase`);
console.log(`  Compile Sources phases: ${resolvedPhases}`);
if (counts.size === 0) {
  console.log('  (no source files)');
}
for (const [file, count] of counts) {
  console.log(`  ${file} in Sources: ${count}`);
}
console.log(`${TARGET_NAME} Resources phase`);
console.log(`  Resources phases: ${resolvedResourcePhases}`);
for (const file of expectedStrings) {
  console.log(`  ${file} in Resources: ${resourceCounts.get(file) ?? 0}`);
}

if (failures.length > 0) {
  console.error('Widget target build-phase violations:');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log(
  `${TARGET_NAME} build phases OK: one Sources phase and one Resources phase, every file in each appears exactly once`
);
