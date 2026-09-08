import { readdir, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const serviceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const handlerFiles = new Set([
  'src/router/handlers/session-start.ts',
  'src/router/handlers/session-prepare.ts',
]);
const registrationFile = 'src/session/session-registration.ts';
const preflightFile = 'src/router/handlers/session-creation-preflight.ts';
const registrationNames = new Set([
  'registerNewSession',
  'startNewSession',
  'createSessionWithLedger',
]);
const forbiddenHandlerSymbols = new Set([
  'src/model-validation.ts\0assertKiloModelAvailable',
  'src/session/validate-repository-access.ts\0assertRepositoryAccessBeforeSessionCreation',
  'src/router/handlers/organization-membership.ts\0assertOrganizationMembership',
  `${preflightFile}\0profileResolutionPolicyForSessionCreateOrigin`,
  `${preflightFile}\0resolveEffectiveSessionConfiguration`,
  `${preflightFile}\0assertModeAvailableForProfile`,
]);
const excludedDirectories = new Set([
  '__fixtures__',
  '__mocks__',
  '__snapshots__',
  '__tests__',
  '.wrangler',
  'build',
  'coverage',
  'deps',
  'dist',
  'fixture',
  'fixtures',
  'generated',
  'node_modules',
  'out',
  'recordings',
  'specs',
  'test',
  'testdata',
  'tests',
]);

export type ArchitectureViolation = {
  file: string;
  rule: 'creation-preflight' | 'registration-owner' | 'worker-wrapper-boundary';
  message: string;
  line?: number;
};

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}

function isExcluded(path: string): boolean {
  const parts = path.split('/');
  const basename = parts.at(-1) ?? '';
  return (
    parts.some(part => excludedDirectories.has(part)) ||
    /\.(?:test|spec)\.[^.]+$/.test(basename) ||
    /(?:^|[-_.])fixtures?(?:[-_.]|$)/.test(basename) ||
    /(?:^|[-_.])test[-_.]?data(?:[-_.]|$)/.test(basename) ||
    /\.d\.[cm]?tsx?$/.test(basename) ||
    /\.(?:gen|generated)\.[cm]?tsx?$/.test(basename)
  );
}

async function collectProductionFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const relativePath = normalizePath(relative(root, absolute));
      if (isExcluded(relativePath)) continue;
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && /\.[cm]?tsx?$/.test(entry.name)) files.push(absolute);
    }
  }
  await visit(join(root, 'src'));
  await visit(join(root, 'wrapper/src'));
  return files.toSorted();
}

function sourceFilePath(root: string, sourceFile: ts.SourceFile): string {
  return normalizePath(relative(root, sourceFile.fileName));
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function resolveLocalModule(
  sourceFile: string,
  specifier: string,
  files: ReadonlySet<string>
): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const requested = normalizePath(resolve(dirname(sourceFile), specifier));
  const withoutScriptExtension = requested.replace(/\.(?:mjs|cjs|js|jsx|mts|cts|ts|tsx)$/, '');
  const candidates = [
    requested,
    `${withoutScriptExtension}.ts`,
    `${withoutScriptExtension}.tsx`,
    `${withoutScriptExtension}.mts`,
    `${withoutScriptExtension}.cts`,
    `${requested}/index.ts`,
    `${requested}/index.tsx`,
  ];
  return candidates.find(candidate => files.has(candidate));
}

function moduleSpecifiers(sourceFile: ts.SourceFile): ts.StringLiteralLike[] {
  const specifiers: ts.StringLiteralLike[] = [];
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return specifiers;
}

function canonicalSymbol(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined
): ts.Symbol | undefined {
  const seen = new Set<ts.Symbol>();
  let current = symbol;
  while (current && (current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
    seen.add(current);
    const next = checker.getAliasedSymbol(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

function symbolAtExpression(
  checker: ts.TypeChecker,
  expression: ts.Expression
): ts.Symbol | undefined {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  if (ts.isPropertyAccessExpression(current)) {
    return canonicalSymbol(checker, checker.getSymbolAtLocation(current.name));
  }
  if (ts.isElementAccessExpression(current) && ts.isStringLiteralLike(current.argumentExpression)) {
    return canonicalSymbol(checker, checker.getSymbolAtLocation(current.argumentExpression));
  }
  return canonicalSymbol(checker, checker.getSymbolAtLocation(current));
}

function symbolIdentity(
  root: string,
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined
): string | undefined {
  const resolvedSymbol = canonicalSymbol(checker, symbol);
  const declaration = resolvedSymbol?.declarations?.find(candidate =>
    sourceFilePath(root, candidate.getSourceFile()).startsWith('src/')
  );
  if (!resolvedSymbol || !declaration) return undefined;
  return `${sourceFilePath(root, declaration.getSourceFile())}\0${resolvedSymbol.getName()}`;
}

function callIdentity(
  root: string,
  checker: ts.TypeChecker,
  call: ts.CallExpression
): string | undefined {
  return symbolIdentity(root, checker, symbolAtExpression(checker, call.expression));
}

function collectCalls(sourceFile: ts.SourceFile): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return calls;
}

function containingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current) ||
      ts.isConstructorDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function preflightDeclaration(
  root: string,
  checker: ts.TypeChecker,
  body: ts.Block
): ts.VariableDeclaration | undefined {
  const candidates: ts.VariableDeclaration[] = [];
  for (const statement of body.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      (statement.declarationList.flags & ts.NodeFlags.Const) === 0 ||
      statement.declarationList.declarations.length !== 1
    ) {
      continue;
    }
    const declaration = statement.declarationList.declarations[0];
    if (
      declaration &&
      ts.isIdentifier(declaration.name) &&
      declaration.initializer &&
      ts.isAwaitExpression(declaration.initializer) &&
      ts.isCallExpression(declaration.initializer.expression) &&
      callIdentity(root, checker, declaration.initializer.expression) ===
        `${preflightFile}\0preflightSessionCreation`
    ) {
      candidates.push(declaration);
    }
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

const assignmentOperators = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

function bindingIsMutated(
  checker: ts.TypeChecker,
  body: ts.Block,
  declaration: ts.VariableDeclaration,
  before: number
): boolean {
  const declarationSymbol = canonicalSymbol(checker, checker.getSymbolAtLocation(declaration.name));
  let mutated = false;
  function isRootedAtDeclaration(expression: ts.Expression): boolean {
    let current = expression;
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
    }
    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      current = current.expression;
      while (
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isSatisfiesExpression(current) ||
        ts.isNonNullExpression(current)
      ) {
        current = current.expression;
      }
    }
    return (
      ts.isIdentifier(current) &&
      canonicalSymbol(checker, checker.getSymbolAtLocation(current)) === declarationSymbol
    );
  }
  function visit(node: ts.Node): void {
    if (mutated || node.getStart() >= before) return;
    if (ts.isBinaryExpression(node) && assignmentOperators.has(node.operatorToken.kind)) {
      if (isRootedAtDeclaration(node.left)) {
        mutated = true;
        return;
      }
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken) &&
      isRootedAtDeclaration(node.operand)
    ) {
      mutated = true;
      return;
    }
    if (ts.isDeleteExpression(node) && isRootedAtDeclaration(node.expression)) {
      mutated = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(body);
  return mutated;
}

function importedSymbols(checker: ts.TypeChecker, sourceFile: ts.SourceFile): ts.Symbol[] {
  const symbols: ts.Symbol[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const clause = statement.importClause;
    if (clause.name) {
      const symbol = canonicalSymbol(checker, checker.getSymbolAtLocation(clause.name));
      if (symbol) symbols.push(symbol);
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        const symbol = canonicalSymbol(checker, checker.getSymbolAtLocation(element.name));
        if (symbol) symbols.push(symbol);
      }
    } else if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      const moduleSymbol = checker.getSymbolAtLocation(statement.moduleSpecifier);
      if (moduleSymbol) {
        for (const exported of checker.getExportsOfModule(moduleSymbol)) {
          const symbol = canonicalSymbol(checker, exported);
          if (symbol) symbols.push(symbol);
        }
      }
    }
  }
  return symbols;
}

function dynamicImportedSymbols(checker: ts.TypeChecker, sourceFile: ts.SourceFile): ts.Symbol[] {
  const symbols: ts.Symbol[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const moduleSymbol = checker.getSymbolAtLocation(node.arguments[0]);
      if (moduleSymbol) {
        for (const exported of checker.getExportsOfModule(moduleSymbol)) {
          const symbol = canonicalSymbol(checker, exported);
          if (symbol) symbols.push(symbol);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return symbols;
}

function importsProfileResolverDirectly(sourceFile: ts.SourceFile): boolean {
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== '@kilocode/cloud-agent-profile' ||
      !statement.importClause?.namedBindings
    ) {
      continue;
    }
    if (ts.isNamespaceImport(statement.importClause.namedBindings)) return true;
    if (
      statement.importClause.namedBindings.elements.some(
        element => (element.propertyName ?? element.name).text === 'mergeProfileConfiguration'
      )
    ) {
      return true;
    }
  }
  return false;
}

function dynamicallyImportsProfileResolverDirectly(sourceFile: ts.SourceFile): boolean {
  return moduleSpecifiers(sourceFile).some(
    specifier =>
      ts.isCallExpression(specifier.parent) &&
      specifier.parent.expression.kind === ts.SyntaxKind.ImportKeyword &&
      specifier.text === '@kilocode/cloud-agent-profile'
  );
}

function isProfileResolverSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): boolean {
  const resolvedSymbol = canonicalSymbol(checker, symbol);
  if (resolvedSymbol?.getName() !== 'mergeProfileConfiguration') return false;
  return Boolean(
    resolvedSymbol.declarations?.some(declaration => {
      const file = normalizePath(declaration.getSourceFile().fileName);
      return (
        file.includes('/node_modules/@kilocode/cloud-agent-profile/') ||
        file.includes('/packages/cloud-agent-profile/')
      );
    })
  );
}

function isSupportedRegistrationReference(node: ts.Identifier): boolean {
  if (
    ts.isImportSpecifier(node.parent) ||
    ts.isExportSpecifier(node.parent) ||
    (ts.isFunctionDeclaration(node.parent) && node.parent.name === node)
  ) {
    return true;
  }

  let expression: ts.Expression = node;
  if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) {
    expression = node.parent;
  }
  while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
  return ts.isCallExpression(expression.parent) && expression.parent.expression === expression;
}

function isDirectCallExpression(expression: ts.Expression): boolean {
  let current = expression;
  while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
  return ts.isCallExpression(current.parent) && current.parent.expression === current;
}

function registrationNamespaceSymbols(
  root: string,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile
): Set<ts.Symbol> {
  const symbols = new Set<ts.Symbol>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamespaceImport(statement.importClause.namedBindings)
    ) {
      continue;
    }
    const moduleSymbol = checker.getSymbolAtLocation(statement.moduleSpecifier);
    if (
      !moduleSymbol ||
      !checker
        .getExportsOfModule(moduleSymbol)
        .some(
          exported =>
            symbolIdentity(root, checker, exported)?.startsWith(`${registrationFile}\0`) ?? false
        )
    ) {
      continue;
    }
    const symbol = checker.getSymbolAtLocation(statement.importClause.namedBindings.name);
    if (symbol) symbols.add(symbol);
  }
  return symbols;
}

function addViolation(
  violations: ArchitectureViolation[],
  sourceFile: ts.SourceFile,
  root: string,
  rule: ArchitectureViolation['rule'],
  message: string,
  node?: ts.Node
): void {
  violations.push({
    file: sourceFilePath(root, sourceFile),
    rule,
    message,
    ...(node ? { line: lineOf(sourceFile, node) } : {}),
  });
}

export async function analyzeArchitecture(rootInput: string): Promise<ArchitectureViolation[]> {
  const root = await realpath(rootInput);
  const files = await collectProductionFiles(root);
  if (!files.length)
    throw new Error('No production TypeScript files found for architecture analysis');
  const fileSet = new Set(files.map(file => resolve(file)));
  const program = ts.createProgram({
    rootNames: files,
    options: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowJs: false,
      skipLibCheck: true,
      noEmit: true,
    },
  });
  const checker = program.getTypeChecker();
  const violations: ArchitectureViolation[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    const file = sourceFilePath(root, sourceFile);
    if (!fileSet.has(resolve(sourceFile.fileName)) || isExcluded(file)) continue;

    for (const specifier of moduleSpecifiers(sourceFile)) {
      if (!specifier.text.startsWith('.')) continue;
      const target = resolveLocalModule(sourceFile.fileName, specifier.text, fileSet);
      if (!target) {
        continue;
      }
      const targetFile = normalizePath(relative(root, target));
      if (
        file.startsWith('wrapper/src/') &&
        targetFile.startsWith('src/') &&
        !targetFile.startsWith('src/shared/')
      ) {
        addViolation(
          violations,
          sourceFile,
          root,
          'worker-wrapper-boundary',
          `Wrapper production code may import Worker code only from src/shared (resolved ${targetFile})`,
          specifier
        );
      }
      if (file.startsWith('src/') && targetFile.startsWith('wrapper/')) {
        addViolation(
          violations,
          sourceFile,
          root,
          'worker-wrapper-boundary',
          `Worker production code must not import wrapper code (resolved ${targetFile})`,
          specifier
        );
      }
    }

    if (handlerFiles.has(file)) {
      const imports = importedSymbols(checker, sourceFile);
      const dynamicImports = dynamicImportedSymbols(checker, sourceFile);
      const lowLevelImports = [...imports, ...dynamicImports];
      if (
        importsProfileResolverDirectly(sourceFile) ||
        dynamicallyImportsProfileResolverDirectly(sourceFile) ||
        lowLevelImports.some(symbol => isProfileResolverSymbol(checker, symbol))
      ) {
        addViolation(
          violations,
          sourceFile,
          root,
          'creation-preflight',
          'Creation handler imports low-level profile resolver mergeProfileConfiguration'
        );
      }
      for (const symbol of lowLevelImports) {
        const identity = symbolIdentity(root, checker, symbol);
        if (identity && forbiddenHandlerSymbols.has(identity)) {
          addViolation(
            violations,
            sourceFile,
            root,
            'creation-preflight',
            `Creation handler imports low-level admission symbol ${identity.split('\0')[1]}`
          );
        }
      }
    }

    const calls = collectCalls(sourceFile);
    const registrationNamespaces = registrationNamespaceSymbols(root, checker, sourceFile);

    function checkRegistrationReferences(node: ts.Node): void {
      if (ts.isIdentifier(node)) {
        const localSymbol = checker.getSymbolAtLocation(node);
        if (
          localSymbol &&
          registrationNamespaces.has(localSymbol) &&
          !ts.isNamespaceImport(node.parent) &&
          !(
            (ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node) ||
            (ts.isElementAccessExpression(node.parent) &&
              node.parent.expression === node &&
              ts.isStringLiteralLike(node.parent.argumentExpression))
          )
        ) {
          addViolation(
            violations,
            sourceFile,
            root,
            'registration-owner',
            'Registration namespaces must not be destructured, aliased, or passed as references',
            node
          );
        }
        const identity = symbolIdentity(root, checker, checker.getSymbolAtLocation(node));
        if (identity) {
          const separator = identity.lastIndexOf('\0');
          const originFile = identity.slice(0, separator);
          const name = identity.slice(separator + 1);
          if (
            originFile === registrationFile &&
            registrationNames.has(name) &&
            !isSupportedRegistrationReference(node)
          ) {
            addViolation(
              violations,
              sourceFile,
              root,
              'registration-owner',
              `${name} must be called directly; local aliases and passed references are not allowed`,
              node
            );
          }
        }
      }
      if (ts.isElementAccessExpression(node)) {
        const identity = symbolIdentity(root, checker, symbolAtExpression(checker, node));
        if (identity) {
          const separator = identity.lastIndexOf('\0');
          const originFile = identity.slice(0, separator);
          const name = identity.slice(separator + 1);
          if (
            originFile === registrationFile &&
            registrationNames.has(name) &&
            !isDirectCallExpression(node)
          ) {
            addViolation(
              violations,
              sourceFile,
              root,
              'registration-owner',
              `${name} must be called directly; local aliases and passed references are not allowed`,
              node
            );
          }
        }
      }
      ts.forEachChild(node, checkRegistrationReferences);
    }
    checkRegistrationReferences(sourceFile);

    if (
      handlerFiles.has(file) &&
      !calls.some(
        call => callIdentity(root, checker, call) === `${preflightFile}\0preflightSessionCreation`
      )
    ) {
      addViolation(
        violations,
        sourceFile,
        root,
        'creation-preflight',
        'Creation handler must call preflightSessionCreation; an import alone is not sufficient'
      );
    }

    for (const call of calls) {
      const identity = callIdentity(root, checker, call);
      if (!identity) continue;
      const separator = identity.lastIndexOf('\0');
      const originFile = separator >= 0 ? identity.slice(0, separator) : undefined;
      const name = separator >= 0 ? identity.slice(separator + 1) : undefined;
      if (originFile !== registrationFile || !name || !registrationNames.has(name)) continue;

      if (file !== registrationFile && !handlerFiles.has(file)) {
        addViolation(
          violations,
          sourceFile,
          root,
          'registration-owner',
          `${name} may be called only by the creation handlers or session-registration.ts`,
          call
        );
        continue;
      }
      if (file === registrationFile) continue;

      const owner = containingFunction(call);
      if (!owner?.body || !ts.isBlock(owner.body)) {
        addViolation(
          violations,
          sourceFile,
          root,
          'creation-preflight',
          `${name} must execute in a block with an unconditional preflight result`,
          call
        );
        continue;
      }
      const admitted = preflightDeclaration(root, checker, owner.body);
      if (!admitted || admitted.getStart(sourceFile) >= call.getStart(sourceFile)) {
        addViolation(
          violations,
          sourceFile,
          root,
          'creation-preflight',
          `${name} must follow one unconditional const binding awaited from preflightSessionCreation in the same function body`,
          call
        );
        continue;
      }
      if (bindingIsMutated(checker, owner.body, admitted, call.getStart(sourceFile))) {
        addViolation(
          violations,
          sourceFile,
          root,
          'creation-preflight',
          'The admitted preflight result must not be overwritten or updated',
          call
        );
        continue;
      }
      const firstArgument = call.arguments[0];
      const admittedSymbol = canonicalSymbol(checker, checker.getSymbolAtLocation(admitted.name));
      const argumentSymbol =
        firstArgument && ts.isIdentifier(firstArgument)
          ? canonicalSymbol(checker, checker.getSymbolAtLocation(firstArgument))
          : undefined;
      if (!firstArgument || !ts.isIdentifier(firstArgument) || argumentSymbol !== admittedSymbol) {
        addViolation(
          violations,
          sourceFile,
          root,
          'creation-preflight',
          `${name} must receive the exact unshadowed preflight result as its first argument`,
          call
        );
      }
    }
  }

  return violations.toSorted((left, right) =>
    `${left.file}\0${String(left.line ?? 0)}\0${left.rule}\0${left.message}`.localeCompare(
      `${right.file}\0${String(right.line ?? 0)}\0${right.rule}\0${right.message}`
    )
  );
}

export async function runArchitectureCheck(root = serviceRoot): Promise<void> {
  const violations = await analyzeArchitecture(root);
  if (violations.length) {
    const details = violations
      .map(
        violation =>
          `[${violation.rule}] ${violation.file}${violation.line ? `:${violation.line}` : ''}\n  ${violation.message}`
      )
      .join('\n');
    throw new Error(`Found ${violations.length} architecture boundary violation(s):\n${details}`);
  }
  console.log('check:architecture: production ownership boundaries are valid.');
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  runArchitectureCheck().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
