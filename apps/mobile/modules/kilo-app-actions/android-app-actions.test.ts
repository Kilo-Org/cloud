// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { readdirSync, readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  APP_ACTION_IDS,
  APP_ACTION_SLUGS,
  type AppActionId,
  parseAppActionUrl,
} from '../../src/lib/app-actions/app-action-contract';

/**
 * The Android entry points are native sources, so this suite reads them: the
 * four actions are addressable from outside the app only if the manifest, the
 * Kotlin translation and the capability declarations all name the same contract
 * (`src/lib/app-actions/app-action-contract.ts`). Nothing here proves the
 * device; it proves the sources agree.
 */

const ANDROID = './android/src/main';
const KOTLIN = `${ANDROID}/java/expo/modules/kiloappactions`;

function readSource(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
}

const MANIFEST = readSource(`${ANDROID}/AndroidManifest.xml`);
const MODULE_SOURCE = readSource(`${KOTLIN}/KiloAppActionsModule.kt`);
const ACTIVITY_SOURCE = readSource(`${KOTLIN}/KiloActionActivity.kt`);
const SHORTCUTS_XML = readSource(`${ANDROID}/res/xml/shortcuts.xml`);

/** The custom intent action prefix the exported entry point answers. */
const ACTION_PREFIX = 'com.kilocode.kiloapp.action.';

/** `StartAgent` → `START_AGENT`. */
function actionName(action: AppActionId): string {
  return action.replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/** The manifest/declaration action string for one contract action. */
function actionString(action: AppActionId): string {
  return `${ACTION_PREFIX}${actionName(action)}`;
}

/** The action strings of the contract, for an order-insensitive comparison. */
function contractActionStrings(): string[] {
  return APP_ACTION_IDS.map(action => actionString(action));
}

/** The values, sorted for an order-insensitive comparison. */
function sorted(values: readonly string[]): string[] {
  return values.toSorted((left, right) => left.localeCompare(right));
}

describe('the four actions the entry point answers', () => {
  it('names every action string in the manifest', () => {
    for (const action of APP_ACTION_IDS) {
      expect(MANIFEST).toContain(`android:name="${actionString(action)}"`);
    }
  });

  it('carries no action string the contract does not define', () => {
    const declared = [
      ...MANIFEST.matchAll(/android:name="com\.kilocode\.kiloapp\.action\.([A-Z_]+)"/g),
    ].map(match => match[1] ?? '');
    expect(sorted(declared)).toEqual(sorted(APP_ACTION_IDS.map(action => actionName(action))));
  });

  it('maps each action string to its contract slug', () => {
    const pairs = [...ACTIVITY_SOURCE.matchAll(/(ACTION_[A-Z_]+) to "([a-z][a-z-]*)"/g)];
    const slugs = new Map(pairs.map(([, constant, slug]) => [constant, slug]));
    for (const action of APP_ACTION_IDS) {
      expect(slugs.get(`ACTION_${actionName(action)}`), action).toBe(APP_ACTION_SLUGS[action]);
    }
    expect(pairs).toHaveLength(APP_ACTION_IDS.length);
  });
});

/** A `kiloapp:///actions/<slug>…` literal, the contract's canonical URL form. */
const ACTION_URL_LITERAL = /kiloapp:\/\/\/actions\/[^\s"'<>`)\]]+/g;

describe('the action URLs in the sources', () => {
  it('parses with the shared contract, and covers the four actions', () => {
    const sources = [
      ['AndroidManifest.xml', MANIFEST],
      ['KiloAppActionsModule.kt', MODULE_SOURCE],
      ['KiloActionActivity.kt', ACTIVITY_SOURCE],
      ['shortcuts.xml', SHORTCUTS_XML],
    ] as const;
    const covered = new Set<AppActionId>();
    for (const [file, source] of sources) {
      for (const [literal] of source.matchAll(ACTION_URL_LITERAL)) {
        const request = parseAppActionUrl(literal);
        expect(request, `${file} carries an unparseable action URL: ${literal}`).not.toBeNull();
        if (request !== null) {
          covered.add(request.action);
        }
      }
    }
    expect(sorted([...covered])).toEqual(sorted([...APP_ACTION_IDS]));
  });
});

/** The blocks between `<intent-filter>` and its closing tag. */
function intentFilters(manifest: string): string[] {
  return [...manifest.matchAll(/<intent-filter[^>]*>([\s\S]*?)<\/intent-filter>/g)].map(
    match => match[1] ?? ''
  );
}

describe('the exported entry point', () => {
  it('is exported and single-top', () => {
    const activityTag = /<activity\b[^>]*KiloActionActivity[^>]*>/.exec(MANIFEST)?.[0] ?? '';
    expect(activityTag).toContain('android:exported="true"');
    expect(activityTag).toContain('android:launchMode="singleTop"');
  });

  it('gives every intent-filter its own action', () => {
    const filters = intentFilters(MANIFEST);
    const actionsPerFilter = filters.map(filter =>
      [...filter.matchAll(/<action\s+android:name="([^"]+)"/g)].map(match => match[1])
    );
    // One filter per action, plus the VIEW filter that carries the URL dialect.
    expect(actionsPerFilter).toHaveLength(APP_ACTION_IDS.length + 1);
    for (const names of actionsPerFilter) {
      expect(names).toHaveLength(1);
    }
    const declared = new Set(actionsPerFilter.flat());
    for (const action of APP_ACTION_IDS) {
      expect(declared.has(actionString(action))).toBe(true);
    }
    const view = filters.find(filter => filter.includes('android.intent.action.VIEW')) ?? '';
    expect(view).toContain('android:scheme="kiloapp"');
    expect(view).toContain('android:host="actions"');
  });

  it('points the shortcuts meta-data at the capability file', () => {
    expect(MANIFEST).toContain('android:name="android.app.shortcuts"');
    expect(MANIFEST).toContain('android:resource="@xml/shortcuts"');
  });
});

type XmlElement = {
  name: string;
  attributes: string;
  children: XmlElement[];
};

/**
 * Parse these declaration files: elements, attributes, balanced tags. They hold
 * no text content and no CDATA, so balanced tags are their well-formedness.
 * A malformed file throws instead of returning a partial tree.
 */
function parseXml(xml: string): XmlElement {
  const source = xml.replaceAll(/<!--[\s\S]*?-->/g, '').replaceAll(/<\?xml[^>]*\?>/g, '');
  const document: XmlElement = { name: '#document', attributes: '', children: [] };
  const stack: XmlElement[] = [document];
  const tag = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  let cursor = 0;
  let match: RegExpExecArray | null = tag.exec(source);
  while (match !== null) {
    const text = source.slice(cursor, match.index);
    if (text.trim().length > 0) {
      throw new Error(`Text outside a tag: ${text.trim()}`);
    }
    cursor = match.index + match[0].length;
    const closing = match[1] ?? '';
    const name = match[2] ?? '';
    const attributes = match[3] ?? '';
    const selfClosing = match[4] ?? '';
    if (closing === '/') {
      const open = stack.pop();
      if (open === undefined || open.name !== name) {
        throw new Error(`Unbalanced </${name}>`);
      }
    } else {
      const parent = stack.at(-1);
      if (parent === undefined) {
        throw new Error(`No parent for <${name}>`);
      }
      const element: XmlElement = { name, attributes, children: [] };
      parent.children.push(element);
      if (selfClosing !== '/') {
        stack.push(element);
      }
    }
    match = tag.exec(source);
  }
  if (source.slice(cursor).trim().length > 0) {
    throw new Error('Text after the last tag');
  }
  if (stack.length !== 1) {
    throw new Error('Unclosed element');
  }
  const elements = document.children;
  expect(elements).toHaveLength(1);
  const root = elements[0];
  if (root === undefined) {
    throw new Error('Missing root element');
  }
  return root;
}

const DECLARATIONS = [{ file: 'shortcuts.xml', xml: SHORTCUTS_XML, root: 'shortcuts' }] as const;

describe('the capability declarations', () => {
  it('ships only the capability file the manifest references', () => {
    // A capability declaration is only effective under the meta-data that
    // points at it. `actions.xml` carried a second, identical copy of the same
    // four capabilities with no reference to any of them from the manifest, so
    // it declared nothing and only duplicated `shortcuts.xml` — the file
    // `android.app.shortcuts` names.
    const directory = fileURLToPath(new URL(`${ANDROID}/res/xml/`, import.meta.url));
    expect(readdirSync(directory).toSorted()).toEqual(['shortcuts.xml']);
  });

  it.each(DECLARATIONS)('$file is well-formed under a $root root element', ({ xml, root }) => {
    expect(parseXml(xml).name).toBe(root);
  });

  it('rejects a document whose tags do not balance', () => {
    expect(() => parseXml('<actions><capability></actions>')).toThrow(/Unbalanced/);
  });

  it.each(DECLARATIONS)('$file declares one capability per action', ({ xml }) => {
    const children = parseXml(xml).children;
    expect(children).toHaveLength(APP_ACTION_IDS.length);
    for (const child of children) {
      expect(child.name).toBe('capability');
    }
    const named = children.map(child => /android:name="([^"]+)"/.exec(child.attributes)?.[1] ?? '');
    expect(sorted(named)).toEqual(sorted(contractActionStrings()));
  });
});

describe('the module hand-off', () => {
  it('registers the JS dispatcher', () => {
    expect(MODULE_SOURCE).toContain('package expo.modules.kiloappactions');
    expect(MODULE_SOURCE).toContain('Name("KiloAppActions")');
    expect(MODULE_SOURCE).toContain('Function("registerAppActionDispatcher")');
    expect(MODULE_SOURCE).toContain('JavaScriptFunction<JavaScriptValue>');
  });

  it('hops onto the JS thread through the runtime scheduler', () => {
    // A JSI function may only be invoked on the JS thread, and the entry point
    // calls in from the main thread. `AppContext.reactContext` is a plain
    // Android `Context` on this platform, so the runtime's own scheduler is the
    // hop that exists; invoking the handler on the caller's thread is a native
    // crash, never a fallback.
    expect(MODULE_SOURCE).toContain('appContext.runtime.schedule');
    expect(MODULE_SOURCE).not.toContain('runOnJSQueueThread');
  });

  it('buffers what arrives before registration and returns it to JS', () => {
    expect(MODULE_SOURCE).toMatch(/private val buffered = mutableListOf<String>\(\)/);
    expect(MODULE_SOURCE).toMatch(/fun register\([\s\S]*?\): List<String> = synchronized\(lock\)/);
    expect(MODULE_SOURCE).toMatch(/val pending = buffered\.toList\(\)/);
    expect(MODULE_SOURCE).toMatch(/buffered\.clear\(\)/);
    expect(MODULE_SOURCE).toMatch(/fun dispatch\(payload: String\): Boolean/);
  });

  it('returns the dispatcher result to a caller that asked for it', () => {
    expect(MODULE_SOURCE).toContain('Function("completeAppAction")');
    expect(ACTIVITY_SOURCE).toContain('AppActionDispatcher.dispatch(payload)');
    expect(ACTIVITY_SOURCE).toContain('AppActionDispatcher.await(payload)');
    expect(ACTIVITY_SOURCE).toContain('KiloActionContract.EXTRA_RESULT');
    expect(ACTIVITY_SOURCE).toContain('setResult(');
  });
});
