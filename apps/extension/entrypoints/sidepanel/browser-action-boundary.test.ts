/* eslint-disable max-lines, max-depth, import/no-nodejs-modules, jest/no-conditional-in-test, prefer-destructuring -- This Node-only inventory walks syntax, including alias and mutation fixtures. */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const panel = 'entrypoints/sidepanel/';
const shared = 'src/shared/';
const sources = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sources(path);
    }
    return /\.tsx?$/u.test(path) && !/\.test\./u.test(path) ? [path] : [];
  });
const sourceFiles = [...sources(join(root, 'entrypoints')), ...sources(join(root, shared))];
const parse = (path: string, text: string): ts.SourceFile =>
  ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
const member = (node: ts.Node): string | undefined => {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) {
    return node.text;
  }
  return undefined;
};
const enclosing = (node: ts.Node): string => {
  for (
    let parent: ts.Node | undefined = node.parent;
    parent !== undefined;
    parent = parent.parent
  ) {
    if (ts.isFunctionDeclaration(parent) && parent.name !== undefined) {
      return parent.name.text;
    }
    if (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) {
      if (ts.isVariableDeclaration(parent.parent)) {
        return member(parent.parent.name) ?? '<anonymous>';
      }
      if (ts.isPropertyAssignment(parent.parent)) {
        return member(parent.parent.name) ?? '<anonymous>';
      }
    }
    if (ts.isMethodDeclaration(parent)) {
      return member(parent.name) ?? '<anonymous>';
    }
  }
  return '<module>';
};
const runnerNames = new Set([
  'runSafeLlmTurn',
  'runDangerousLlmTurn',
  'runLlmTurn',
  'runWorkflow',
  'runToolCalls',
  'executeWorkflowToolCall',
  'executeEvalToolCall',
]);
const nativeActions = new Set([
  'getViewportScreenshotWithTabsApi',
  'getViewportScreenshot',
  'getPageSnapshotInTab',
  'getPageSnapshotInTabWithScripting',
  'discoverWebMcpToolsInTab',
  'executeWebMcpToolInTab',
  'evalInTabWithScripting',
]);
const adapterImports = new Set([
  ...runnerNames,
  ...nativeActions,
  'evalInTab',
  'navigateTab',
  'executeSafeToolCall',
  'createSafeToolExecutor',
  'discoverWebMcpTools',
  'executeWebMcpToolCall',
  'executeRemoteMcpToolCall',
  'executeWebSearchToolCall',
  'createWebSearchExecutor',
  'callRemoteMcpTool',
]);
const allowedImports = new Set([
  ...[
    'agent-turn-runners.ts',
    'browser-run-context.ts',
    'agent-llm-turn-runner.ts',
    'agent-safe-llm-turn-runner.ts',
    'agent-workflow-tool-runtime.ts',
    'agent-remote-mcp-tool-runtime.ts',
    'agent-web-search-tool-runtime.ts',
  ].map(path => `${panel}${path}`),
  `${shared}agent-llm-turn-runner-core.ts`,
  `${shared}agent-workflow-runner.ts`,
  'entrypoints/background.ts',
]);
const runnerSites = new Map<string, readonly string[]>([
  [`${panel}browser-run-context.ts:runBrowserTurn`, ['runSafeLlmTurn', 'runDangerousLlmTurn']],
  [`${panel}browser-run-context.ts:runBrowserWorkflow`, ['executeWorkflowToolCall']],
  [`${panel}agent-llm-turn-runner.ts:runDangerousLlmTurn`, ['runLlmTurn']],
  [`${panel}agent-safe-llm-turn-runner.ts:runSafeLlmTurn`, ['runLlmTurn']],
  [`${panel}agent-llm-turn-runner.ts:executeToolCall`, ['executeWorkflowToolCall']],
  [`${panel}agent-safe-llm-turn-runner.ts:executeToolCall`, ['executeWorkflowToolCall']],
  [`${panel}agent-workflow-tool-runtime.ts:executeRunWorkflow`, ['runWorkflow']],
  [`${shared}agent-llm-turn-runner-core.ts:continueConversation`, ['runToolCalls']],
]);
// These native adapters receive calls from the guarded wrappers above, not model-selected dispatch functions.
const guardedAdapters = new Set([
  `${panel}agent-workflow-runtime.ts:evalInTab`,
  `${panel}agent-workflow-runtime.ts:navigateTab`,
  `${panel}agent-safe-tool-runtime.ts:readPageSnapshot`,
  `${panel}agent-safe-tool-runtime.ts:readViewportScreenshot`,
  `${panel}agent-web-mcp-tool-runtime.ts:discoverWebMcpTools`,
  `${panel}agent-web-mcp-tool-runtime.ts:executeWebMcpToolCall`,
  `${panel}agent-remote-mcp-tool-runtime.ts:executeRemoteMcpToolCall`,
  `${panel}remote-mcp-client.ts:callRemoteMcpTool`,
  `${panel}agent-web-search-tool-runtime.ts:postSearch`,
  `${shared}agent-workflow-runner.ts:runWorkflow`,
  'entrypoints/background.ts:handleTabDebuggerRequest',
  ...[
    'getViewportScreenshotWithTabsApi',
    'evalInTab',
    'evalInTabWithScripting',
    'getPageSnapshotInTabWithScripting',
    'discoverWebMcpToolsInTab',
    'executeWebMcpToolInTab',
    'runInjectedEval',
    'runInjectedWebMcpExecute',
  ].map(name => `${shared}tab-debugger.ts:${name}`),
]);
const legacyAdapters = new Set([
  // Old executeEvalToolCall(event) remains a compatibility adapter. Remove this exception when guardless local callers retire.
  `${panel}agent-eval-runtime.ts:executeEvalToolCall`,
  // The old tab-list request helper is read-only. Remove this exception when it becomes a list-only API.
  `${panel}use-tab-debugger.ts:sendTabDebuggerRequest`,
]);
const leaf = (name: string): string => name.split('.').at(-1) ?? name;
const rawSink = (name: string): boolean =>
  /(?:^|\.)(?:sendMessage|executeScript|captureVisibleTab|callTool|executeTool)$/u.test(name) ||
  /(?:^|\.)(?:tabs|tabsApi)\.update$/u.test(name) ||
  /(?:^|\.)(?:debugger|debuggerApi)\.sendCommand$/u.test(name) ||
  /(?:^|\.)(?:runtime|scripting|tabs)\.\*$/u.test(name) ||
  name === 'context.fetch';

const inspect = (path: string, text: string): string[] => {
  const source = parse(path, text);
  const aliases = new Map<string, ts.Expression | string>();
  const failures: string[] = [];
  const names = (expression: ts.Expression, seen = new Set<string>()): string[] => {
    if (ts.isIdentifier(expression)) {
      if (seen.has(expression.text)) {
        return [expression.text];
      }
      const target = aliases.get(expression.text);
      if (target === undefined) {
        return [expression.text];
      }
      if (typeof target === 'string') {
        return [target];
      }
      return names(target, new Set([...seen, expression.text]));
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const key = ts.isPropertyAccessExpression(expression)
        ? expression.name
        : expression.argumentExpression;
      const constant = ts.isIdentifier(key) ? aliases.get(key.text) : undefined;
      const constantProperty =
        constant !== undefined && typeof constant !== 'string' && ts.isStringLiteralLike(constant)
          ? constant.text
          : '*';
      const property =
        ts.isPropertyAccessExpression(expression) || ts.isStringLiteralLike(key)
          ? member(key)
          : constantProperty;
      const base = expression.expression;
      if (ts.isIdentifier(base)) {
        const target = aliases.get(base.text);
        if (
          target !== undefined &&
          typeof target !== 'string' &&
          ts.isObjectLiteralExpression(target)
        ) {
          const value = target.properties.find(
            entry => entry.name !== undefined && member(entry.name) === property
          );
          if (value !== undefined && ts.isPropertyAssignment(value)) {
            return names(value.initializer, seen);
          }
          if (value !== undefined && ts.isShorthandPropertyAssignment(value)) {
            return names(value.name, seen);
          }
        }
      }
      return names(base, seen).map(name =>
        name === '<namespace>' ? (property ?? '*') : `${name}.${property ?? '*'}`
      );
    }
    if (ts.isConditionalExpression(expression)) {
      return [...names(expression.whenTrue, seen), ...names(expression.whenFalse, seen)];
    }
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isNonNullExpression(expression)
    ) {
      return names(expression.expression, seen);
    }
    if (
      ts.isCallExpression(expression) &&
      ts.isPropertyAccessExpression(expression.expression) &&
      expression.expression.name.text === 'bind'
    ) {
      return names(expression.expression.expression, seen);
    }
    return [];
  };
  const collect = (node: ts.Node): void => {
    // TypeScript 5.9 still exposes isTypeOnly; newer compiler declarations deprecate it without changing this syntax contract.
    // eslint-disable-next-line typescript/no-deprecated
    if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly !== true) {
      const bindings = node.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements.filter(element => !element.isTypeOnly)) {
          const original = binding.propertyName?.text ?? binding.name.text;
          aliases.set(binding.name.text, original);
          if (adapterImports.has(original) && !allowedImports.has(path)) {
            failures.push(`unguarded import ${original}`);
          }
        }
      } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        aliases.set(bindings.name.text, '<namespace>');
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      if (ts.isIdentifier(node.name)) {
        aliases.set(node.name.text, node.initializer);
      }
      if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (ts.isIdentifier(element.name)) {
            const property = member(element.propertyName ?? element.name);
            const [base] = names(node.initializer);
            if (base !== undefined && property !== undefined) {
              aliases.set(element.name.text, `${base}.${property}`);
            }
          }
        }
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      aliases.set(node.left.text, node.right);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  const hasGuard = (node: ts.CallExpression | ts.NewExpression): boolean =>
    (node.arguments ?? []).some(argument => {
      if (ts.isObjectLiteralExpression(argument)) {
        return argument.properties.some(
          property =>
            ts.isPropertyAssignment(property) &&
            member(property.name) === 'executionGuard' &&
            property.initializer.getText(source) !== 'undefined'
        );
      }
      if (
        ts.isCallExpression(argument) &&
        ts.isIdentifier(argument.expression) &&
        argument.expression.text === 'workflowContext'
      ) {
        return argument.arguments.length === 2;
      }
      return (
        ts.isIdentifier(argument) &&
        (argument.text === 'guard' || argument.text === 'executionGuard')
      );
    });
  const check = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const called = names(node.expression).map(name => name.replace(/\.(?:call|apply)$/u, ''));
      const site = `${path}:${enclosing(node)}`;
      for (const name of called) {
        const target = leaf(name);
        if (
          site === `${panel}browser-run-context.ts:withBoundTab` &&
          name === 'context.lease.run' &&
          node.arguments?.[1]?.getText(source) !== 'context.selectedTab.id'
        ) {
          failures.push(`${site}: missing bound local protection`);
        }
        if (
          runnerNames.has(target) &&
          (!(runnerSites.get(site)?.includes(target) ?? false) || !hasGuard(node))
        ) {
          failures.push(`${site}: unguarded ${target}`);
        }
        if (
          adapterImports.has(target) &&
          !runnerNames.has(target) &&
          !guardedAdapters.has(site) &&
          (!allowedImports.has(path) || !hasGuard(node))
        ) {
          failures.push(`${site}: unguarded adapter ${target}`);
        }
        if (
          (rawSink(name) || (ts.isNewExpression(node) && name === 'Function')) &&
          !guardedAdapters.has(site) &&
          !legacyAdapters.has(site)
        ) {
          failures.push(`${site}: direct ${name}`);
        }
      }
    }
    if (ts.isNoSubstitutionTemplateLiteral(node) && !path.includes('#')) {
      // Only this fixed helper is an admitted injected adapter. Dynamic model code still requires runtime guards.
      const container = ts.isVariableDeclaration(node.parent)
        ? member(node.parent.name)
        : undefined;
      if (!(path === `${shared}agent-workflow-runner.ts` && container === 'PAGE_HELPERS_CODE')) {
        failures.push(...inspect(`${path}#${container ?? 'literal'}`, node.text));
      }
    }
    ts.forEachChild(node, check);
  };
  check(source);
  return [...new Set(failures)];
};
const functionBody = (source: ts.SourceFile, name: string): ts.Node => {
  let found: ts.Node | undefined = undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined
    ) {
      found = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (found === undefined) {
    throw new Error(`Missing execution entry ${name}`);
  }
  return found;
};
type CallMatcher = string | ((call: ts.CallExpression) => boolean);
const callPositions = (node: ts.Node, match: CallMatcher): number[] => {
  const found: number[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isCallExpression(child)) {
      const { expression } = child;
      const matches =
        typeof match === 'function'
          ? match(child)
          : (ts.isIdentifier(expression) && expression.text === match) ||
            (ts.isPropertyAccessExpression(expression) && expression.name.text === match);
      if (matches) {
        found.push(child.pos);
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
};
const isChatInputWrite = (call: ts.CallExpression): boolean => {
  const { expression } = call;
  // Exclude only the known pending-map write; other set calls can consume aliased input.
  return (
    expression.getText() !== 'pendingAdmissionsRef.current.set' &&
    ((ts.isIdentifier(expression) && expression.text === 'set') ||
      (ts.isPropertyAccessExpression(expression) && expression.name.text === 'set'))
  );
};
const admissionPrecedesAction = (node: ts.Node, guard: string, action: CallMatcher): boolean => {
  const [gate] = callPositions(node, guard);
  const [firstAction] = callPositions(node, action);
  return gate !== undefined && firstAction !== undefined && gate < firstAction;
};

describe('browser action boundary inventory', () => {
  it('permits only the inventoried guarded runners and browser adapters', () => {
    expect(
      sourceFiles.flatMap(path => inspect(relative(root, path), readFileSync(path, 'utf8')))
    ).toStrictEqual([]);
  });

  it.each([
    [
      'chat alias',
      "import { runSafeLlmTurn as start } from './agent-turn-runners'; start(options);",
    ],
    [
      'workflow namespace element',
      "import * as tools from './agent-workflow-tool-runtime'; tools['executeWorkflowToolCall'](event, options);",
    ],
    [
      'adapter namespace element',
      "import * as tools from './agent-workflow-runtime'; tools['evalInTab'](7, code);",
    ],
    [
      'direct dispatch alias',
      "const send = browser['runtime']['sendMessage']; send({type: 'eval'});",
    ],
    [
      'bound dispatch',
      'const send = browser.runtime.sendMessage.bind(browser.runtime); send(message);',
    ],
    ['destructured dispatch', 'const { sendMessage: send } = browser.runtime; send(message);'],
    [
      'object alias',
      "const actions = { send: browser.runtime.sendMessage }; actions['send'](message);",
    ],
    [
      'assigned dispatch',
      'let send; send = browser.runtime.sendMessage; send.call(browser.runtime, message);',
    ],
    ['direct script', "browser['scripting']['executeScript'](script);"],
    ['constant element', "const method = 'sendMessage'; browser.runtime[method](message);"],
    ['unknown element', 'browser.runtime[method](message);'],
    ['static injected bypass', 'const script = `browser.runtime.sendMessage(message)`;'],
    [
      'import without call',
      "import { evalInTab as evaluate } from './agent-workflow-runtime'; export { evaluate };",
    ],
  ])('rejects a new %s bypass', (_label, text) => {
    expect(inspect(`${panel}new-entry.ts`, text).length).toBeGreaterThan(0);
  });

  it('rejects a missing guard at the existing chat adapter', () => {
    const path = `${panel}browser-run-context.ts`;
    const text = readFileSync(join(root, path), 'utf8');
    const broken = text.replace(
      'executionGuard: guard,\n      fetch:',
      'executionGuard: undefined,\n      fetch:'
    );
    expect(broken).not.toBe(text);
    expect(inspect(path, broken)).toContain(`${path}:runBrowserTurn: unguarded runSafeLlmTurn`);
  });

  it.each(['undefined', '8'])(
    'rejects shared run setup that replaces the bound protection tab with %s',
    replacement => {
      const path = `${panel}browser-run-context.ts`;
      const text = readFileSync(join(root, path), 'utf8');
      const broken = text.replace(
        /,\s*context\.selectedTab\.id(?=\s*,?\s*\))/u,
        `, ${replacement}`
      );
      expect(broken).not.toBe(text);
      expect(inspect(path, broken)).toContain(
        `${path}:withBoundTab: missing bound local protection`
      );
    }
  );

  it('permits a11 to use only the guarded public context API', () => {
    expect(
      inspect(
        `${panel}browser-task-runner.ts`,
        "import { runBrowserTurn } from './browser-run-context'; export const run = (context: BrowserRunContext, events: AgentConversationEvent[]) => runBrowserTurn(context, events);"
      )
    ).toStrictEqual([]);
  });

  it.each([
    {
      action: isChatInputWrite,
      entry: 'submitDraft',
      file: 'agent-chat-panel.tsx',
      guard: 'acquireLocal',
      label: 'chat draft',
    },
    {
      action: 'submitMessage',
      entry: 'submitQueuedMessage',
      file: 'agent-chat-panel.tsx',
      guard: 'acquireLocal',
      label: 'queued drain',
    },
    {
      action: isChatInputWrite,
      entry: 'submitQueuedMessage',
      file: 'agent-chat-panel.tsx',
      guard: 'acquireLocal',
      label: 'queued input consumption',
    },
    {
      action: 'setRunRequest',
      entry: 'handleRun',
      file: 'workflow-settings.tsx',
      guard: 'acquireLocal',
      label: 'Settings and parameter prompt',
    },
    {
      action: 'runBrowserTurn',
      entry: 'startTurn',
      file: 'agent-chat-panel.tsx',
      guard: 'setupRunContext',
      label: 'chat continuation',
    },
    {
      action: 'continueConversation',
      entry: 'continueConversation',
      file: '../../src/shared/agent-llm-turn-runner-core.ts',
      guard: 'guard',
      label: 'recursive continuation',
    },
  ])('keeps admission before execution for $label', ({ file, entry, guard, action }) => {
    const path = join(root, panel, file);
    const body = functionBody(parse(path, readFileSync(path, 'utf8')), entry);
    expect(admissionPrecedesAction(body, guard, action)).toBe(true);
  });

  it.each([
    ['draft clearing', 'submitDraft', "store.set(draftAtomFamily(conversationId), '');"],
    [
      'draft queueing',
      'submitDraft',
      'store.set(queuedMessageAtomFamily(conversationId), current => appendQueuedMessage(current, text));',
    ],
    [
      'queue consumption',
      'submitQueuedMessage',
      'store.set(queuedMessageAtomFamily(conversationId), undefined);',
    ],
    [
      'aliased draft clearing',
      'submitDraft',
      "const inputStore = store; inputStore.set(draftAtomFamily(conversationId), '');",
    ],
    [
      'aliased queue consumption',
      'submitQueuedMessage',
      'const inputStore = store; inputStore.set(queuedMessageAtomFamily(conversationId), undefined);',
    ],
    [
      'draft atom alias clearing',
      'submitDraft',
      "const draft = draftAtomFamily(conversationId); store.set(draft, '');",
    ],
    [
      'queued atom alias consumption',
      'submitQueuedMessage',
      'const queuedAtom = queuedMessageAtomFamily(conversationId); store.set(queuedAtom, undefined);',
    ],
  ])('rejects %s before admission', (_label, entry, mutation) => {
    const path = join(root, panel, 'agent-chat-panel.tsx');
    const source = parse(path, readFileSync(path, 'utf8'));
    const original = functionBody(source, entry).getText(source);
    const gate = 'const admission = await getBrowserExecutionCoordinator().acquireLocal();';
    const broken = original.replace(gate, `${mutation}\n${gate}`);
    expect(broken).not.toBe(original);
    const body = functionBody(parse(path, `const ${entry} = ${broken};`), entry);
    expect(admissionPrecedesAction(body, 'acquireLocal', isChatInputWrite)).toBe(false);
  });

  it('keeps the workflow effect on the admitted shared context path', () => {
    const path = join(root, panel, 'agent-chat-panel.tsx');
    const source = parse(path, readFileSync(path, 'utf8'));
    const reservation = callPositions(source, 'takeWorkflowLease');
    const workflow = callPositions(source, 'runBrowserWorkflow');
    expect(reservation.length).toBeGreaterThan(0);
    expect(workflow).toHaveLength(1);
    expect(reservation.at(-1)).toBeLessThan(workflow[0] ?? -1);
  });

  it('inventories static injected helpers without pretending to prove model JavaScript', () => {
    const path = join(root, shared, 'agent-workflow-runner.ts');
    const helpers = functionBody(parse(path, readFileSync(path, 'utf8')), 'PAGE_HELPERS_CODE');
    if (!ts.isNoSubstitutionTemplateLiteral(helpers)) {
      throw new Error('Review the changed injected helper format');
    }
    const injected = parse('workflow-page-helpers.ts', helpers.text);
    expect(callPositions(injected, 'click').length).toBeGreaterThan(0);
    expect(callPositions(injected, 'dispatchEvent').length).toBeGreaterThan(0);
  });
});
