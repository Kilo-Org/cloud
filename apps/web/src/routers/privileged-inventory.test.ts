import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { rootRouter } from './root-router';
import { appShellProceduresRouter } from './app-shell-procedures-router';
import {
  ADMIN_AREA_POLICIES,
  ADMIN_STEP_UP_SELF_GUARDED_ROUTES,
  TARGET_ID_FIELD_BY_ADMIN_PROCEDURE,
  actionClassForAdminProcedure,
  actionClassForRoute,
  actionClassForEntry,
  findPrivilegedInventoryEntry,
  internalElevationSites,
  privilegedGuardTiers,
  resolvesOwnStepUp,
  targetIdFieldForAdminProcedure,
  targetIdFromInput,
  targetKindForInputField,
  type StaffRoleRead,
} from '@kilocode/web-shared/lib/admin/privileged-inventory';
import { isOperationStepUpClass } from '@kilocode/web-shared/lib/admin/step-up-policy';
import {
  ADMIN_ONLY_TRPC_NAMESPACES,
  ADMIN_ONLY_TRPC_PROCEDURES,
  isAdminEdgePath,
} from '@kilocode/web-shared/lib/admin/admin-network-policy';
import {
  SUPPORT_NEVER_KEYS,
  SUPPORT_READ_ALLOWLIST,
  SUPPORT_WRITE_ALLOWLIST,
} from '@kilocode/web-shared/lib/admin/support-access';
import {
  organizationAdminMutationProcedure,
  organizationAdminProcedure,
  organizationBillingMemberMutationProcedure,
  organizationBillingMemberProcedure,
  organizationBillingMutationProcedure,
  organizationBillingProcedure,
  organizationMemberMutationProcedure,
  organizationMemberOnlyMutationProcedure,
  organizationMemberProcedure,
} from '@kilocode/web-shared/routers/organizations/utils';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const APP_ROOT = path.join(REPO_ROOT, 'apps/web/src/app');

const BROAD_WILDCARDS = new Set(['organizations.*', 'codeIndexing.*']);

type ProcedureDef = {
  _def?: {
    type?: string;
    middlewares?: readonly unknown[];
    inputs?: readonly unknown[];
    resolver?: unknown;
  };
};

type DiscoveredRoute = {
  file: string;
  route: string;
  methods: string[];
  explicitAdminGuard: boolean;
  organizationContext: boolean;
  /** Reaches the staff guard through a shared REST admission helper. */
  staffAdmission: boolean;
};

function walkFiles(root: string): string[] {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(entry.parentPath, entry.name);
    return entry.isDirectory() ? [] : [entryPath];
  });
}

function readRepoFile(relativeFile: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativeFile), 'utf8');
}

type AstNode = { type: string; start: number; end: number; [key: string]: unknown };
type ParsedFile = { source: string; program: AstNode; nodes: AstNode[] };

/**
 * The repository's shared oxc syntax tree (`tools/lib/ast.mjs`, the parser
 * oxlint runs). It is an ES module. Jest hands tests a CommonJS-only copy of
 * `node:module` whose require cannot load it; `process.getBuiltinModule`
 * returns Node's own, whose require loads it synchronously (Node 24).
 */
const { parseSourceFile, walk } = process.getBuiltinModule('node:module').createRequire(__filename)(
  path.join(REPO_ROOT, 'tools/lib/ast.mjs')
) as {
  parseSourceFile: (
    file: string,
    text: string
  ) => { program: AstNode; errors: readonly { message: string }[] };
  walk: (node: AstNode, visit: (node: AstNode) => void) => void;
};

/** Parses source (the file name picks TS or TSX) and lists every node, parents first. */
function parseSource(file: string, source: string): ParsedFile {
  const { program, errors } = parseSourceFile(file, source);
  if (errors.length > 0) throw new Error(`${file}: cannot parse: ${errors[0]?.message}`);
  const nodes: AstNode[] = [];
  walk(program, node => nodes.push(node));
  return { source, program, nodes };
}

const parsedRepoFiles = new Map<string, ParsedFile>();

function parseRepoFile(relativeFile: string): ParsedFile {
  const cached = parsedRepoFiles.get(relativeFile);
  if (cached) return cached;
  const parsed = parseSource(relativeFile, readRepoFile(relativeFile));
  parsedRepoFiles.set(relativeFile, parsed);
  return parsed;
}

function childNode(node: AstNode | null | undefined, key: string): AstNode | null {
  const value = node?.[key];
  return typeof value === 'object' && value !== null && 'type' in value ? (value as AstNode) : null;
}

function childNodes(node: AstNode, key: string): AstNode[] {
  const value = node[key];
  return Array.isArray(value)
    ? value.filter(
        (item): item is AstNode => typeof item === 'object' && item !== null && 'type' in item
      )
    : [];
}

/** The name an identifier or a string literal carries. */
function nodeName(node: AstNode | null): string | null {
  if (node?.type === 'Identifier') return typeof node.name === 'string' ? node.name : null;
  if (node?.type === 'Literal') return typeof node.value === 'string' ? node.value : null;
  return null;
}

const EXPRESSION_WRAPPERS = new Set([
  'ParenthesizedExpression',
  'ChainExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
]);

function unwrap(node: AstNode | null): AstNode | null {
  let current = node;
  while (current && EXPRESSION_WRAPPERS.has(current.type))
    current = childNode(current, 'expression');
  return current;
}

function within(inner: AstNode, outer: AstNode): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/** `f` for `f(…)` and `obj.f(…)`; null for anything else. */
function calleeName(call: AstNode | null): string | null {
  if (call?.type !== 'CallExpression') return null;
  const callee = unwrap(childNode(call, 'callee'));
  if (callee?.type === 'MemberExpression' && callee.computed !== true) {
    return nodeName(childNode(callee, 'property'));
  }
  return callee?.type === 'Identifier' ? nodeName(callee) : null;
}

function callsOf(file: ParsedFile, name: string): AstNode[] {
  return file.nodes.filter(node => calleeName(node) === name);
}

function isClientSource(relativeFile: string, source: string): boolean {
  return (
    source.includes('use client') &&
    childNodes(parseRepoFile(relativeFile).program, 'body').some(
      statement => statement.directive === 'use client'
    )
  );
}

const ROLE_NAME = /^(?:is_admin|is(?:Kilo|Global|Platform|Staff)?Admin)$/;

/** Type annotations and declarations: a parameter named there exists only in a type. */
const TYPE_POSITIONS = new Set([
  'TSTypeAnnotation',
  'TSTypeAliasDeclaration',
  'TSInterfaceDeclaration',
]);

/**
 * Staff role references: member and optional-chain reads (`user.is_admin`,
 * `token?.isAdmin`), bracket reads with a literal key, and destructuring
 * (`const { is_admin } = user`, `({ isGlobalAdmin }) =>`). Type positions,
 * object literal keys, strings and comments are not references.
 */
function roleReferences(file: ParsedFile): AstNode[] {
  const typePositions = file.nodes.filter(node => TYPE_POSITIONS.has(node.type));
  const references: AstNode[] = [];
  for (const node of file.nodes) {
    if (node.type === 'MemberExpression') {
      const property = childNode(node, 'property');
      const literalKey =
        node.computed === true ? property?.type === 'Literal' : property?.type === 'Identifier';
      if (literalKey && ROLE_NAME.test(nodeName(property) ?? '')) references.push(node);
    } else if (node.type === 'ObjectPattern') {
      for (const property of childNodes(node, 'properties')) {
        if (
          property.type === 'Property' &&
          property.computed !== true &&
          ROLE_NAME.test(nodeName(childNode(property, 'key')) ?? '')
        ) {
          references.push(property);
        }
      }
    }
  }
  return references
    .filter(reference => !typePositions.some(position => within(reference, position)))
    .sort((left, right) => left.start - right.start);
}

const SNIPPET_NODES = new Set([
  'VariableDeclarator',
  'Property',
  'ReturnStatement',
  'ExpressionStatement',
  'CallExpression',
  'ConditionalExpression',
  'JSXAttribute',
  'ObjectPattern',
]);

/**
 * The reviewed text of a reference: its smallest enclosing declarator,
 * property, statement, call, conditional, JSX attribute, destructuring
 * pattern or `if`/`while` condition, without whitespace or trailing commas.
 * Reformatting keeps the text; changing the code around the reference does not.
 */
function referenceSnippet(file: ParsedFile, reference: AstNode): string {
  let anchor: { start: number; end: number; prefix: string } | null = null;
  for (const node of file.nodes) {
    const test =
      node.type === 'IfStatement' || node.type === 'WhileStatement'
        ? childNode(node, 'test')
        : null;
    const candidate = test ?? (SNIPPET_NODES.has(node.type) && node !== reference ? node : null);
    if (!candidate || !within(reference, candidate)) continue;
    if (!anchor || candidate.end - candidate.start < anchor.end - anchor.start) {
      anchor = {
        start: candidate.start,
        end: candidate.end,
        prefix: test ? (node.type === 'IfStatement' ? 'if' : 'while') : '',
      };
    }
  }
  const { start, end, prefix } = anchor ?? {
    start: reference.start,
    end: reference.end,
    prefix: '',
  };
  // Collapse whitespace, then drop it beside punctuation: only the space
  // between two words survives, which a formatter never removes.
  const text = file.source
    .slice(start, end)
    .replace(/\s+/g, ' ')
    .replace(/ ?([^\w$ ]) ?/g, '$1')
    .replace(/,(?=[)\]}])/g, '');
  return prefix ? `${prefix}(${text})` : text;
}

/** The innermost block statement around `node`, or the whole module. */
function innermostBlock(file: ParsedFile, node: AstNode): AstNode {
  let block = file.program;
  for (const candidate of file.nodes) {
    if (
      candidate.type === 'BlockStatement' &&
      within(node, candidate) &&
      within(candidate, block)
    ) {
      block = candidate;
    }
  }
  return block;
}

/** Whether `scope` awaits (or returns) a call of `guard`. */
function awaitsGuard(file: ParsedFile, scope: AstNode, guard: string): boolean {
  return file.nodes.some(
    node =>
      (node.type === 'AwaitExpression' || node.type === 'ReturnStatement') &&
      within(node, scope) &&
      calleeName(unwrap(childNode(node, 'argument'))) === guard
  );
}

/** Whether the reference is directly negated, as in `!ctx.user.is_admin` or `!user?.isAdmin`. */
function isNegated(file: ParsedFile, reference: AstNode): boolean {
  return file.nodes.some(
    node =>
      node.type === 'UnaryExpression' &&
      node.operator === '!' &&
      unwrap(childNode(node, 'argument')) === reference
  );
}

function functionNamed(file: ParsedFile, name: string): AstNode | null {
  return (
    file.nodes.find(
      node => node.type === 'FunctionDeclaration' && nodeName(childNode(node, 'id')) === name
    ) ?? null
  );
}

/**
 * Problems with the call sites of a predicate chain whose result grants staff
 * authority. Each call must sit in another predicate of the chain, have
 * `guard` awaited in its block, or share its block with an awaited or returned
 * call of a function in the same file whose body awaits `guard`.
 */
function predicateCallProblems(
  files: readonly string[],
  via: readonly string[],
  guard: string
): string[] {
  const problems: string[] = [];
  for (const name of via) {
    const callers = filesCalling(files, name);
    if (callers.length === 0) problems.push(`${name} has no caller`);
    for (const caller of callers) {
      const file = parseRepoFile(caller);
      for (const call of callsOf(file, name)) {
        const inChain = via.some(other => {
          const predicate = functionNamed(file, other);
          return predicate !== null && within(call, predicate);
        });
        if (inChain) continue;
        const block = innermostBlock(file, call);
        if (awaitsGuard(file, block, guard)) continue;
        const delegated = file.nodes.some(node => {
          if (node.type !== 'AwaitExpression' && node.type !== 'ReturnStatement') return false;
          const target = calleeName(unwrap(childNode(node, 'argument')));
          const body = childNode(target === null ? null : functionNamed(file, target), 'body');
          return within(node, block) && body !== null && awaitsGuard(file, body, guard);
        });
        if (!delegated) problems.push(`${caller}: ${name}(…) without an awaited ${guard}`);
      }
    }
  }
  return problems;
}

/** The repository file an import specifier names, or null for a package import. */
function importedFile(importer: string, specifier: string): string | null {
  let base: string | null = null;
  if (specifier.startsWith('@kilocode/web-shared/')) {
    base = path.join('packages/web-shared/src', specifier.slice('@kilocode/web-shared/'.length));
  } else if (specifier.startsWith('@/') && importer.startsWith('apps/web/')) {
    base = path.join('apps/web/src', specifier.slice(2));
  } else if (specifier.startsWith('.')) {
    base = path.join(path.dirname(importer), specifier);
  }
  if (base === null) return null;
  const candidates = [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')];
  return candidates.find(candidate => fs.existsSync(path.join(REPO_ROOT, candidate))) ?? null;
}

/** Whether `file` imports `name` under its own name from the module `from`. */
function importsFrom(file: ParsedFile, importer: string, name: string, from: string): boolean {
  return file.nodes.some(
    node =>
      node.type === 'ImportDeclaration' &&
      importedFile(importer, String(childNode(node, 'source')?.value ?? '')) === from &&
      childNodes(node, 'specifiers').some(
        specifier =>
          specifier.type === 'ImportSpecifier' &&
          nodeName(childNode(specifier, 'imported')) === name &&
          nodeName(childNode(specifier, 'local')) === name
      )
  );
}

/**
 * Whether the function `name` declared in `file` awaits `guard` itself or
 * through same-file functions it awaits or returns.
 */
function reachesGuard(
  file: ParsedFile,
  name: string,
  guard: string,
  seen = new Set<string>()
): boolean {
  const body = childNode(functionNamed(file, name), 'body');
  if (body === null || seen.has(name)) return false;
  seen.add(name);
  if (awaitsGuard(file, body, guard)) return true;
  return file.nodes.some(node => {
    if (
      (node.type !== 'AwaitExpression' && node.type !== 'ReturnStatement') ||
      !within(node, body)
    ) {
      return false;
    }
    const callee = calleeName(unwrap(childNode(node, 'argument')));
    return callee !== null && reachesGuard(file, callee, guard, seen);
  });
}

/** The smallest `if` condition holding the read, or its block outside one. */
function grantScope(file: ParsedFile, read: AstNode): AstNode {
  const conditions = file.nodes
    .map(node => (node.type === 'IfStatement' ? childNode(node, 'test') : null))
    .filter((test): test is AstNode => test !== null && within(read, test))
    .sort((left, right) => left.end - left.start - (right.end - right.start));
  return conditions[0] ?? innermostBlock(file, read);
}

/**
 * Problems with a grant that reaches its guard through an imported helper:
 * the read's own condition must await the helper, the file must import it
 * from the reviewed module, and the helper must reach the guard there. Another
 * await of the same helper elsewhere in the block does not count.
 */
function throughProblems(
  site: string,
  file: ParsedFile,
  read: AstNode,
  through: { call: string; file: string },
  guard: string
): string[] {
  const problems: string[] = [];
  if (!awaitsGuard(file, grantScope(file, read), through.call)) {
    problems.push(`grants without an awaited ${through.call} in its condition`);
  }
  if (!importsFrom(file, site, through.call, through.file)) {
    problems.push(`does not import ${through.call} from ${through.file}`);
  }
  if (!reachesGuard(parseRepoFile(through.file), through.call, guard)) {
    problems.push(`${through.call} never awaits ${guard}`);
  }
  return problems;
}

/**
 * Server-side source files: every non-test `.ts`/`.tsx` module of the web
 * app, the shared web package, the AI gateway and the Workers that consume
 * the role claim, except client modules. `apps/web/src/scripts` holds
 * operator scripts, which never serve a request.
 */
function serverSourceFiles(): string[] {
  return [
    'apps/web/src',
    'packages/web-shared/src',
    'apps/ai-gateway/src',
    'services/kilo-mcp/src',
    'packages/worker-utils/src',
  ]
    .flatMap(root => walkFiles(path.join(REPO_ROOT, root)))
    .map(file => path.relative(REPO_ROOT, file))
    .filter(
      file =>
        /\.tsx?$/.test(file) &&
        !/\.test\.tsx?$/.test(file) &&
        !file.startsWith('apps/web/src/scripts/') &&
        !file.startsWith('apps/web/src/tests/') &&
        !file.startsWith('packages/web-shared/src/tests/') &&
        !isClientSource(file, readRepoFile(file))
    )
    .sort();
}

const ROLE_TEXT = /is_admin|is(?:Kilo|Global|Platform|Staff)?Admin/;

function roleReadsIn(relativeFile: string): { file: ParsedFile; reads: AstNode[] } | null {
  if (!ROLE_TEXT.test(readRepoFile(relativeFile))) return null;
  const file = parseRepoFile(relativeFile);
  return { file, reads: roleReferences(file) };
}

/** Server files that call `identifier(…)`. */
function filesCalling(files: readonly string[], identifier: string): string[] {
  return files.filter(
    file =>
      readRepoFile(file).includes(identifier) && callsOf(parseRepoFile(file), identifier).length > 0
  );
}

function defaultExportBody(file: ParsedFile): AstNode | null {
  const exported = file.nodes.find(node => node.type === 'ExportDefaultDeclaration');
  const declaration = childNode(exported, 'declaration');
  return declaration?.type === 'FunctionDeclaration' ? childNode(declaration, 'body') : null;
}

/** `await params` and `await searchParams` read the route, not data. */
function isRouteParamsAwait(node: AstNode): boolean {
  const argument = unwrap(childNode(node, 'argument'));
  const name =
    argument?.type === 'MemberExpression' && nodeName(childNode(argument, 'object')) === 'props'
      ? nodeName(childNode(argument, 'property'))
      : nodeName(argument);
  return name === 'params' || name === 'searchParams';
}

/** Whether the call's first argument is an object literal with `key: true`. */
function hasTrueOption(call: AstNode | null, key: string): boolean {
  const options = unwrap(
    call?.type === 'CallExpression' ? (childNodes(call, 'arguments')[0] ?? null) : null
  );
  return (
    options?.type === 'ObjectExpression' &&
    childNodes(options, 'properties').some(
      property =>
        nodeName(childNode(property, 'key')) === key && childNode(property, 'value')?.value === true
    )
  );
}

/**
 * Null when the page's default export awaits the admin page guard before any
 * other await and returns early unless the guard admitted a user; otherwise
 * why not. Layout and page server code run concurrently, so a page that reads
 * data must guard itself even under the admin layout.
 */
function adminPageGuardProblem(file: ParsedFile): string | null {
  const body = defaultExportBody(file);
  if (!body) return 'no default export function';
  const first = file.nodes.find(
    node => node.type === 'AwaitExpression' && within(node, body) && !isRouteParamsAwait(node)
  );
  if (!first) return 'no admin page guard';
  const call = unwrap(childNode(first, 'argument'));
  const guard = calleeName(call);
  if (guard !== 'requireAdminPage' && guard !== 'getUserFromAuth') {
    return 'the first awaited call is not the admin page guard';
  }
  if (guard === 'getUserFromAuth' && !hasTrueOption(call, 'adminOnly')) {
    return 'getUserFromAuth without adminOnly: true';
  }
  const statements = childNodes(body, 'body');
  const index = statements.findIndex(statement => within(first, statement));
  const declarator = childNodes(statements[index] ?? body, 'declarations')[0];
  const bound =
    declarator && unwrap(childNode(declarator, 'init')) === first
      ? nodeName(childNode(declarator, 'id'))
      : null;
  if (!bound) return 'the guard result is not bound';
  const next = statements[index + 1];
  const test = next?.type === 'IfStatement' ? unwrap(childNode(next, 'test')) : null;
  const checked =
    test?.type === 'UnaryExpression' && test.operator === '!'
      ? unwrap(childNode(test, 'argument'))
      : null;
  if (
    checked?.type !== 'MemberExpression' ||
    nodeName(childNode(checked, 'object')) !== bound ||
    nodeName(childNode(checked, 'property')) !== 'user'
  ) {
    return 'the next statement does not refuse when the guard admitted no user';
  }
  const consequent = childNode(next, 'consequent');
  return consequent &&
    file.nodes.some(node => node.type === 'ReturnStatement' && within(node, consequent))
    ? null
    : 'the refusal branch does not return';
}

/** Modules whose import gives a server component database, request or provider access. */
const DATA_CAPABLE_PACKAGES =
  /^(?:@kilocode\/db(?:\/|$)|drizzle-orm(?:\/|$)|postgres$|pg$|next\/headers$|server-only$|@trpc\/server(?:\/|$)|stripe$|@workos-inc\/)/;

function resolveLocalModule(fromFile: string, specifier: string): string | null | 'external' {
  let base: string;
  if (specifier.startsWith('.')) base = path.resolve(path.dirname(fromFile), specifier);
  else if (specifier.startsWith('@/'))
    base = path.join(REPO_ROOT, 'apps/web/src', specifier.slice(2));
  else if (specifier.startsWith('@kilocode/web-shared/')) {
    base = path.join(
      REPO_ROOT,
      'packages/web-shared/src',
      specifier.slice('@kilocode/web-shared/'.length)
    );
  } else return 'external';
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Runtime module specifiers: imports and re-exports that are not type-only, and `import()`. */
function runtimeModuleSpecifiers(file: ParsedFile): string[] {
  return file.nodes.flatMap(node => {
    if (node.type === 'ImportDeclaration') {
      const named = childNodes(node, 'specifiers');
      const typeOnly =
        node.importKind === 'type' ||
        (named.length > 0 && named.every(item => item.importKind === 'type'));
      return typeOnly ? [] : [nodeName(childNode(node, 'source')) ?? ''];
    }
    const reexport =
      (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') &&
      node.exportKind !== 'type';
    const source =
      reexport || node.type === 'ImportExpression' ? nodeName(childNode(node, 'source')) : null;
    return source === null ? [] : [source];
  });
}

/**
 * Null when nothing a server module imports, followed through local modules
 * up to the first client module, can read the database, the request or a
 * provider; otherwise the first import that can. A client module is a
 * boundary: it reaches data only through guarded tRPC or `/admin/api` calls.
 */
function dataCapableImport(file: string, seen = new Set<string>()): string | null {
  const relativeFile = path.relative(REPO_ROOT, file);
  for (const specifier of runtimeModuleSpecifiers(parseRepoFile(relativeFile))) {
    const resolved = resolveLocalModule(file, specifier);
    if (resolved === 'external') {
      if (DATA_CAPABLE_PACKAGES.test(specifier)) return `${relativeFile} imports ${specifier}`;
      continue;
    }
    if (resolved === null) {
      if (/\.(?:css|svg|png|jpe?g|json)$/.test(specifier)) continue;
      return `${relativeFile} imports unresolved ${specifier}`;
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const resolvedRelative = path.relative(REPO_ROOT, resolved);
    if (isClientSource(resolvedRelative, readRepoFile(resolvedRelative))) continue;
    const nested = dataCapableImport(resolved, seen);
    if (nested) return nested;
  }
  return null;
}

const ROUTE_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

/** `caller.admin.users.list` for a member chain rooted at an identifier; null otherwise. */
function memberPath(node: AstNode | null): string | null {
  if (node?.type === 'Identifier') return nodeName(node);
  if (node?.type !== 'MemberExpression' || node.computed === true) return null;
  const object = memberPath(unwrap(childNode(node, 'object')));
  const property = nodeName(childNode(node, 'property'));
  return object === null || property === null ? null : `${object}.${property}`;
}

/**
 * Problems with the guard of each exported method of an `/admin/api` route:
 * the handler awaits `getUserFromAuth({ adminOnly: true })` and later returns
 * its `authFailedResponse`, or only forwards to admin-guarded tRPC procedures.
 * `adminTrpcPaths` lists the mounted procedures carrying the admin guard.
 */
function adminApiHandlerProblems(file: ParsedFile, adminTrpcPaths: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  for (const statement of childNodes(file.program, 'body')) {
    if (statement.type !== 'ExportNamedDeclaration') continue;
    const declaration = childNode(statement, 'declaration');
    const method =
      declaration?.type === 'FunctionDeclaration' ? nodeName(childNode(declaration, 'id')) : null;
    if (declaration?.type !== 'FunctionDeclaration') {
      const names =
        declaration?.type === 'VariableDeclaration'
          ? childNodes(declaration, 'declarations').map(item => nodeName(childNode(item, 'id')))
          : childNodes(statement, 'specifiers').map(item => nodeName(childNode(item, 'exported')));
      for (const name of names) {
        if (name !== null && ROUTE_METHODS.includes(name))
          problems.push(`${name}: not a function declaration`);
      }
      continue;
    }
    const body = childNode(declaration, 'body');
    if (method === null || !ROUTE_METHODS.includes(method) || body === null) continue;
    const guard = file.nodes.find(
      node =>
        node.type === 'AwaitExpression' &&
        within(node, body) &&
        calleeName(unwrap(childNode(node, 'argument'))) === 'getUserFromAuth'
    );
    if (guard) {
      const returnsRefusal = file.nodes.some(node => {
        const argument = unwrap(childNode(node, 'argument'));
        const name =
          argument?.type === 'MemberExpression'
            ? nodeName(childNode(argument, 'property'))
            : nodeName(argument);
        return (
          node.type === 'ReturnStatement' &&
          within(node, body) &&
          node.start > guard.end &&
          name === 'authFailedResponse'
        );
      });
      if (!hasTrueOption(unwrap(childNode(guard, 'argument')), 'adminOnly')) {
        problems.push(`${method}: getUserFromAuth without adminOnly: true`);
      } else if (!returnsRefusal) {
        problems.push(`${method}: authFailedResponse is not returned`);
      }
      continue;
    }
    const calls = file.nodes.filter(node => node.type === 'CallExpression' && within(node, body));
    const forwarded = calls.flatMap(call => {
      const callee = memberPath(unwrap(childNode(call, 'callee')));
      return callee?.startsWith('caller.') ? [callee.slice('caller.'.length)] : [];
    });
    if (!calls.some(call => calleeName(call) === 'handleTRPCRequest') || forwarded.length === 0) {
      problems.push(`${method}: no admin guard`);
      continue;
    }
    for (const procedurePath of forwarded) {
      if (!adminTrpcPaths.has(procedurePath))
        problems.push(`${method}: forwards to ${procedurePath}`);
    }
  }
  return problems;
}

function routePathFromAppFile(file: string): string {
  const relative = path.relative(APP_ROOT, file);
  const segments = relative.split(path.sep);
  segments.pop();
  const withoutGroups = segments.filter(segment => !/^\(.+\)$/.test(segment));
  return `/${withoutGroups.join('/')}`;
}

function exportedMethods(source: string): string[] {
  const methods = new Set<string>();
  const exportLines = source.split('\n').filter(line => line.trimStart().startsWith('export '));
  for (const line of exportLines) {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      if (new RegExp(`\\b${method}\\b`).test(line)) methods.add(method);
    }
  }
  return [...methods];
}

function accessKindsFor(methods: string[]): ('read' | 'write')[] {
  return methods.length === 0
    ? ['read', 'write']
    : [
        ...new Set(
          methods.map(method => (method === 'GET' || method === 'HEAD' ? 'read' : 'write'))
        ),
      ];
}

function discoverRESTRoutes(): DiscoveredRoute[] {
  return walkFiles(APP_ROOT)
    .filter(file => path.basename(file) === 'route.ts')
    .map(file => {
      const source = fs.readFileSync(file, 'utf8');
      return {
        file,
        route: routePathFromAppFile(file),
        methods: exportedMethods(source),
        explicitAdminGuard: source.includes('adminOnly: true'),
        organizationContext:
          source.includes('getAuthorizedOrgContext(') ||
          source.includes('getAuthorizedOrgContextOrSupport(') ||
          source.includes('ensureOrganizationAccess(') ||
          source.includes('ensureMemberOrganizationAccess(') ||
          source.includes('ensureOrganizationAccessAndFetchOrg('),
        staffAdmission:
          source.includes('getCodeIndexOrganizationId(') ||
          source.includes('requireStaffAuthorityForRequest('),
      };
    });
}

function isPrivilegedRoute(discovered: DiscoveredRoute): boolean {
  return (
    discovered.route.startsWith('/admin/') ||
    discovered.explicitAdminGuard ||
    discovered.organizationContext ||
    discovered.staffAdmission
  );
}

const ROUTE_SEGMENT_FILE = /^(?:page|layout|template|default|not-found|loading)\.tsx$/;

/** Every server-rendered page or layout under `/admin` or `/organizations`, guarded or not. */
function discoverServerComponents(): { file: string; route: string }[] {
  return walkFiles(APP_ROOT)
    .filter(file => ROUTE_SEGMENT_FILE.test(path.basename(file)))
    .map(file => ({ file, route: routePathFromAppFile(file) }))
    .filter(
      ({ file, route }) =>
        (route === '/admin' ||
          route.startsWith('/admin/') ||
          route === '/organizations' ||
          route.startsWith('/organizations/')) &&
        !isClientSource(path.relative(REPO_ROOT, file), fs.readFileSync(file, 'utf8'))
    );
}

const procedures = rootRouter._def.procedures as Record<string, ProcedureDef>;
const discoveredProcedures = Object.entries(procedures).map(([procedurePath, def]) => ({
  path: procedurePath,
  type: def?._def?.type ?? 'query',
  tiers: privilegedGuardTiers(def?._def?.middlewares ?? []),
  def,
}));
const adminProcedures = discoveredProcedures.filter(procedure =>
  procedure.path.startsWith('admin.')
);
const privilegedProcedures = discoveredProcedures.filter(
  procedure => procedure.tiers.length > 0 || procedure.path.startsWith('admin.')
);

describe('privileged inventory covers discovered tRPC procedures', () => {
  test('every mounted admin area has a checked-in policy', () => {
    const areas = new Set(
      adminProcedures
        .filter(procedure => procedure.path.split('.').length > 2)
        .map(procedure => procedure.path.split('.')[1] as string)
    );
    const missing = [...areas].filter(area => !(area in ADMIN_AREA_POLICIES));
    expect(missing).toEqual([]);
  });

  test('every admin procedure carries the admin guard and a read/write entry', () => {
    const missing: string[] = [];
    const unguarded: string[] = [];

    for (const procedure of adminProcedures) {
      const access = procedure.type === 'mutation' ? 'write' : 'read';
      const entry = findPrivilegedInventoryEntry({
        surface: 'trpc',
        route: procedure.path,
        access,
      });
      if (!entry) missing.push(procedure.path);
      if (!procedure.tiers.includes('admin')) unguarded.push(procedure.path);
    }

    expect(missing).toEqual([]);
    expect(unguarded).toEqual([]);
  });

  test('every guarded procedure outside admin.* has an explicit entry', () => {
    const problems: string[] = [];

    for (const procedure of privilegedProcedures) {
      const access = procedure.type === 'mutation' ? 'write' : 'read';
      const entry = findPrivilegedInventoryEntry({
        surface: 'trpc',
        route: procedure.path,
        access,
      });
      if (!entry) {
        problems.push(`${procedure.path} (no entry)`);
        continue;
      }
      if (!procedure.path.startsWith('admin.') && BROAD_WILDCARDS.has(entry.route)) {
        problems.push(`${procedure.path} (swallowed by ${entry.route})`);
      }
    }

    expect(problems).toEqual([]);
  });

  test('specialized guard middlewares are recognized on real procedures', () => {
    const tiers = new Set(privilegedProcedures.flatMap(procedure => procedure.tiers));

    expect(tiers).toEqual(
      new Set([
        'admin',
        'superadmin',
        'credit_manager',
        'session_viewer',
        'api_request_log_exporter',
      ])
    );
  });

  test('the guarded procedure list is reviewed as a snapshot', () => {
    const covered = privilegedProcedures
      .map(procedure => {
        const access = procedure.type === 'mutation' ? 'write' : 'read';
        const entry = findPrivilegedInventoryEntry({
          surface: 'trpc',
          route: procedure.path,
          access,
        });
        return `${procedure.path} ${procedure.type} [${[...procedure.tiers].sort().join(',')}] -> ${entry?.id ?? 'NONE'}`;
      })
      .sort();

    expect(covered).toMatchSnapshot('guarded-trpc-procedures');
  });

  test('every procedure the admin edge rule matches carries the admin guard', () => {
    const unguarded = discoveredProcedures
      .filter(procedure => isAdminEdgePath(`/api/trpc/${procedure.path}`))
      .filter(procedure => !procedure.tiers.includes('admin'))
      .map(procedure => procedure.path);

    expect(unguarded).toEqual([]);
  });

  test('every admin procedure is refused at the edge off-network, except reviewed ones', () => {
    // An admin procedure the edge does not match still meets the in-app
    // network check; listing one here only gives up the edge layer for it.
    const edgeExclusions: Record<string, string> = {
      'stepUp.getStatus':
        'StepUpProvider mounts app-wide and, for a signed-in admin with step-up enabled, polls it ' +
        "on every page beside the page's own procedures, so an edge match would refuse whole " +
        'batches on normal pages',
    };
    const adminPaths = new Set(
      discoveredProcedures
        .filter(procedure => procedure.tiers.includes('admin'))
        .map(procedure => procedure.path)
    );

    const uncovered = [...adminPaths].filter(
      path => !(path in edgeExclusions) && !isAdminEdgePath(`/api/trpc/${path}`)
    );
    const staleExclusions = Object.keys(edgeExclusions).filter(
      path => !adminPaths.has(path) || isAdminEdgePath(`/api/trpc/${path}`)
    );

    expect(uncovered).toEqual([]);
    expect(staleExclusions).toEqual([]);
  });

  test('the app-shell router mounts only reviewed admin procedures', () => {
    // `/app-shell/api/trpc` is outside the admin edge rule, which must not
    // match it: the shell batches org owners' calls, so an edge match would
    // refuse whole batches for non-admins. Admin procedures mounted there rely
    // on the in-app network check alone.
    const appShellAdminExceptions: Record<string, string> = {
      'organizations.sso.generateAdminPortalLink':
        'the app-shell mount is outside the edge rule; adminGuardFn still refuses ' +
        'off-network admins in the app',
    };
    const appShellProcedures = appShellProceduresRouter._def.procedures as Record<
      string,
      ProcedureDef
    >;
    const appShellAdminPaths = Object.entries(appShellProcedures)
      .filter(([, def]) => privilegedGuardTiers(def?._def?.middlewares ?? []).includes('admin'))
      .map(([procedurePath]) => procedurePath);

    expect(appShellAdminPaths.sort()).toEqual(Object.keys(appShellAdminExceptions).sort());
    // No app-shell path, alone or batched with another, may meet the edge rule.
    const appShellPaths = Object.keys(appShellProcedures);
    expect(
      [...appShellPaths, appShellPaths.join(',')].filter(procedurePath =>
        isAdminEdgePath(`/app-shell/api/trpc/${procedurePath}`)
      )
    ).toEqual([]);
  });

  test('every admin edge namespace and exact name still names mounted procedures', () => {
    const unusedNamespaces = ADMIN_ONLY_TRPC_NAMESPACES.filter(
      namespace => !discoveredProcedures.some(procedure => procedure.path.startsWith(namespace))
    );
    const unmountedProcedures = ADMIN_ONLY_TRPC_PROCEDURES.filter(name => !(name in procedures));

    expect(unusedNamespaces).toEqual([]);
    expect(unmountedProcedures).toEqual([]);
  });

  test('known non-admin elevation procedures are classified', () => {
    const routes = ['codeIndexing.search', 'organizations.securityAgent.getAuditReport'];

    for (const route of routes) {
      expect(
        findPrivilegedInventoryEntry({ surface: 'trpc', route, access: 'read' })
      ).toBeDefined();
    }
  });

  test('each guard tier is one middleware, and specialized tiers run after the admin guard', () => {
    const middlewaresByTier = new Map<string, Set<unknown>>();
    const problems: string[] = [];

    for (const procedure of discoveredProcedures) {
      const middlewares = procedure.def?._def?.middlewares ?? [];
      const tiers = middlewares.map(middleware => privilegedGuardTiers([middleware])[0]);
      const adminIndex = tiers.indexOf('admin');
      tiers.forEach((tier, index) => {
        if (tier === undefined) return;
        const seen = middlewaresByTier.get(tier) ?? new Set<unknown>();
        seen.add(middlewares[index]);
        middlewaresByTier.set(tier, seen);
        if (tier !== 'admin' && (adminIndex === -1 || adminIndex > index)) {
          problems.push(`${procedure.path}: ${tier} without the admin guard before it`);
        }
      });
    }

    // A second middleware tagged with a tier would be a parallel guard.
    expect(
      [...middlewaresByTier].filter(([, seen]) => seen.size !== 1).map(([tier]) => tier)
    ).toEqual([]);
    expect(problems).toEqual([]);
  });

  test('admin-tier operations that reach the organization staff branch bind their proof to it', () => {
    // The shared organization admission reuses the admin guard's admission
    // only when its proof names the same organization; an unbound proof never
    // covers it. A resolver that calls one of these helpers therefore needs
    // the validated `organizationId` declared, or its own exact resolver mode.
    const helpers =
      /\b(?:ensureOrganizationAccess|ensureOrganizationAccessAndFetchOrg|ensureMemberOrganizationAccess|resolveOrganizationAccess|requireOrganizationStaffAuthority|getAuthorizedOrgContext)\b/;
    const reaching = discoveredProcedures.filter(
      procedure =>
        procedure.tiers.includes('admin') &&
        isOperationStepUpClass(
          actionClassForAdminProcedure(procedure.path, procedure.type).actionClass
        ) &&
        helpers.test(String(procedure.def?._def?.resolver ?? ''))
    );
    const problems = reaching
      .filter(procedure => !resolvesOwnStepUp(procedure.path))
      .flatMap(procedure => {
        const field = targetIdFieldForAdminProcedure(procedure.path);
        const { targetKind } = actionClassForAdminProcedure(procedure.path, procedure.type);
        return field === 'organizationId' && targetKind === 'organization'
          ? []
          : [`${procedure.path}: field ${field ?? 'none'}, target ${targetKind}`];
      });

    // The resolver source is visible, so the scan is not vacuous.
    expect(reaching.map(procedure => procedure.path)).toContain(
      'organizations.sso.generateAdminPortalLink'
    );
    expect(problems).toEqual([]);
  });

  test('every declared target field is a validated input the resolver receives unchanged', () => {
    const sample = '00000000-0000-4000-8000-000000000000';
    type FieldSchema = { safeParse: (value: unknown) => { success: boolean; data?: unknown } };
    const problems: string[] = [];

    for (const [route, field] of Object.entries(TARGET_ID_FIELD_BY_ADMIN_PROCEDURE)) {
      if (field === null) continue;
      const schemas = (procedures[route]?._def?.inputs ?? []).flatMap(input => {
        const schema = (input as { shape?: Record<string, FieldSchema | undefined> }).shape?.[
          field
        ];
        return schema ? [schema] : [];
      });
      if (schemas.length === 0) {
        problems.push(`${route}: no validated ${field} input`);
        continue;
      }
      for (const schema of schemas) {
        const parsed = schema.safeParse(sample);
        if (!parsed.success || parsed.data !== sample)
          problems.push(`${route}: ${field} transforms its value`);
      }
    }

    expect(problems).toEqual([]);
  });
});

describe('privileged inventory covers discovered route handlers', () => {
  test('every /admin/api route is classified for each exported method', () => {
    const problems: string[] = [];

    for (const discovered of discoverRESTRoutes()) {
      if (!discovered.route.startsWith('/admin/api/')) continue;
      for (const access of accessKindsFor(discovered.methods)) {
        if (
          !findPrivilegedInventoryEntry({
            surface: 'rest',
            route: discovered.route,
            access,
          })
        ) {
          problems.push(`${discovered.route} ${access}`);
        }
      }
    }

    expect(problems).toEqual([]);
  });

  test('every route handler with an explicit admin or org-context guard is classified', () => {
    const problems: string[] = [];

    for (const discovered of discoverRESTRoutes()) {
      if (!isPrivilegedRoute(discovered)) continue;
      for (const access of accessKindsFor(discovered.methods)) {
        if (
          !findPrivilegedInventoryEntry({
            surface: 'rest',
            route: discovered.route,
            access,
          })
        ) {
          problems.push(
            `${discovered.route} ${access} (${path.relative(REPO_ROOT, discovered.file)})`
          );
        }
      }
    }

    expect(problems).toEqual([]);
  });

  test('the privileged route-to-entry mapping is reviewed as a snapshot', () => {
    const mapping = discoverRESTRoutes()
      .filter(isPrivilegedRoute)
      .flatMap(discovered =>
        accessKindsFor(discovered.methods).map(access => {
          const entry = findPrivilegedInventoryEntry({
            surface: 'rest',
            route: discovered.route,
            access,
          });
          return `${discovered.route} ${access} -> ${entry?.id ?? 'NONE'}`;
        })
      )
      .sort();

    expect(mapping).toMatchSnapshot('privileged-rest-routes');
  });

  test('every /admin/api handler guards each exported method', () => {
    const adminTrpcPaths = new Set(
      discoveredProcedures
        .filter(procedure => procedure.tiers.includes('admin'))
        .map(procedure => procedure.path)
    );
    const problems = discoverRESTRoutes()
      .filter(discovered => discovered.route.startsWith('/admin/api/'))
      .flatMap(discovered =>
        adminApiHandlerProblems(
          parseRepoFile(path.relative(REPO_ROOT, discovered.file)),
          adminTrpcPaths
        ).map(problem => `${path.relative(REPO_ROOT, discovered.file)} ${problem}`)
      );

    expect(problems).toEqual([]);
  });

  test('every server-rendered admin page guards itself or renders a data-free shell', () => {
    // Next renders a layout and its page concurrently, so the admin layout's
    // guard does not stop a page's own server code. A page that reads data
    // awaits `requireAdminPage` first; any other page may only render client
    // components, which reach data through guarded tRPC or `/admin/api` calls.
    const problems: string[] = [];

    for (const component of discoverServerComponents()) {
      if (component.route !== '/admin' && !component.route.startsWith('/admin/')) continue;
      const relative = path.relative(REPO_ROOT, component.file);
      const file = parseRepoFile(relative);
      if (file.nodes.some(node => node.directive === 'use server'))
        problems.push(`${relative}: server action`);
      if (
        file.nodes.some(node =>
          ['requireAdminPage', 'getUserFromAuth'].includes(calleeName(node) ?? '')
        )
      ) {
        const problem = adminPageGuardProblem(file);
        if (problem) problems.push(`${relative}: ${problem}`);
        continue;
      }
      const body = defaultExportBody(file);
      const dataAwait = body
        ? file.nodes.some(
            node =>
              node.type === 'AwaitExpression' && within(node, body) && !isRouteParamsAwait(node)
          )
        : true;
      if (dataAwait) problems.push(`${relative}: awaits data without the admin page guard`);
      const capable = dataCapableImport(component.file);
      if (capable) problems.push(`${relative}: shell reaches data (${capable})`);
    }

    expect(problems).toEqual([]);
  });

  test('code-index routes class the personal staff branch; an organization request is classed at its admission', () => {
    expect(
      actionClassForRoute({ surface: 'rest', route: '/api/code-indexing/enabled', method: 'GET' })
    ).toEqual({
      actionClass: 'platform_read',
      inventoryId: 'rest.codeIndexing.enabled',
      targetKind: 'user',
    });
    expect(
      actionClassForRoute({
        surface: 'rest',
        route: '/api/code-indexing/upsert-by-file',
        method: 'PUT',
      })
    ).toEqual({
      actionClass: 'platform_write',
      inventoryId: 'rest.codeIndexing.upsertByFile',
      targetKind: 'user',
    });
    // Each entry serves only its route's method; retired siblings match none.
    for (const [route, access] of [
      ['/api/code-indexing/enabled', 'write'],
      ['/api/code-indexing/upsert-by-file', 'read'],
      ['/api/code-indexing/search', 'write'],
      ['/api/code-indexing/manifest', 'read'],
    ] as const) {
      expect(findPrivilegedInventoryEntry({ surface: 'rest', route, access })).toBeUndefined();
    }
    // Mapping them adds no support allowlist entry and no edge rule.
    expect(
      [...SUPPORT_READ_ALLOWLIST, ...SUPPORT_WRITE_ALLOWLIST].filter(entry =>
        entry.key.startsWith('/api/code-indexing')
      )
    ).toEqual([]);
    expect(
      ['/api/code-indexing/enabled', '/api/code-indexing/upsert-by-file'].filter(route =>
        isAdminEdgePath(route)
      )
    ).toEqual([]);
  });

  test('wildcards stop at path-segment boundaries', () => {
    expect(
      findPrivilegedInventoryEntry({ surface: 'rest', route: '/organizationsX', access: 'read' })
    ).toBeUndefined();
    expect(
      findPrivilegedInventoryEntry({
        surface: 'rest',
        route: '/api/organizations/00000000-0000-0000-0000-000000000000/user-tokens',
        access: 'write',
      })?.id
    ).toBe('rest.organizationTokens');
  });

  test('admin and organization server components are classified', () => {
    const missing: string[] = [];

    for (const component of discoverServerComponents()) {
      if (
        !findPrivilegedInventoryEntry({
          surface: 'server-component',
          route: component.route,
          access: 'read',
        })
      ) {
        missing.push(component.route);
      }
    }

    expect(missing).toEqual([]);
  });
});

function multisetDifference(left: readonly string[], right: readonly string[]): string[] {
  const remaining = [...right];
  return left.filter(item => {
    const index = remaining.indexOf(item);
    if (index === -1) return true;
    remaining.splice(index, 1);
    return false;
  });
}

describe('privileged inventory covers every staff role reference', () => {
  const files = serverSourceFiles();

  test('the scanner sees each reference form and skips text, types and object keys', () => {
    const source = [
      'const url = "https://github.com/example/repo"; const a = user.is_admin;',
      'const quoted = "ctx.user.is_admin";',
      '// user.is_admin in a line comment',
      '/* tenant.is_admin in a block comment */',
      'const record = { is_admin: false, isAdmin: true };',
      'type Render = { render: ({ isGlobalAdmin }: Props) => void };',
      'type T = Pick<User, "is_admin">;',
      'const b = token?.isAdmin;',
      "const c = row['is_admin'];",
      'const { is_admin } = user;',
      'const { is_admin: staff, id } = user;',
      'const render = ({ organization, isGlobalAdmin }) => organization;',
      'const label = `${user.isKiloAdmin ? "staff" : "member"}`;',
      'const text = `user.is_admin is ${"masked"}`;',
      'function f({ isAdmin }) { return isAdmin; }',
      'call({ isAdmin });',
      'if (!ctx.user.is_admin ||',
      '    blocked) {',
      '  refuse();',
      '}',
    ].join('\n');
    const file = parseSource('case.ts', source);

    expect(roleReferences(file).map(reference => referenceSnippet(file, reference))).toEqual([
      'a=user.is_admin',
      'b=token?.isAdmin',
      "c=row['is_admin']",
      '{is_admin}',
      '{is_admin:staff,id}',
      '{organization,isGlobalAdmin}',
      'user.isKiloAdmin?"staff":"member"',
      '{isAdmin}',
      'if(!ctx.user.is_admin||blocked)',
    ]);
  });

  test('formatting does not change a reviewed snippet, code changes do', () => {
    const snippet = (source: string) => {
      const file = parseSource('case.ts', source);
      return roleReferences(file).map(reference => referenceSnippet(file, reference));
    };
    const compact = 'const tier = { kind: user.is_admin ? adminTierFor(user) : null };';

    expect(
      snippet('const tier = {\n  kind: user.is_admin\n    ? adminTierFor(user)\n    : null,\n};')
    ).toEqual(snippet(compact));
    expect(
      snippet('const tier = { kind: user.is_admin ? adminTierFor(user) : everything };')
    ).not.toEqual(snippet(compact));
  });

  test('every staff role reference is classified by its reviewed snippet', () => {
    const sitesByFile = new Map<string, StaffRoleRead[]>();
    const problems: string[] = [];
    for (const site of internalElevationSites) {
      if (sitesByFile.has(site.file)) problems.push(`${site.file}: listed twice`);
      sitesByFile.set(site.file, [...site.reads]);
    }

    const referencing = new Set<string>();
    for (const file of files) {
      const scanned = roleReadsIn(file);
      const actual = scanned?.reads.map(read => referenceSnippet(scanned.file, read)) ?? [];
      if (actual.length === 0) continue;
      referencing.add(file);
      const reviewed = (sitesByFile.get(file) ?? []).map(read => read.snippet);
      for (const snippet of multisetDifference(actual, reviewed)) {
        problems.push(`${file}: unclassified ${JSON.stringify(snippet)}`);
      }
      for (const snippet of multisetDifference(reviewed, actual)) {
        problems.push(`${file}: stale ${JSON.stringify(snippet)}`);
      }
    }
    for (const file of sitesByFile.keys()) {
      if (!referencing.has(file)) problems.push(`${file}: listed, but no reference remains`);
    }

    expect(problems).toEqual([]);
  });

  test('every grant awaits its staff guard and every prefilter only refuses', () => {
    const problems: string[] = [];

    for (const site of internalElevationSites) {
      if (!fs.existsSync(path.join(REPO_ROOT, site.file))) continue;
      const scanned = roleReadsIn(site.file);
      if (!scanned) continue;
      const readsBySnippet = new Map<string, AstNode[]>();
      for (const read of scanned.reads) {
        const snippet = referenceSnippet(scanned.file, read);
        readsBySnippet.set(snippet, [...(readsBySnippet.get(snippet) ?? []), read]);
      }
      for (const reviewed of site.reads) {
        const read = readsBySnippet.get(reviewed.snippet)?.shift();
        if (!read) continue;
        const where = `${site.file}: ${JSON.stringify(reviewed.snippet)}`;
        if (reviewed.use === 'prefilter' && !isNegated(scanned.file, read)) {
          problems.push(`${where} is not negated`);
        }
        if (reviewed.use !== 'grant') continue;
        if (reviewed.via === undefined && reviewed.through !== undefined) {
          problems.push(
            ...throughProblems(site.file, scanned.file, read, reviewed.through, reviewed.guard).map(
              problem => `${where} ${problem}`
            )
          );
          continue;
        }
        if (reviewed.via === undefined) {
          if (!awaitsGuard(scanned.file, innermostBlock(scanned.file, read), reviewed.guard)) {
            problems.push(`${where} grants without an awaited ${reviewed.guard}`);
          }
          continue;
        }
        problems.push(...predicateCallProblems(files, reviewed.via, reviewed.guard));
      }
    }

    expect(problems).toEqual([]);
  });

  test('a grant fails once its guard is removed, unawaited or outside its block', () => {
    const guarded = [
      'async function list(ctx) {',
      '  if (ctx.user.is_admin && !isSupportAccessEnabled()) {',
      "    await requireStaffAuthority(ctx, { actionClass: 'support_read' });",
      '    return everything();',
      '  }',
      '  return own();',
      '}',
    ].join('\n');
    const removed = guarded.replace(/^.*requireStaffAuthority.*\n/m, '');
    const verdict = (source: string) => {
      const file = parseSource('case.ts', source);
      const [reference] = roleReferences(file);
      return reference
        ? awaitsGuard(file, innermostBlock(file, reference), 'requireStaffAuthority')
        : false;
    };

    expect(verdict(guarded)).toBe(true);
    expect(verdict(removed)).toBe(false);
    expect(
      verdict(guarded.replace('await requireStaffAuthority', 'void requireStaffAuthority'))
    ).toBe(false);
    expect(
      verdict(guarded.replace('await requireStaffAuthority', '// await requireStaffAuthority'))
    ).toBe(false);
    expect(
      verdict(`${removed}\nasync function other(ctx) { await requireStaffAuthority(ctx, {}); }`)
    ).toBe(false);
  });

  test('a grant through a helper needs the helper awaited in its own condition and reaching the guard', () => {
    const guard = 'requireOrganizationStaffAuthority';
    const helper = [
      'export async function check(ctx) { return (await inner(ctx)).role; }',
      `async function inner(ctx) { await ${guard}(ctx); return { role: 'owner' }; }`,
    ].join('\n');
    expect(reachesGuard(parseSource('helper.ts', helper), 'check', guard)).toBe(true);
    expect(
      reachesGuard(
        parseSource('helper.ts', helper.replace(`await ${guard}(ctx);`, '')),
        'check',
        guard
      )
    ).toBe(false);

    const site = [
      'async function owner(ctx) {',
      "  await check(ctx, ['admin']);",
      "  if (ctx.user.is_admin && (await check(ctx, ['owner'])) === 'owner') return;",
      '}',
    ].join('\n');
    const verdict = (source: string) => {
      const file = parseSource('case.ts', source);
      const [reference] = roleReferences(file);
      return reference ? awaitsGuard(file, grantScope(file, reference), 'check') : false;
    };
    expect(verdict(site)).toBe(true);
    // The block's other await of the helper does not cover the condition.
    expect(verdict(site.replace("(await check(ctx, ['owner'])) === 'owner'", 'true'))).toBe(false);
  });

  test('a prefilter fails once its negation is dropped', () => {
    const negated = (source: string) => {
      const file = parseSource('case.ts', source);
      const [reference] = roleReferences(file);
      return reference ? isNegated(file, reference) : false;
    };

    expect(negated('if (!ctx.user.is_admin) throw refusal;')).toBe(true);
    expect(negated('if (!org || !user?.is_admin || enabled) throw refusal;')).toBe(true);
    expect(negated('if (ctx.user.is_admin) throw refusal;')).toBe(false);
  });
});

describe('structural guard checks reject their known bypasses', () => {
  const page = (source: string) => adminPageGuardProblem(parseSource('page.tsx', source));
  const route = (source: string, adminPaths: ReadonlySet<string>) =>
    adminApiHandlerProblems(parseSource('route.ts', source), adminPaths);

  test('an admin page must await its guard first and return unless it admitted a user', () => {
    const guarded = [
      'export default async function Page({ params }) {',
      '  const access = await requireAdminPage();',
      '  if (!access.user) {',
      '    return <AdminStepUpGate requirement={access.stepUp} />;',
      '  }',
      '  const { id } = await params;',
      '  return <Detail row={await load(id)} />;',
      '}',
    ].join('\n');

    expect(page(guarded)).toBeNull();
    expect(
      page(guarded.replace('const access =', 'const rows = await load();\n  const access ='))
    ).toBe('the first awaited call is not the admin page guard');
    expect(page(guarded.replace(/ {2}if \(!access\.user\) \{\n.*\n {2}\}\n/, ''))).toBe(
      'the next statement does not refuse when the guard admitted no user'
    );
    expect(page(guarded.replace('return <AdminStepUpGate', 'void <AdminStepUpGate'))).toBe(
      'the refusal branch does not return'
    );
    expect(
      page(
        guarded.replace(
          'await requireAdminPage()',
          "await getUserFromAuth({ stepUpSurface: 'server-component' })"
        )
      )
    ).toBe('getUserFromAuth without adminOnly: true');
  });

  test('an /admin/api handler must keep adminOnly and return the refusal', () => {
    const adminPaths = new Set(['admin.enrichmentData.upsert']);
    const guarded = [
      'export async function GET() {',
      '  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });',
      '  if (authFailedResponse) return authFailedResponse;',
      '  return Response.json(await rows());',
      '}',
    ].join('\n');
    const forwarding = [
      'export async function PUT(request) {',
      '  return handleTRPCRequest(request, async caller => caller.admin.enrichmentData.upsert(body));',
      '}',
    ].join('\n');

    expect(route(guarded, adminPaths)).toEqual([]);
    expect(route(forwarding, adminPaths)).toEqual([]);
    expect(route(guarded.replace('adminOnly: true', 'adminOnly: false'), adminPaths)).toEqual([
      'GET: getUserFromAuth without adminOnly: true',
    ]);
    expect(
      route(
        guarded.replace('return authFailedResponse;', 'console.warn(authFailedResponse);'),
        adminPaths
      )
    ).toEqual(['GET: authFailedResponse is not returned']);
    expect(
      route(
        forwarding.replace('caller.admin.enrichmentData.upsert', 'caller.user.getMe'),
        adminPaths
      )
    ).toEqual(['PUT: forwards to user.getMe']);
    expect(
      route('export const GET = withAnything(async () => Response.json(await rows()));', adminPaths)
    ).toEqual(['GET: not a function declaration']);
  });
});

describe('staff admission has exact entrypoints', () => {
  const files = serverSourceFiles();

  test('only the transport cores call the shared admission', () => {
    expect(filesCalling(files, 'admitStaff')).toEqual([
      'packages/web-shared/src/lib/trpc/init.ts',
      'packages/web-shared/src/lib/user/server.ts',
    ]);
  });

  test('only the step-up route uses the no-proof session bootstrap', () => {
    expect(filesCalling(files, 'getUserFromSessionForStepUp')).toEqual([
      'apps/web/src/app/api/auth/step-up/route.ts',
    ]);
  });

  test('only the guard modules tag guard tiers', () => {
    expect(filesCalling(files, 'markPrivilegedGuard')).toEqual([
      'apps/web/src/lib/trpc/admin-procedures.ts',
      'packages/web-shared/src/lib/trpc/init.ts',
    ]);
  });

  test('the no-proof modes are the status read, the step-up bootstrap and the listed resolvers', () => {
    const init = readRepoFile('packages/web-shared/src/lib/trpc/init.ts');
    const server = readRepoFile('packages/web-shared/src/lib/user/server.ts');
    const proofModes = (source: string) => source.match(/kind:\s*'(?:bootstrap|resolver)'/g) ?? [];

    expect(proofModes(init)).toEqual(["kind: 'bootstrap'", "kind: 'resolver'"]);
    expect(init).toContain("const STEP_UP_STATUS_PROCEDURE = 'stepUp.getStatus';");
    expect(init).toContain(
      "if (params.path === STEP_UP_STATUS_PROCEDURE) return { kind: 'bootstrap' };"
    );
    expect(init).toContain("if (resolvesOwnStepUp(params.path)) return { kind: 'resolver' };");
    expect(proofModes(server)).toEqual(["kind: 'bootstrap'"]);
    expect(
      server
        .slice(0, server.indexOf("kind: 'bootstrap'"))
        .match(/export async function \w+/g)
        ?.at(-1)
    ).toBe('export async function getUserFromSessionForStepUp');
  });
});

describe('admin procedures that resolve their own step-up', () => {
  const ROUTERS_ROOT = path.join(REPO_ROOT, 'apps/web/src/routers');

  function filesCallingSupportStepUp(): string[] {
    return walkFiles(ROUTERS_ROOT)
      .filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .filter(file => fs.readFileSync(file, 'utf8').includes('supportStepUpPort.requireFresh('));
  }

  test('every listed route is a mounted mutation with an inventory entry', () => {
    const problems: string[] = [];

    for (const route of ADMIN_STEP_UP_SELF_GUARDED_ROUTES) {
      const procedure = procedures[route];
      if (!procedure) {
        problems.push(`${route} (no procedure)`);
        continue;
      }
      if ((procedure._def?.type ?? 'query') !== 'mutation') {
        problems.push(`${route} (not a mutation)`);
      }
      const entry = findPrivilegedInventoryEntry({ surface: 'trpc', route, access: 'write' });
      if (!entry) problems.push(`${route} (no inventory entry)`);
    }

    expect(problems).toEqual([]);
  });

  test('the exemption list covers the resolvers that guard themselves', () => {
    // A resolver that calls the support step-up port is skipped by the admin
    // middleware, so it must be listed. The count of those call sites and the
    // length of the list must agree, so a new self-guard forces a list update.
    const files = filesCallingSupportStepUp();
    expect(files.length).toBeGreaterThan(0);

    const callSites = files
      .map(file => fs.readFileSync(file, 'utf8'))
      .join('\n')
      .match(/supportStepUpPort\.requireFresh\(/g);

    expect(callSites).toHaveLength(ADMIN_STEP_UP_SELF_GUARDED_ROUTES.length);
  });

  test('a listed route is not skipped when the switch is off', () => {
    // The exemption only removes the middleware read. The resolver's own port
    // keeps the write classes fail-closed, which its own suite proves.
    expect(resolvesOwnStepUp(ADMIN_STEP_UP_SELF_GUARDED_ROUTES[0]!)).toBe(true);
    expect(resolvesOwnStepUp('admin.users.update')).toBe(false);
  });
});

describe('support access allowlists agree with the privileged inventory', () => {
  const allowlist = [...SUPPORT_READ_ALLOWLIST, ...SUPPORT_WRITE_ALLOWLIST];

  test('every allowlist entry resolves to the matching inventory action class', () => {
    const problems: string[] = [];

    for (const entry of allowlist) {
      const access = entry.actionClass === 'support_write' ? 'write' : 'read';
      const inventory = findPrivilegedInventoryEntry({
        surface: entry.surface,
        route: entry.key,
        access,
      });
      if (!inventory) {
        problems.push(`${entry.surface} ${entry.key} (no inventory entry)`);
        continue;
      }
      const actionClass = actionClassForEntry(inventory, access);
      if (actionClass !== entry.actionClass) {
        problems.push(`${entry.key}: allowlist ${entry.actionClass}, inventory ${actionClass}`);
      }
    }

    expect(problems).toEqual([]);
  });

  test('every tRPC allowlist key is a real procedure of the matching type', () => {
    const problems: string[] = [];

    for (const entry of allowlist) {
      if (entry.surface !== 'trpc') continue;
      const procedure = procedures[entry.key];
      if (!procedure) {
        problems.push(`${entry.key} (no procedure)`);
        continue;
      }
      const expectedType = entry.actionClass === 'support_write' ? 'mutation' : 'query';
      const actualType = procedure._def?.type ?? 'query';
      if (actualType !== expectedType) {
        problems.push(`${entry.key}: ${actualType}, expected ${expectedType}`);
      }
    }

    expect(problems).toEqual([]);
  });

  test('the never list is disjoint from both allowlists', () => {
    const keys = new Set(allowlist.map(entry => entry.key));
    expect(SUPPORT_NEVER_KEYS.filter(key => keys.has(key))).toEqual([]);
  });
});

describe('support never-list keys resolve to real surfaces', () => {
  test('tRPC never keys are real procedures', () => {
    const missing = SUPPORT_NEVER_KEYS.filter(key => !key.startsWith('/') && !procedures[key]);
    expect(missing).toEqual([]);
  });

  test('path never keys are real app routes', () => {
    const routes = new Set(
      walkFiles(APP_ROOT).map(file => {
        const relative = path.relative(APP_ROOT, path.resolve(file));
        const segments = relative.split(path.sep).filter(segment => !/^\(.+\)$/.test(segment));
        return `/${segments.join('/')}`;
      })
    );
    const missing = SUPPORT_NEVER_KEYS.filter(
      key => key.startsWith('/') && !routes.has(`${key}/page.tsx`) && !routes.has(`${key}/route.ts`)
    );
    expect(missing).toEqual([]);
  });
});

describe('support never-list payment and credential procedures use real membership only', () => {
  // The payment, credential and connection subset of the never-list. The other
  // never-list keys (member changes, pending-installation cancel, deletes,
  // agent operations) keep their guarded legacy staff path on purpose.
  const MEMBERSHIP_ONLY_NEVER_PROCEDURES = [
    'organizations.autoTopUp.toggle',
    'organizations.autoTopUp.changePaymentMethod',
    'organizations.autoTopUp.updateAmount',
    'organizations.autoTopUp.updateThreshold',
    'organizations.autoTopUp.removePaymentMethod',
    'organizations.subscription.cancel',
    'organizations.subscription.updateSeatCount',
    'organizations.subscription.changeBillingCycle',
    'organizations.subscription.getCustomerPortalUrl',
    'organizations.subscription.getSubscriptionStripeUrl',
    'organizations.kiloPass.createCheckout',
    'organizations.kiloPass.cancel',
    'organizations.bitbucket.connect',
    'organizations.bitbucket.replaceToken',
    'organizations.cloudAgentNext.createWorktreeChat',
    'organizations.reviewAgent.rotateGitLabWebhookSecret',
  ];
  // A builder's own guard is its last middleware; every procedure built on it
  // carries that same function.
  const membershipOnlyGuards = new Set(
    [
      organizationMemberOnlyMutationProcedure,
      organizationBillingMemberProcedure,
      organizationBillingMemberMutationProcedure,
    ].map(builder => (builder as ProcedureDef)._def?.middlewares?.at(-1))
  );
  const staffReachingGuards = new Set(
    [
      organizationMemberProcedure,
      organizationMemberMutationProcedure,
      organizationAdminProcedure,
      organizationAdminMutationProcedure,
      organizationBillingProcedure,
      organizationBillingMutationProcedure,
    ].map(builder => (builder as ProcedureDef)._def?.middlewares?.at(-1))
  );
  const staffHelpers =
    /\b(?:ensureOrganizationAccess|ensureOrganizationAccessAndFetchOrg|resolveOrganizationAccess|requireOrganizationStaffAuthority|requireStaffAuthority|getAuthorizedOrgContext|elevateViaKiloAdmin)\b/;

  test('the subset is on the never-list and the guard sets are distinct functions', () => {
    expect(
      MEMBERSHIP_ONLY_NEVER_PROCEDURES.filter(key => !SUPPORT_NEVER_KEYS.includes(key))
    ).toEqual([]);
    expect(membershipOnlyGuards.size).toBe(3);
    expect(staffReachingGuards.size).toBe(6);
    expect([...membershipOnlyGuards].filter(guard => staffReachingGuards.has(guard))).toEqual([]);
  });

  test('each procedure runs a membership-only guard and nothing that reaches the staff branch', () => {
    const problems = MEMBERSHIP_ONLY_NEVER_PROCEDURES.flatMap(key => {
      const def = procedures[key]?._def;
      if (!def) return [`${key}: not mounted`];
      const middlewares = def.middlewares ?? [];
      const found: string[] = [];
      if (!middlewares.some(middleware => membershipOnlyGuards.has(middleware))) {
        found.push(`${key}: no membership-only guard`);
      }
      if (middlewares.some(middleware => staffReachingGuards.has(middleware))) {
        found.push(`${key}: legacy organization guard with a staff branch`);
      }
      if (privilegedGuardTiers(middlewares).length > 0) found.push(`${key}: privileged guard tier`);
      for (const code of [...middlewares, def.resolver]) {
        if (staffHelpers.test(String(code ?? ''))) {
          found.push(`${key}: calls a staff-reaching helper`);
          break;
        }
      }
      return found;
    });

    expect(problems).toEqual([]);
  });

  // It stores an organization credential but has no builder guard: its
  // resolver checks real owner or billing-manager membership only when the
  // input names an organization, so pin it by its source. A personal connect
  // stays an ordinary call with no staff classification. The app shell mounts
  // the same procedure object.
  test('gitlab.connectWithPAT checks real membership on its organization branch only', () => {
    const key = 'gitlab.connectWithPAT';
    const def = procedures[key]?._def;
    const appShellProcedures = appShellProceduresRouter._def.procedures as Record<
      string,
      ProcedureDef
    >;
    const middlewares = def?.middlewares ?? [];
    const resolver = String(def?.resolver ?? '');

    expect(SUPPORT_NEVER_KEYS).toContain(key);
    expect(appShellProcedures[key]?._def).toBe(def);
    expect(resolver).toMatch(
      /if \(input\.organizationId\) \{\s*await \(?(?:0, )?[\w.]*ensureMemberOrganizationAccess\)?\(\s*ctx\.user,\s*input\.organizationId,\s*[\w.]*ORGANIZATION_BILLING_ROLES,?\s*\)/
    );
    expect(
      [...middlewares, def?.resolver].filter(code => staffHelpers.test(String(code ?? '')))
    ).toEqual([]);
    expect(middlewares.filter(middleware => staffReachingGuards.has(middleware))).toEqual([]);
    expect(privilegedGuardTiers(middlewares)).toEqual([]);
    expect(findPrivilegedInventoryEntry({ surface: 'trpc', route: key })).toBeUndefined();
  });

  // Credential issuers and stores with no builder guard: each resolver checks
  // real membership first, on its organization branch, before it reads, stores
  // or deletes the credential. A personal call stays ordinary. Each pattern
  // pins the opening statements of the compiled resolver, comments removed.
  const call = (name: string) => String.raw`await \(?(?:0, )?[\w.]*${name}\)?\(`;
  const member = (organizationId: string, roles: string) =>
    String.raw`${call('ensureMemberOrganizationAccess')}\s*ctx\.user,\s*${organizationId},\s*[\w.]*${roles},?\s*\)`;
  const optionalInputOrganization = String.raw`(?:input\?\.organizationId|input === null \|\| input === void 0 \? void 0 : input\.organizationId)`;
  const RESOLVER_BRANCH_NEVER_PROCEDURES: {
    key: string;
    opening: string;
    inventoryId: string | null;
  }[] = [
    {
      key: 'dolthub.getInstallationCredentials',
      opening: String.raw`if \(${optionalInputOrganization}\) \{\s*${member(String.raw`input\.organizationId`, 'ORGANIZATION_BILLING_ROLES')};?\s*\}\s*const owner = \(?(?:0, )?[\w.]*resolveOwner\)?\(ctx, ${optionalInputOrganization}\)`,
      inventoryId: null,
    },
    {
      key: 'byok.create',
      opening: String.raw`const \{\s*organizationId,\s*provider_id,\s*api_key\s*\} = input;\s*const organizationRole = organizationId \? ${member('organizationId', 'ORGANIZATION_BILLING_ROLES')} : null;`,
      inventoryId: null,
    },
    {
      key: 'byok.update',
      opening: String.raw`const \{\s*organizationId,\s*id,\s*api_key\s*\} = input;\s*const organizationRole = organizationId \? ${member('organizationId', 'ORGANIZATION_BILLING_ROLES')} : null;`,
      inventoryId: null,
    },
    {
      key: 'byok.delete',
      opening: String.raw`const \{\s*organizationId,\s*id\s*\} = input;\s*if \(organizationId\) \{\s*${member('organizationId', 'ORGANIZATION_BILLING_ROLES')};?\s*\}`,
      inventoryId: null,
    },
    {
      key: 'organizations.vercelCompute.add',
      opening: String.raw`${member(String.raw`input\.organizationId`, 'ORGANIZATION_MANAGE_ROLES')};?\s*return ${call('addForOwner')}`,
      inventoryId: 'trpc.organizations',
    },
    {
      key: 'organizations.vercelCompute.remove',
      opening: String.raw`${member(String.raw`input\.organizationId`, 'ORGANIZATION_MANAGE_ROLES')};?\s*return ${call('removeForOwner')}`,
      inventoryId: 'trpc.organizations',
    },
  ];

  test('each credential resolver checks real membership before it touches the credential', () => {
    const appShellProcedures = appShellProceduresRouter._def.procedures as Record<
      string,
      ProcedureDef
    >;
    const problems = RESOLVER_BRANCH_NEVER_PROCEDURES.flatMap(({ key, opening, inventoryId }) => {
      const def = procedures[key]?._def;
      if (!def) return [`${key}: not mounted`];
      const middlewares = def.middlewares ?? [];
      const resolver = String(def.resolver ?? '').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
      const found: string[] = [];
      if (!SUPPORT_NEVER_KEYS.includes(key)) found.push(`${key}: not on the never-list`);
      if (appShellProcedures[key]) found.push(`${key}: mounted on the app shell`);
      if (!new RegExp(String.raw`=>\s*\{\s*${opening}`).test(resolver)) {
        found.push(`${key}: does not open with the membership check`);
      }
      if ([...middlewares, def.resolver].some(code => staffHelpers.test(String(code ?? '')))) {
        found.push(`${key}: calls a staff-reaching helper`);
      }
      if (middlewares.some(middleware => staffReachingGuards.has(middleware))) {
        found.push(`${key}: legacy organization guard with a staff branch`);
      }
      if (privilegedGuardTiers(middlewares).length > 0) found.push(`${key}: privileged guard tier`);
      const entry = findPrivilegedInventoryEntry({ surface: 'trpc', route: key });
      if ((entry?.id ?? null) !== inventoryId) {
        found.push(`${key}: inventory entry ${entry?.id ?? 'none'}`);
      }
      return found;
    });

    expect(problems).toEqual([]);
  });

  test('a credential resolver pattern rejects a dropped or moved membership check', () => {
    const byokDelete = RESOLVER_BRANCH_NEVER_PROCEDURES.find(row => row.key === 'byok.delete');
    const pattern = new RegExp(String.raw`=>\s*\{\s*${byokDelete?.opening ?? '(?!)'}`);
    const guarded = [
      'async ({ input, ctx })=>{',
      '  const { organizationId, id } = input;',
      '  if (organizationId) {',
      '    await (0, _utils.ensureMemberOrganizationAccess)(ctx.user, organizationId, _organizations.ORGANIZATION_BILLING_ROLES);',
      '  }',
      '  const [existingKey] = await db.select();',
      '}',
    ].join('\n');

    expect(pattern.test(guarded)).toBe(true);
    expect(pattern.test(guarded.replace(/ {2}if \(organizationId\) \{\n.*\n {2}\}\n/, ''))).toBe(
      false
    );
    expect(
      pattern.test(guarded.replace('ORGANIZATION_BILLING_ROLES', 'ORGANIZATION_MEMBER_ROLES'))
    ).toBe(false);
    expect(
      pattern.test(
        guarded.replace(
          '  const { organizationId, id } = input;\n',
          '  const { organizationId, id } = input;\n  await deleteKey(id);\n'
        )
      )
    ).toBe(false);
  });
});

describe('targetIdFromInput', () => {
  test('reads userId for admin.users.resetAPIKey', () => {
    const field = targetIdFieldForAdminProcedure('admin.users.resetAPIKey');
    expect(field).toBe('userId');
    expect(targetIdFromInput(field, { userId: 'user-1' })).toBe('user-1');
  });

  test('reads kilo_user_id for admin.users.addNote', () => {
    const field = targetIdFieldForAdminProcedure('admin.users.addNote');
    expect(field).toBe('kilo_user_id');
    expect(targetIdFromInput(field, { kilo_user_id: 'user-2' })).toBe('user-2');
  });

  test('reads organizationId for admin.salesDemo.reset', () => {
    const field = targetIdFieldForAdminProcedure('admin.salesDemo.reset');
    expect(field).toBe('organizationId');
    expect(targetIdFromInput(field, { organizationId: 'org-1' })).toBe('org-1');
  });

  test('reads userId for an account-area procedure that is not listed', () => {
    const field = targetIdFieldForAdminProcedure('admin.users.updateBlockStatus');
    expect(field).toBe('userId');
    expect(targetIdFromInput(field, { userId: 'user-4' })).toBe('user-4');
  });

  test('records the kind the field names', () => {
    expect(targetKindForInputField('userId')).toBe('user');
    expect(targetKindForInputField('kilo_user_id')).toBe('user');
    expect(targetKindForInputField('organizationId')).toBe('organization');
  });

  test('names no field for procedures without a single target', () => {
    expect(targetIdFieldForAdminProcedure('admin.supportAccess.deny')).toBeNull();
    expect(targetIdFieldForAdminProcedure('admin.users.deleteNote')).toBeNull();
    expect(targetIdFieldForAdminProcedure('admin.unknown.procedure')).toBeNull();
  });

  test('binds kilo_user_id when a body also carries userId', () => {
    const field = targetIdFieldForAdminProcedure('admin.users.addNote');
    expect(targetIdFromInput(field, { kilo_user_id: 'user-2', userId: 'user-9' })).toBe('user-2');
  });

  test('names no target for a body that carries an extra organizationId', () => {
    const field = targetIdFieldForAdminProcedure('admin.supportAccess.deny');
    expect(targetIdFromInput(field, { grantId: 'grant-1', organizationId: 'org-1' })).toBeNull();
  });

  test('returns null for a null field', () => {
    expect(targetIdFromInput(null, { organizationId: 'org-1' })).toBeNull();
  });

  test('returns null when the input names no such field', () => {
    expect(targetIdFromInput('userId', { organizationId: 'org-1' })).toBeNull();
  });

  test('returns null for an empty id', () => {
    expect(targetIdFromInput('userId', { userId: '' })).toBeNull();
  });

  test('returns null for an id longer than the client schema allows', () => {
    expect(targetIdFromInput('userId', { userId: 'u'.repeat(201) })).toBeNull();
    expect(targetIdFromInput('userId', { userId: 'u'.repeat(200) })).toBe('u'.repeat(200));
  });

  test('returns null for input that is not an object', () => {
    expect(targetIdFromInput('userId', 'user-1')).toBeNull();
    expect(targetIdFromInput('userId', null)).toBeNull();
    expect(targetIdFromInput('userId', undefined)).toBeNull();
  });

  test('reads a FormData body', () => {
    const body = new FormData();
    body.set('userId', 'user-3');
    expect(targetIdFromInput('userId', body)).toBe('user-3');
  });
});

describe('admin target id fields name mounted mutations', () => {
  test('every key of the map is a mounted mutation', () => {
    const problems: string[] = [];

    for (const [route, field] of Object.entries(TARGET_ID_FIELD_BY_ADMIN_PROCEDURE)) {
      const procedure = procedures[route];
      if (!procedure) {
        problems.push(`${route} (no procedure)`);
        continue;
      }
      if ((procedure._def?.type ?? 'query') !== 'mutation') {
        problems.push(`${route}: ${procedure._def?.type ?? 'query'}, expected mutation`);
      }
      if (field !== null && field.trim().length === 0) problems.push(`${route} (empty field)`);
    }

    expect(problems).toEqual([]);
  });
});
