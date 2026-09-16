import { readFileSync } from 'node:fs';
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

/** The `name in Sources` comments the given phase's `files` list carries. */
function phaseSourceFiles(phaseId) {
  const pattern = new RegExp(
    `${phaseId} \\/\\* Sources \\*\\/ = \\{\\s*isa = PBXSourcesBuildPhase;[\\s\\S]*?files = \\(([\\s\\S]*?)\\);`
  );
  const files = pattern.exec(project)?.[1];
  if (files === undefined) {
    return undefined;
  }
  return [...files.matchAll(/\/\* (.+?) in Sources \*\//g)].map(match => match[1]);
}

/** @type {Map<string, number>} */
const counts = new Map();
let resolvedPhases = 0;
for (const phaseId of sourcesPhaseIds) {
  const files = phaseSourceFiles(phaseId);
  if (files === undefined) {
    continue;
  }
  resolvedPhases += 1;
  for (const file of files) {
    counts.set(file, (counts.get(file) ?? 0) + 1);
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
if ((counts.get(SWIFT_FILE) ?? 0) === 0) {
  failures.push(`${SWIFT_FILE} in Sources is missing`);
}

console.log(`${TARGET_NAME} Compile Sources phase`);
console.log(`  Compile Sources phases: ${resolvedPhases}`);
if (counts.size === 0) {
  console.log('  (no source files)');
}
for (const [file, count] of counts) {
  console.log(`  ${file} in Sources: ${count}`);
}

if (failures.length > 0) {
  console.error('Widget target Sources violations:');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log(`${TARGET_NAME} Sources build phase OK: every source file appears exactly once`);
