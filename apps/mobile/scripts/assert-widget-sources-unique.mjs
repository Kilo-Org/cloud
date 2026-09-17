import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The contract is a CommonJS-style `.js` module, so this script loads it the way
// `plugins/withAgentControls.js` does — `require`, not a second import shape —
// and reads the kinds, type names and urls from that one definition. The Swift
// generator reads the same `AGENT_CONTROLS_META_DATA` list, so neither side can
// spell a `kind` or a url of its own.
const require = createRequire(import.meta.url);
const {
  AGENT_CONTROLS_BUNDLE_CALL,
  AGENT_CONTROLS_META_DATA,
  CONTROL_AVAILABILITY,
} = require('../src/lib/agent-controls.js');

// The iOS build fails with `error: Unexpected duplicate tasks` when one target
// has two build phases of the same name, or compiles one source file twice:
// XCBuild builds two tasks that write the same output. expo-widgets generates
// the widget extension and plugins/withAgentControls.js attaches
// AgentControls.swift to its Compile Sources phase, so this script counts what
// the plugin's own assert proves — read the generated project and fail unless
// the phase carries every file exactly once, and AgentControls.swift at all.
//
// The generated extension is the source of the Control Center, Lock Screen and
// Action-button entries, so this script also proves its registration: the
// spliced `AgentControlsBundle().body` sits inside the iOS 18 availability gate
// in index.swift, and AgentControls.swift declares one ControlWidget per entry
// of the contract, each carrying that entry's kind and url. The kinds, type
// names and urls come from `src/lib/agent-controls.js` — the module the plugin
// and the Swift generator read — so this is a second reader of one contract.
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

// The extension registers the two controls. The device round cannot read the
// Control Center list, so the registration is proved as a property of the tree
// the native build compiles: `index.swift` splices `AgentControlsBundle().body`
// in under the iOS 18 gate, and AgentControls.swift declares one ControlWidget
// per contract entry carrying that entry's kind and url. Both files are read
// from the generated tree, and every value comes from AGENT_CONTROLS_META_DATA.
let indexSwift;
try {
  indexSwift = readFileSync(join(mobileDir, 'ios', TARGET_NAME, 'index.swift'), 'utf8');
} catch (error) {
  failures.push(
    `Cannot read ${join(mobileDir, 'ios', TARGET_NAME, 'index.swift')}: ${error.message} — run \`expo prebuild --platform ios\` first`
  );
}

/**
 * Whether `needle` sits inside the `if #available(<version>, *) { … }` block
 * nearest above it. Braces are counted from that gate's opening brace to its
 * matching close, so a call moved below the gate — the extension deploys to
 * 16.4, where the controls do not exist — fails.
 * @param {string} source
 * @param {string} needle
 * @param {string} version
 * @returns {boolean}
 */
function insideAvailabilityGate(source, needle, version) {
  const callAt = source.indexOf(needle);
  if (callAt === -1) {
    return false;
  }
  const gateAt = source.lastIndexOf(`if #available(${version}, *) {`, callAt);
  if (gateAt === -1) {
    return false;
  }
  let depth = 0;
  for (let index = gateAt; index < source.length; index += 1) {
    const character = source[index];
    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return callAt < index;
      }
    }
  }
  return false;
}

/** How many times `needle` occurs in `source`. */
const occurrences = (source, needle) => source.split(needle).length - 1;

let bundleCallGated = false;
if (indexSwift !== undefined) {
  bundleCallGated = insideAvailabilityGate(
    indexSwift,
    AGENT_CONTROLS_BUNDLE_CALL,
    CONTROL_AVAILABILITY
  );
  if (!bundleCallGated) {
    failures.push(
      `index.swift does not call ${AGENT_CONTROLS_BUNDLE_CALL} inside an \`if #available(${CONTROL_AVAILABILITY}, *)\` gate, so the extension registers no control`
    );
  }
}

let agentControlsSource;
try {
  agentControlsSource = readFileSync(join(mobileDir, 'ios', TARGET_NAME, SWIFT_FILE), 'utf8');
} catch (error) {
  failures.push(
    `Cannot read ${join(mobileDir, 'ios', TARGET_NAME, SWIFT_FILE)}: ${error.message} — run \`expo prebuild --platform ios\` first`
  );
}

/**
 * One declaration's text, from its `struct <name>: <conformance>` header to the
 * next declaration header — enough to prove which url an intent carries and
 * which kind a ControlWidget configures. `undefined` when the header is absent.
 * @param {string} source
 * @param {string} header
 * @param {string} nextHeader
 * @returns {string | undefined}
 */
function declarationBlock(source, header, nextHeader) {
  const start = source.indexOf(header);
  if (start === -1) {
    return undefined;
  }
  const end = source.indexOf(nextHeader, start + header.length);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}

const controlDeclarations =
  agentControlsSource === undefined ? 0 : occurrences(agentControlsSource, ': ControlWidget {');
if (agentControlsSource !== undefined && controlDeclarations !== AGENT_CONTROLS_META_DATA.length) {
  failures.push(
    `${SWIFT_FILE} declares ${controlDeclarations} ControlWidgets, expected exactly ${AGENT_CONTROLS_META_DATA.length}`
  );
}
if (agentControlsSource !== undefined) {
  for (const control of AGENT_CONTROLS_META_DATA) {
    for (const [header, needle, what] of [
      [
        `struct ${control.controlTypeName}: ControlWidget {`,
        `"${control.kind}"`,
        `the ${control.id} kind`,
      ],
      [
        `struct ${control.controlTypeName}: ControlWidget {`,
        `ControlWidgetButton(action: ${control.intentTypeName}())`,
        `the ${control.id} action`,
      ],
      [
        `struct ${control.intentTypeName}: AppIntent {`,
        `"${control.url}"`,
        `the ${control.id} url`,
      ],
    ]) {
      const block = declarationBlock(agentControlsSource, header, 'struct ');
      if (block === undefined) {
        failures.push(`${SWIFT_FILE} declares no \`${header}\``);
        continue;
      }
      if (!block.includes(needle)) {
        failures.push(`${SWIFT_FILE} ${what} \`${needle}\` is not inside ${header}`);
      }
    }
  }
  // Every url in the file is a contract url: a stray url is a control opening
  // something the one contract does not define.
  const contractUrls = new Set(AGENT_CONTROLS_META_DATA.map(control => control.url));
  for (const url of agentControlsSource.match(/kiloapp:\/\/[^"'\s<]*/g) ?? []) {
    if (!contractUrls.has(url)) {
      failures.push(`${SWIFT_FILE} opens "${url}", which is not a contract url`);
    }
  }
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
console.log(`${TARGET_NAME} control registration`);
console.log(
  `  index.swift ${AGENT_CONTROLS_BUNDLE_CALL} inside the ${CONTROL_AVAILABILITY} gate: ${bundleCallGated ? 'yes' : 'no'}`
);
console.log(`  ControlWidget declarations: ${controlDeclarations}`);
for (const control of AGENT_CONTROLS_META_DATA) {
  console.log(
    `  ${control.id}: ${control.controlTypeName} (kind ${control.kind}), url ${control.url}`
  );
}

if (failures.length > 0) {
  console.error('Widget target violations:');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log(
  `${TARGET_NAME} OK: one Sources phase and one Resources phase with every file once, and both controls registered from the one contract`
);
