// Source-text checks for Sentry SDK initialization in apps/, services/ and
// packages/. The checks read text, not a syntax tree: they find init calls
// through ES imports of the SDK, read the call's argument text, and do not
// follow options built in another file or passed through a variable. Comments
// are blanked before every check and string contents before every check except
// the import source, so a commented-out hook or a quoted name does not count.
// Regular expression literals are read as code.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SCANNED_ROOTS = ['apps', 'services', 'packages'];
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const SDK_IMPORT =
  /import\s+(?!type\s)([^;]*?)\s+from\s+['"](@sentry\/(?:nextjs|node|cloudflare|react-native))['"]/g;
const SEND_DEFAULT_PII_TRUE = /\bsendDefaultPii\s*[:=]\s*true\b/g;
const BEFORE_SEND_KEY = /\bbeforeSend\s*[:(,}]/;
const BEFORE_BREADCRUMB_KEY = /\bbeforeBreadcrumb\s*[:(,}]/;
const BEFORE_SEND_LOG_KEY = /\bbeforeSendLog\s*[:(,}]/;
const CONSOLE_LOGGING_CALL = /\bconsoleLoggingIntegration\s*\(/;
const CONSOLE_LOGGING_IMPORT =
  /import\s[^;]*\bconsoleLoggingIntegration\b[^;]*from\s+['"]@sentry\//;
// The apps and package whose Sentry data goes to kilocode-web. The SDK formats
// console arguments into the log body before beforeSendLog runs, so no hook can
// scrub console logs there.
const WEB_SENTRY_FILE = /^(?:apps\/web|apps\/ai-gateway|packages\/web-shared)\//;
const CONSOLE_LOGGING_MESSAGE =
  'consoleLoggingIntegration must not be used: the SDK formats console arguments into the log body before beforeSendLog runs';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function blank(text) {
  return text.replace(/[^\n]/g, ' ');
}

function literalEnd(text, start) {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === '\\') index += 1;
    else if (text[index] === quote) return index + 1;
    else if (text[index] === '\n' && quote !== '`') return index;
  }
  return text.length;
}

// Two views of the source with the same offsets and lines: `code` blanks
// comments, and `executable` also blanks the contents of string literals.
function sourceViews(text) {
  let code = '';
  let executable = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    let end = index + 1;
    if (char === '"' || char === "'" || char === '`') {
      end = literalEnd(text, index);
      const literal = text.slice(index, end);
      const closed = literal.length > 1 && literal.endsWith(char);
      code += literal;
      executable += closed
        ? `${char}${blank(literal.slice(1, -1))}${char}`
        : `${char}${blank(literal.slice(1))}`;
    } else if (text.startsWith('//', index) || text.startsWith('/*', index)) {
      const close = text.startsWith('//', index)
        ? text.indexOf('\n', index)
        : text.indexOf('*/', index + 2);
      end = close === -1 ? text.length : text.startsWith('//', index) ? close : close + 2;
      code += blank(text.slice(index, end));
      executable += blank(text.slice(index, end));
    } else {
      code += char;
      executable += char;
    }
    index = end;
  }
  return { code, executable };
}

function initCallees(clause) {
  const callees = [];
  const namespace = /\*\s*as\s+([\w$]+)/.exec(clause);
  if (namespace) callees.push(`${escapeRegExp(namespace[1])}\\s*\\.\\s*init`);
  const named = /\{([^}]*)\}/.exec(clause);
  for (const specifier of named ? named[1].split(',') : []) {
    const match = /^\s*init(?:\s+as\s+([\w$]+))?\s*$/.exec(specifier);
    if (match) callees.push(escapeRegExp(match[1] ?? 'init'));
  }
  return callees;
}

function argumentText(text, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    if (text[index] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex + 1, index);
    }
  }
  return text.slice(openIndex + 1);
}

function initCalls({ code, executable }) {
  const calls = [];
  for (const [, clause, sdk] of code.matchAll(SDK_IMPORT)) {
    for (const callee of initCallees(clause)) {
      for (const match of executable.matchAll(new RegExp(`(?<![\\w$.])${callee}\\s*\\(`, 'g'))) {
        const openIndex = match.index + match[0].length - 1;
        calls.push({
          sdk,
          index: match.index,
          options: argumentText(executable, openIndex).trim(),
        });
      }
    }
  }
  return calls.sort((a, b) => a.index - b.index);
}

export function findSentryInitCalls(text) {
  return initCalls(sourceViews(text));
}

// A spread at the top level of the options object can replace any key written
// before or after it, so it is rejected; spreads inside a hook body are not.
// The options come from the executable view, so comments and strings are blank.
function hasTopLevelSpread(options) {
  let depth = 0;
  for (let index = 0; index < options.length; index += 1) {
    const char = options[index];
    if ('({['.includes(char)) depth += 1;
    else if (')}]'.includes(char)) depth -= 1;
    else if (depth === 1 && options.startsWith('...', index)) return true;
  }
  return false;
}

function nextjsInitViolations(options) {
  if (!options.startsWith('{')) {
    return [
      'pass the options as an inline object so beforeSend and beforeBreadcrumb can be checked',
    ];
  }
  const violations = [];
  if (!BEFORE_SEND_KEY.test(options) || !options.includes('scrubSentryEvent')) {
    violations.push('beforeSend must call scrubSentryEvent');
  }
  if (!BEFORE_BREADCRUMB_KEY.test(options) || !options.includes('scrubSentryBreadcrumb')) {
    violations.push('beforeBreadcrumb must call scrubSentryBreadcrumb');
  }
  if (hasTopLevelSpread(options)) {
    violations.push('init options must not spread another object: it can replace the scrub hooks');
  }
  return violations;
}

function importsNextjs(code) {
  return [...code.matchAll(SDK_IMPORT)].some(([, , sdk]) => sdk === '@sentry/nextjs');
}

function consoleLoggingUse({ code, executable }) {
  const uses = [CONSOLE_LOGGING_CALL.exec(executable), CONSOLE_LOGGING_IMPORT.exec(code)];
  return uses.filter(use => use !== null).sort((a, b) => a.index - b.index)[0];
}

export function checkSentrySource(file, text) {
  const views = sourceViews(text);
  const violations = [];
  for (const match of views.executable.matchAll(SEND_DEFAULT_PII_TRUE)) {
    violations.push({
      line: lineOf(text, match.index),
      message: 'sendDefaultPii must not be true',
    });
  }
  const consoleLogging = consoleLoggingUse(views);
  const webConsoleLogging =
    consoleLogging !== undefined && (WEB_SENTRY_FILE.test(file) || importsNextjs(views.code));
  if (webConsoleLogging) {
    violations.push({ line: lineOf(text, consoleLogging.index), message: CONSOLE_LOGGING_MESSAGE });
  }
  for (const call of initCalls(views)) {
    const line = lineOf(text, call.index);
    if (call.sdk === '@sentry/nextjs') {
      for (const message of nextjsInitViolations(call.options)) {
        violations.push({ line, message });
      }
    } else if (consoleLogging && !webConsoleLogging && !BEFORE_SEND_LOG_KEY.test(call.options)) {
      violations.push({ line, message: 'consoleLoggingIntegration requires beforeSendLog' });
    }
  }
  return violations
    .sort((a, b) => a.line - b.line)
    .map(({ line, message }) => `${file}:${line}: ${message}`);
}

export function listSourceFiles(root) {
  const output = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...SCANNED_ROOTS],
    { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  );
  return [...new Set(output.split('\0'))].filter(
    file => SOURCE_FILE.test(file) && !TEST_FILE.test(file)
  );
}

export function checkRepository(root) {
  const violations = [];
  const initSites = [];
  for (const file of listSourceFiles(root)) {
    let text;
    try {
      text = readFileSync(path.join(root, file), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!text.includes('@sentry/') && !text.includes('sendDefaultPii')) continue;
    violations.push(...checkSentrySource(file, text));
    for (const call of findSentryInitCalls(text)) initSites.push(`${file}:${call.sdk}`);
  }
  return { violations, initSites };
}
