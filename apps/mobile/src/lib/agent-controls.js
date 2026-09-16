/** The agent-controls contract: one definition of the two agent controls, the
 *  url each one opens, and the pure generators the platform plugins consume.
 *
 *  Plain .js on purpose — `app.config.ts` and `plugins/*.js` cannot consume TS,
 *  the same reason url-contract.js and universal-link-paths.js exist.
 *
 *  A control never re-implements an action. Every url here is resolved by the
 *  app's existing universal-link table (`resolveIncomingUrl` in
 *  @kilocode/app-shared/universal-links): `/cloud/sessions/*` maps to
 *  `/(app)/agent-chat/<id>`, so a control's tap lands on the existing composer
 *  route and rides the app's sign-in gate, gating, and pending-slot precedence
 *  unchanged. Cold start is captured by captureLaunchDeepLink and warm links by
 *  redirectSystemPath; nothing platform-specific is added.
 */

/**
 * The two controls the request names. `copyKey` indexes
 * `plugins/agent-controls-copy.json`, which holds the extension's bundle copy.
 * The url form is the existing glanceable form (OPEN_AGENTS_URL in
 * src/glanceable-ios is `kiloapp:///cloud/sessions`) — one url style only.
 * @typedef {{ id: string, url: string, copyKey: string }} AgentControl
 */

/** @type {AgentControl[]} */
export const AGENT_CONTROLS = [
  { id: 'new-agent', url: 'kiloapp:///cloud/sessions/new', copyKey: 'newAgent' },
  { id: 'waiting-agent', url: 'kiloapp:///cloud/sessions/waiting', copyKey: 'openWaitingAgent' },
];

/** The SF Symbols the controls draw. The extension ships no image assets.
 *  @type {Record<string, string | undefined>} */
const CONTROL_SYMBOLS = { 'new-agent': 'plus.bubble', 'waiting-agent': 'hourglass' };

/** Controls are an iOS 18 API; the extension's own deployment target is 16.4. */
const CONTROL_AVAILABILITY = 'iOS 18.0';

/** The name the injected bundle call is known by, on both sides of the splice. */
export const AGENT_CONTROLS_BUNDLE_CALL = 'AgentControlsBundle().body';

/** A control's `kind`: unique inside the widget extension.
 *  @param {string} id
 *  @returns {string} */
const controlKind = id => `kiloapp.agent-control.${id}`;

/** Stable Swift type name for a control id: `new-agent` → `AgentNewAgent`.
 *  @param {string} id
 *  @returns {string} */
const controlTypeName = id =>
  `Agent${id
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')}`;

/** Copy key of a control's one-line description.
 *  @param {string} copyKey
 *  @returns {string} */
const descriptionCopyKey = copyKey => `${copyKey}Description`;

/** The Android resource file the static shortcuts live in: `@xml/kilo_agent_shortcuts`.
 *  The shortcut ids derive from it too, so one name covers both. */
export const AGENT_SHORTCUTS_RESOURCE = 'kilo_agent_shortcuts';

/** Snake-cases a copy key for a resource name: `openWaitingAgent` → `open_waiting_agent`.
 *  @param {string} value
 *  @returns {string} */
const snakeCase = value => value.replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** Android static-shortcut label resource: `newAgent` → `kilo_shortcut_new_agent_short`.
 *  Android resolves `@string/…` through the resource system, so the same name in a
 *  `values-b+<tag>` folder is all the localization needs.
 *  @param {string} copyKey
 *  @param {string} suffix
 *  @returns {string} */
const shortcutResourceName = (copyKey, suffix) => `kilo_shortcut_${snakeCase(copyKey)}_${suffix}`;

/** Static-shortcut id: `new-agent` → `kilo_agent_shortcuts_new_agent`. Unique per app.
 *  @param {string} id
 *  @returns {string} */
const shortcutId = id => `${AGENT_SHORTCUTS_RESOURCE}_${id.replaceAll('-', '_')}`;

/**
 * Everything a platform plugin needs about a shortcut besides its copy: the
 * copy keys it renders and the Android resource names those values land on.
 */
export const AGENT_SHORTCUTS_META_DATA = AGENT_CONTROLS.map(control => ({
  id: control.id,
  copyKey: control.copyKey,
  descriptionCopyKey: descriptionCopyKey(control.copyKey),
  shortLabelResource: shortcutResourceName(control.copyKey, 'short'),
  longLabelResource: shortcutResourceName(control.copyKey, 'long'),
}));

/**
 * The English copy string is the key every surface resolves: Swift binds it as
 * a `LocalizedStringKey` against the extension's `Localizable.strings`, and
 * Android resolves the same value through its `values-<tag>` resources.
 * @param {Record<string, Record<string, string | undefined>>} copy
 * @param {string} key
 * @returns {string}
 */
function englishCopy(copy, key) {
  return requiredCopy(copy, 'en', key);
}

/**
 * @param {Record<string, Record<string, string | undefined>>} copy
 * @param {string} tag
 * @param {string} key
 * @returns {string}
 */
function requiredCopy(copy, tag, key) {
  const value = copy[tag]?.[key];
  if (value === undefined || value.length === 0) {
    throw new Error(`agent-controls: the copy is missing \`${tag}.${key}\``);
  }
  return value;
}

/** A Swift string literal. JSON's escaping is a subset of Swift's.
 *  @param {string} value
 *  @returns {string} */
const swiftLiteral = value => JSON.stringify(value);

/** XML text escaping, for the values interpolated into the shortcut file.
 *  @param {string} value
 *  @returns {string} */
const escapeXml = value =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

const SWIFT_HEADER = `// Generated by plugins/withAgentControls.js from src/lib/agent-controls.js.
// Do not edit: change the contract and re-run \`expo prebuild\`.
import AppIntents
import SwiftUI
import WidgetKit`;

/**
 * One `Sources` build phase of a target, as the generated project stores it.
 * @typedef {{ files: { value?: string, comment?: string }[] }} SourcesBuildPhase
 */

/**
 * The `Sources` build phases the target carries, in target order, ignoring
 * buildPhases references that name no `PBXSourcesBuildPhase` entry.
 *
 * A build phase task is named after its phase, so two `Sources` phases on one
 * target collide: XCBuild stops the build with "Unexpected duplicate tasks"
 * before it compiles anything. A plugin that adds a source file to an existing
 * target therefore joins the phase the target already has — the `xcode`
 * library's `addBuildPhase` always appends a new phase, so it is only safe
 * against a target that has none. Reads a live `xcode.project` object; a plain
 * object of the same shape is enough to test the selector.
 * @param {{ hash: { project: { objects: { PBXSourcesBuildPhase?: Record<string, SourcesBuildPhase | undefined> } } }, pbxNativeTargetSection: () => Record<string, { name?: string, buildPhases?: { value: string, comment?: string }[] } | undefined> }} project
 * @param {string} targetUuid
 * @returns {SourcesBuildPhase[]}
 */
export function targetSourcesBuildPhases(project, targetUuid) {
  const section = project.hash.project.objects.PBXSourcesBuildPhase ?? {};
  const target = project.pbxNativeTargetSection()[targetUuid];
  /** @type {SourcesBuildPhase[]} */
  const phases = [];
  for (const reference of target?.buildPhases ?? []) {
    const phase = section[reference.value];
    if (phase !== undefined) {
      phases.push(phase);
    }
  }
  return phases;
}

/**
 * How many entries of the phase compile `file`: the entries whose comment is
 * `` `${file} in Sources` ``. XCBuild fails a target that compiles one source
 * twice — the same "Unexpected duplicate tasks" failure a second `Sources`
 * phase causes — so the plugin counts this after its edit and fails the
 * prebuild unless the count is exactly one, and
 * `scripts/assert-widget-sources-unique.mjs` counts the same thing in the
 * generated project.
 * @param {SourcesBuildPhase | undefined} phase
 * @param {string} file
 * @returns {number}
 */
export function sourceFileEntryCount(phase, file) {
  const comment = `${file} in Sources`;
  return (phase?.files ?? []).filter(entry => entry.comment === comment).length;
}

/**
 * Keep at most one `` `${file} in Sources` `` entry on the phase and return the
 * number kept. Every surplus entry is dropped together with the `PBXBuildFile`
 * object it points at — the object a doubled `addBuildSourceFileToGroup` left
 * behind. The kept entry's own `PBXBuildFile` is never deleted, even when a
 * surplus entry names the same object: the phase would then reference a build
 * file the project does not carry, and Xcode reads that as a damaged project.
 * Idempotent: a phase that already carries one entry is untouched, so a
 * prebuild that runs the mod twice, or one that meets a project a staler run
 * doubled, still ends with exactly one entry.
 * @param {{ hash: { project: { objects: { PBXBuildFile?: Record<string, unknown> | undefined } } } }} project
 * @param {SourcesBuildPhase | undefined} phase
 * @param {string} file
 * @returns {number}
 */
export function retainOneSourceFileEntry(project, phase, file) {
  if (phase === undefined) {
    return 0;
  }
  const comment = `${file} in Sources`;
  const matching = phase.files.filter(entry => entry.comment === comment);
  if (matching.length === 0) {
    return 0;
  }
  const [kept] = matching;
  const surplus = new Set(
    matching
      .slice(1)
      .map(entry => entry.value)
      .filter(value => value !== undefined && value !== kept.value)
  );
  if (surplus.size > 0) {
    // Drop the `PBXBuildFile` section entries the doubled attach left behind:
    // the phase no longer references them. `Reflect.deleteProperty` is the
    // computed-key delete (`delete section[uuid]` is the lint-forbidden form).
    const buildFiles = project.hash.project.objects.PBXBuildFile ?? {};
    for (const uuid of surplus) {
      Reflect.deleteProperty(buildFiles, uuid);
      Reflect.deleteProperty(buildFiles, `${uuid}_comment`);
    }
  }
  // The first match stays; every later one is dropped from the phase.
  phase.files = phase.files.filter(entry => entry.comment !== comment || entry === kept);
  return 1;
}

/**
 * The reasons the phase would fail XCBuild's plan as it now stands: a comment
 * that appears more than once (one source compiled twice), or an entry whose
 * `PBXBuildFile` the project does not carry (a reference Xcode reads as a
 * damaged project). An empty list is the state the plugin accepts, and it is
 * what `plugins/withAgentControls.js` proves after its edit — the phase, not
 * just this plugin's own file, because `addBuildSourceFileToGroup` appends and
 * a doubled attach leaves a doubled comment and a surplus `PBXBuildFile`
 * behind.
 * @param {{ hash: { project: { objects: { PBXBuildFile?: Record<string, unknown> | undefined } } } }} project
 * @param {SourcesBuildPhase | undefined} phase
 * @returns {string[]}
 */
export function sourcePhaseDefects(project, phase) {
  const entries = phase?.files ?? [];
  /** @type {Map<string, number>} */
  const comments = new Map();
  for (const entry of entries) {
    const comment = entry.comment;
    if (comment !== undefined) {
      comments.set(comment, (comments.get(comment) ?? 0) + 1);
    }
  }
  const defects = [];
  for (const [comment, count] of comments) {
    if (count > 1) {
      defects.push(`${comment} appears ${count} times`);
    }
  }
  const buildFiles = project.hash.project.objects.PBXBuildFile ?? {};
  for (const entry of entries) {
    if (entry.value !== undefined && buildFiles[entry.value] === undefined) {
      defects.push(
        `${entry.comment ?? entry.value} points at a PBXBuildFile the project does not carry`
      );
    }
  }
  return defects;
}

/**
 * The extension's AgentControls.swift: one AppIntent and one ControlWidget per
 * contract entry, plus the bundle index.swift splices in. Every url comes from
 * `urls` — this generator never spells one of its own.
 * @param {{ copy: Record<string, Record<string, string | undefined>>, urls: AgentControl[] }} params
 * @returns {string}
 */
export function agentControlsSwift({ copy, urls }) {
  const declarations = urls.map(control => {
    const symbol = CONTROL_SYMBOLS[control.id];
    if (symbol === undefined) {
      throw new Error(`agentControlsSwift: no SF Symbol for control \`${control.id}\``);
    }
    const name = controlTypeName(control.id);
    const label = swiftLiteral(englishCopy(copy, control.copyKey));
    const description = swiftLiteral(englishCopy(copy, descriptionCopyKey(control.copyKey)));
    // AppIntents' `OpenURLIntent` (iOS 18) opens the url through its single
    // initializer, `init(_:)`. The labeled `OpenURLIntent(url:)` does not exist:
    // the extension fails to compile with "extraneous argument label 'url:' in
    // call", which fails the whole iOS build.
    return `@available(${CONTROL_AVAILABILITY}, *)
struct ${name}Intent: AppIntent {
  static var title: LocalizedStringResource = ${label}

  func perform() async throws -> some IntentResult & OpensIntent {
    return .result(opensIntent: OpenURLIntent(URL(string: ${swiftLiteral(control.url)})!))
  }
}

@available(${CONTROL_AVAILABILITY}, *)
struct ${name}Control: ControlWidget {
  var body: some ControlWidgetConfiguration {
    StaticControlConfiguration(kind: ${swiftLiteral(controlKind(control.id))}) {
      ControlWidgetButton(action: ${name}Intent()) {
        Label(${label}, systemImage: ${swiftLiteral(symbol)})
      }
    }
    .displayName(${label})
    .description(${description})
  }
}`;
  });

  const bundle = urls.map(control => `    ${controlTypeName(control.id)}Control()`).join('\n');

  return `${SWIFT_HEADER}

${declarations.join('\n\n')}

@available(${CONTROL_AVAILABILITY}, *)
struct AgentControlsBundle: WidgetBundle {
  var body: some Widget {
${bundle}
  }
}
`;
}

/** The `var body: some Widget {` inside an expo-widgets generated widget bundle. */
const BUNDLE_BODY_ANCHOR =
  /(struct\s+[A-Za-z_]\w*\s*:\s*WidgetBundle\s*\{[\s\S]*?var\s+body\s*:\s*some\s+Widget\s*\{)/;

/**
 * Splice the control bundle into the `@main` bundle expo-widgets generated, so
 * the extension ships controls and widgets from one entry point. Throws — never
 * silently skips — when the generated template no longer carries the anchor.
 * @param {string} indexSwift
 * @returns {string}
 */
export function injectAgentControlBundle(indexSwift) {
  const match = BUNDLE_BODY_ANCHOR.exec(indexSwift);
  if (match === null) {
    throw new Error(
      'injectAgentControlBundle: index.swift carries no `WidgetBundle` body — the expo-widgets template changed'
    );
  }
  const anchor = match[1];
  const insertAt = match.index + anchor.length;
  const lineStart = indexSwift.lastIndexOf('\n', insertAt - 1) + 1;
  const bodyIndent = `${/^[\t ]*/.exec(indexSwift.slice(lineStart))[0]}  `;
  // Controls need iOS 18 while the extension deploys to 16.4, so the splice is
  // availability-gated exactly like expo-widgets gates a configured widget.
  const splice = `\n${bodyIndent}if #available(${CONTROL_AVAILABILITY}, *) {\n${bodyIndent}  ${AGENT_CONTROLS_BUNDLE_CALL}\n${bodyIndent}}`;
  return `${indexSwift.slice(0, insertAt)}${splice}${indexSwift.slice(insertAt)}`;
}

/**
 * Android's static-shortcut file: one shortcut per contract entry, each carrying
 * exactly one VIEW intent at the contract url. The intent names the app's own
 * launcher activity (`targetPackage` / `targetClass`) instead of relying on the
 * system to resolve the url through the app's implicit intent filters — the app
 * already declares `android:scheme="kiloapp"`, so the explicit target is only a
 * more direct route to the one deep-link implementation. The Android slice
 * writes the file; the urls and the labels are this contract's.
 * @param {{ urls: AgentControl[], targetPackage: string, targetClass: string }} params
 * @returns {string}
 */
export function agentShortcutsXml({ urls, targetPackage, targetClass }) {
  const shortcuts = urls.map(control => {
    const metadata = AGENT_SHORTCUTS_META_DATA.find(entry => entry.id === control.id);
    if (metadata === undefined) {
      throw new Error(`agentShortcutsXml: no shortcut metadata for control \`${control.id}\``);
    }
    return `  <shortcut
    android:shortcutId="${shortcutId(control.id)}"
    android:enabled="true"
    android:shortcutShortLabel="@string/${metadata.shortLabelResource}"
    android:shortcutLongLabel="@string/${metadata.longLabelResource}">
    <intent
      android:action="android.intent.action.VIEW"
      android:targetPackage="${escapeXml(targetPackage)}"
      android:targetClass="${escapeXml(targetClass)}"
      android:data="${escapeXml(control.url)}" />
  </shortcut>`;
  });

  return `<?xml version="1.0" encoding="utf-8"?>
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
${shortcuts.join('\n')}
</shortcuts>
`;
}

/**
 * The copy, expanded to `[key, value]` pairs per language. The key is the
 * English string — the `LocalizedStringKey` Swift binds — so iOS writes the
 * pairs into the extension's `<tag>.lproj/Localizable.strings` verbatim, and
 * Android maps the same pairs onto AGENT_SHORTCUTS_META_DATA's resource names.
 * @param {Record<string, Record<string, string | undefined>>} copy
 * @returns {Record<string, [string, string][]>}
 */
export function agentShortcutStrings(copy) {
  /** @type {Record<string, [string, string][]>} */
  const byLanguage = {};
  for (const tag of Object.keys(copy)) {
    /** @type {[string, string][]} */
    const pairs = [];
    for (const metadata of AGENT_SHORTCUTS_META_DATA) {
      for (const key of [metadata.copyKey, metadata.descriptionCopyKey]) {
        pairs.push([englishCopy(copy, key), requiredCopy(copy, tag, key)]);
      }
    }
    byLanguage[tag] = pairs;
  }
  return byLanguage;
}
