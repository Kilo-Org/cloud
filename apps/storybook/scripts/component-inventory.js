import { access, mkdir, readdir, readFile, writeFile } from 'fs/promises';
import { constants } from 'fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const storybookRoot = resolve(__dirname, '..');
const repoRoot = resolve(storybookRoot, '../..');
const webSrcRoot = resolve(repoRoot, 'apps/web/src');
const storybookStoriesRoot = resolve(storybookRoot, 'stories');

const sourceExtensions = ['.tsx', '.ts', '.jsx', '.js'];
const storyExtensions = ['.stories.tsx', '.stories.ts', '.stories.jsx', '.stories.js', '.mdx'];
const excludedPathParts = new Set([
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'generated',
  'node_modules',
  'out',
  'public',
  'storybook-static',
  'test-results',
]);

function parseArgs(argv) {
  const options = {
    json: false,
    output: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--output') {
      const nextArg = argv[index + 1];
      if (!nextArg) {
        throw new Error('--output requires a path');
      }
      options.output = nextArg;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function toPosixPath(path) {
  return path.split('\\').join('/');
}

function toRepoRelativePath(filePath) {
  return toPosixPath(relative(repoRoot, filePath));
}

function hasExcludedPart(filePath) {
  return toPosixPath(relative(repoRoot, filePath))
    .split('/')
    .some(part => excludedPathParts.has(part));
}

function isSourceFile(filePath) {
  const extension = extname(filePath);
  if (!sourceExtensions.includes(extension)) {
    return false;
  }
  const basename = filePath.split('/').pop() ?? '';
  return !/(^|\.)(test|spec)\.[jt]sx?$/.test(basename) && !basename.endsWith('.d.ts');
}

function isStoryFile(filePath) {
  return storyExtensions.some(extension => filePath.endsWith(extension));
}

async function pathExists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function collectFiles(root, predicate) {
  if (!(await pathExists(root))) {
    return [];
  }

  const entries = await readdir(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = resolve(root, entry.name);
    if (hasExcludedPart(fullPath)) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath, predicate)));
      continue;
    }
    if (entry.isFile() && predicate(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

function stripComments(content) {
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function isPascalCase(name) {
  return /^[A-Z][A-Za-z0-9]*$/.test(name);
}

function looksReactLike(name, initializer) {
  if (!isPascalCase(name)) {
    return false;
  }
  if (!initializer) {
    return true;
  }
  return (
    /=>\s*[\n\s]*[<(]/.test(initializer) ||
    /React\.(forwardRef|memo|lazy)\s*(?:<[\s\S]*?>)?\s*\(/.test(initializer) ||
    /\b(memo|forwardRef)\s*(?:<[\s\S]*?>)?\s*\(/.test(initializer) ||
    /\bfunction\s+[A-Z][A-Za-z0-9]*\s*\(/.test(initializer)
  );
}

function getLineNumber(content, index) {
  return content.slice(0, index).split('\n').length;
}

function extractExportedComponents(content) {
  const stripped = stripComments(content);
  const components = new Map();
  const localCandidates = new Map();

  const addComponent = (name, line, exportType) => {
    if (!isPascalCase(name)) {
      return;
    }
    components.set(name, { name, line, exportType });
  };

  const addLocalCandidate = (name, line) => {
    if (isPascalCase(name)) {
      localCandidates.set(name, { name, line });
    }
  };

  for (const match of stripped.matchAll(
    /(?:^|\n)\s*(?:async\s+)?function\s+([A-Z][A-Za-z0-9]*)\s*\(/g
  )) {
    addLocalCandidate(match[1], getLineNumber(stripped, match.index ?? 0));
  }

  for (const match of stripped.matchAll(
    /(?:^|\n)\s*const\s+([A-Z][A-Za-z0-9]*)\s*=\s*([^;\n]+(?:[\s\S]{0,400}?))/g
  )) {
    const name = match[1];
    const initializer = match[2];
    if (looksReactLike(name, initializer)) {
      addLocalCandidate(name, getLineNumber(stripped, match.index ?? 0));
    }
  }

  for (const match of stripped.matchAll(
    /export\s+(?:async\s+)?function\s+([A-Z][A-Za-z0-9]*)\s*\(/g
  )) {
    addComponent(match[1], getLineNumber(stripped, match.index ?? 0), 'named');
  }

  for (const match of stripped.matchAll(
    /export\s+default\s+(?:async\s+)?function\s+([A-Z][A-Za-z0-9]*)\s*\(/g
  )) {
    addComponent(match[1], getLineNumber(stripped, match.index ?? 0), 'default');
  }

  for (const match of stripped.matchAll(
    /export\s+const\s+([A-Z][A-Za-z0-9]*)\s*=\s*([^;\n]+(?:[\s\S]{0,400}?))/g
  )) {
    const name = match[1];
    const initializer = match[2];
    if (looksReactLike(name, initializer)) {
      addComponent(name, getLineNumber(stripped, match.index ?? 0), 'named');
    }
  }

  for (const match of stripped.matchAll(/export\s*\{([^}]+)\}\s*;?/g)) {
    const exportStatement = match[0];
    if (/\sfrom\s+['"]/.test(exportStatement)) {
      continue;
    }
    const exportSpecifiers = match[1]
      .split(',')
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => {
        const aliasParts = part.split(/\s+as\s+/);
        const localName = aliasParts[0].trim();
        const exportedName = (aliasParts[1] ?? aliasParts[0]).trim();
        return { localName, exportedName };
      });
    for (const { localName, exportedName } of exportSpecifiers) {
      const localCandidate = localCandidates.get(localName);
      if (localCandidate) {
        addComponent(exportedName, localCandidate.line, 'named');
      }
    }
  }

  return [...components.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function shouldInventoryAppComponent(filePath) {
  const appRelativePath = toPosixPath(relative(resolve(webSrcRoot, 'app'), filePath));
  return appRelativePath.split('/').some(part => part === 'components' || part === '_components');
}

async function inventoryComponents() {
  const allFiles = [
    ...(await collectFiles(resolve(webSrcRoot, 'components'), isSourceFile)),
    ...(await collectFiles(
      resolve(webSrcRoot, 'app'),
      filePath => isSourceFile(filePath) && shouldInventoryAppComponent(filePath)
    )),
  ];

  const uniqueFiles = [...new Set(allFiles)].sort();
  const components = [];

  for (const filePath of uniqueFiles) {
    const content = await readFile(filePath, 'utf8');
    const exports = extractExportedComponents(content);
    for (const component of exports) {
      components.push({
        ...component,
        file: toRepoRelativePath(filePath),
        absoluteFile: filePath,
        priority: getPriority(filePath, component.name),
      });
    }
  }

  return components.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
}

function getPriority(filePath, componentName) {
  const relativePath = toPosixPath(relative(webSrcRoot, filePath));
  const highPrioritySegments = [
    'app/(app)',
    'components/auth',
    'components/cloud-agent',
    'components/cloud-agent-next',
    'components/organizations',
    'components/payment',
    'components/shared',
    'components/subscriptions',
  ];
  const isPrimitive = /^components\/ui\//.test(relativePath);
  const isPageOrDialog = /(Page|Dialog|Modal|Form|Card|Banner|Table|Drawer|Step|Panel|View)$/.test(
    componentName
  );

  if (isPrimitive || highPrioritySegments.some(segment => relativePath.startsWith(segment))) {
    return isPageOrDialog || isPrimitive ? 'high' : 'medium';
  }

  return isPageOrDialog ? 'medium' : 'low';
}

function parseImportSpecifiers(importClause) {
  const specifiers = [];
  const namedMatch = importClause.match(/\{([\s\S]*?)\}/);
  if (namedMatch) {
    for (const rawPart of namedMatch[1].split(',')) {
      const part = rawPart.trim();
      if (!part || part.startsWith('type ')) {
        continue;
      }
      const cleanPart = part.replace(/^type\s+/, '');
      const aliasParts = cleanPart.split(/\s+as\s+/);
      const importedName = aliasParts[0].trim();
      if (isPascalCase(importedName)) {
        specifiers.push(importedName);
      }
    }
  }

  const withoutNamed = importClause.replace(/\{[\s\S]*?\}/, '').trim();
  const defaultMatch = withoutNamed.match(/^([A-Z][A-Za-z0-9]*)\s*(?:,|$)/);
  if (defaultMatch) {
    specifiers.push(defaultMatch[1]);
  }

  return specifiers;
}

async function resolveImportPath(importPath, storyFile) {
  if (!importPath.startsWith('@/') && !importPath.startsWith('.') && !importPath.startsWith('/')) {
    return undefined;
  }

  let basePath;
  if (importPath.startsWith('@/')) {
    basePath = resolve(webSrcRoot, importPath.slice(2));
  } else if (isAbsolute(importPath)) {
    basePath = importPath;
  } else {
    basePath = resolve(dirname(storyFile), importPath);
  }

  const candidates = [
    basePath,
    ...sourceExtensions.map(extension => `${basePath}${extension}`),
    ...sourceExtensions.map(extension => join(basePath, `index${extension}`)),
  ];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return resolve(candidate);
    }
  }

  return undefined;
}

async function collectStories() {
  const storyFiles = (await collectFiles(storybookStoriesRoot, isStoryFile)).sort();
  const stories = [];

  for (const storyFile of storyFiles) {
    const content = await readFile(storyFile, 'utf8');
    const imports = [];
    const stripped = stripComments(content);
    for (const match of stripped.matchAll(/import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
      const importedFile = await resolveImportPath(match[2], storyFile);
      if (!importedFile || !toRepoRelativePath(importedFile).startsWith('apps/web/src/')) {
        continue;
      }
      imports.push({
        source: match[2],
        file: toRepoRelativePath(importedFile),
        absoluteFile: importedFile,
        specifiers: parseImportSpecifiers(match[1]),
      });
    }

    const titleMatch = stripped.match(/title\s*:\s*['"]([^'"]+)['"]/);
    stories.push({
      file: toRepoRelativePath(storyFile),
      title: titleMatch ? titleMatch[1] : undefined,
      imports,
    });
  }

  return stories;
}

function applyCoverage(components, stories) {
  const componentsByFile = new Map();
  for (const component of components) {
    const list = componentsByFile.get(component.file) ?? [];
    list.push(component);
    componentsByFile.set(component.file, list);
  }

  const coveredKeys = new Set();
  const storyCoverage = [];

  for (const story of stories) {
    const coveredComponents = [];
    for (const importInfo of story.imports) {
      const importedComponents = componentsByFile.get(importInfo.file) ?? [];
      for (const component of importedComponents) {
        if (importInfo.specifiers.length === 0 || importInfo.specifiers.includes(component.name)) {
          coveredKeys.add(`${component.file}#${component.name}`);
          coveredComponents.push({ name: component.name, file: component.file });
        }
      }
    }
    storyCoverage.push({
      file: story.file,
      title: story.title,
      coveredComponents: dedupeComponents(coveredComponents),
      imports: story.imports.map(importInfo => ({
        source: importInfo.source,
        file: importInfo.file,
        specifiers: importInfo.specifiers,
      })),
    });
  }

  const auditedComponents = components.map(component => ({
    name: component.name,
    file: component.file,
    line: component.line,
    exportType: component.exportType,
    priority: component.priority,
    covered: coveredKeys.has(`${component.file}#${component.name}`),
  }));

  return {
    components: auditedComponents,
    stories: storyCoverage,
  };
}

function dedupeComponents(components) {
  const byKey = new Map();
  for (const component of components) {
    byKey.set(`${component.file}#${component.name}`, component);
  }
  return [...byKey.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name)
  );
}

function createReport(audit) {
  const totalComponents = audit.components.length;
  const coveredComponents = audit.components.filter(component => component.covered).length;
  const uncoveredComponents = audit.components.filter(component => !component.covered);
  const highPriorityComponents = audit.components.filter(
    component => component.priority === 'high'
  );
  const uncoveredHighPriorityComponents = highPriorityComponents.filter(
    component => !component.covered
  );
  const coveragePercent =
    totalComponents === 0 ? 0 : Math.round((coveredComponents / totalComponents) * 1000) / 10;
  const highPriorityCoveragePercent =
    highPriorityComponents.length === 0
      ? 0
      : Math.round(
          ((highPriorityComponents.length - uncoveredHighPriorityComponents.length) /
            highPriorityComponents.length) *
            1000
        ) / 10;

  return {
    generatedAt: new Date().toISOString(),
    roots: {
      components: [
        'apps/web/src/components',
        'apps/web/src/app/**/components',
        'apps/web/src/app/**/_components',
      ],
      stories: 'apps/storybook/stories',
    },
    summary: {
      totalComponents,
      coveredComponents,
      uncoveredComponents: uncoveredComponents.length,
      coveragePercent,
      totalStories: audit.stories.length,
      highPriorityComponents: highPriorityComponents.length,
      uncoveredHighPriorityComponents: uncoveredHighPriorityComponents.length,
      highPriorityCoveragePercent,
    },
    uncoveredHighPriorityComponents,
    uncoveredComponents,
    components: audit.components,
    stories: audit.stories,
  };
}

function formatComponentLine(component) {
  return `${component.name} (${component.file}:${component.line}) [${component.priority}]`;
}

function formatTextReport(report) {
  const lines = [];
  lines.push('Component Inventory + Storybook Coverage Audit');
  lines.push('');
  lines.push(`Components inventoried: ${report.summary.totalComponents}`);
  lines.push(`Story files scanned: ${report.summary.totalStories}`);
  lines.push(
    `Covered components: ${report.summary.coveredComponents} (${report.summary.coveragePercent}%)`
  );
  lines.push(`Uncovered components: ${report.summary.uncoveredComponents}`);
  lines.push(
    `High-priority coverage: ${
      report.summary.highPriorityComponents - report.summary.uncoveredHighPriorityComponents
    }/${report.summary.highPriorityComponents} (${report.summary.highPriorityCoveragePercent}%)`
  );
  lines.push('');
  lines.push('Uncovered high-priority components:');

  if (report.uncoveredHighPriorityComponents.length === 0) {
    lines.push('  None');
  } else {
    for (const component of report.uncoveredHighPriorityComponents.slice(0, 50)) {
      lines.push(`  - ${formatComponentLine(component)}`);
    }
    if (report.uncoveredHighPriorityComponents.length > 50) {
      lines.push(`  ... ${report.uncoveredHighPriorityComponents.length - 50} more`);
    }
  }

  lines.push('');
  lines.push('Top uncovered components by priority:');
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  const topUncovered = [...report.uncoveredComponents]
    .sort(
      (a, b) =>
        priorityOrder[a.priority] - priorityOrder[b.priority] || a.file.localeCompare(b.file)
    )
    .slice(0, 25);

  if (topUncovered.length === 0) {
    lines.push('  None');
  } else {
    for (const component of topUncovered) {
      lines.push(`  - ${formatComponentLine(component)}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

async function writeOutput(outputPath, content) {
  const resolvedOutputPath = resolve(repoRoot, outputPath);
  await mkdir(dirname(resolvedOutputPath), { recursive: true });
  await writeFile(resolvedOutputPath, content);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const components = await inventoryComponents();
  const stories = await collectStories();
  const audit = applyCoverage(components, stories);
  const report = createReport(audit);
  const output = options.json ? `${JSON.stringify(report, null, 2)}\n` : formatTextReport(report);

  if (options.output) {
    await writeOutput(options.output, output);
  }

  process.stdout.write(output);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
