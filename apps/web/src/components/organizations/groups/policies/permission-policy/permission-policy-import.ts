import {
  OrganizationPermissionPolicySchema,
  type OrganizationPermissionPolicy,
} from '@kilocode/web-shared/lib/organizations/group-policies/permission-policy/permission-policy.schema';
import {
  createScanner,
  findNodeAtLocation,
  getNodeValue,
  parseTree,
  type Node,
  type ParseError,
} from 'jsonc-parser';

type AgentPolicy = Extract<OrganizationPermissionPolicy, { type: 'agent_permissions' }>;
type ToolRule = NonNullable<AgentPolicy['data']['tools']>[string];
type PermissionRule = NonNullable<
  NonNullable<AgentPolicy['data']['shell']>['bash']
>['rules'][number];
type ShellChoice = { kind: 'bash' | 'powershell'; fallback: 'ask' | 'deny' };

type Invalid = { status: 'invalid'; errors: string[] };
type Valid = { status: 'valid'; policy: OrganizationPermissionPolicy; warnings: string[] };
type PermissionPolicyImportResult =
  | Invalid
  | Valid
  | {
      status: 'needs-shell';
      policy: OrganizationPermissionPolicy;
      rules: PermissionRule[];
      warnings: string[];
    };

const MAX_DOCUMENT_BYTES = 128 * 1024;
const MAX_NESTING_DEPTH = 64;
const utf8 = new TextEncoder();

const tokenKind = (text: string) => createScanner(text, true).scan();
const objectStart = tokenKind('{');
const objectEnd = tokenKind('}');
const arrayStart = tokenKind('[');
const arrayEnd = tokenKind(']');
const endOfInput = tokenKind('');

function invalid(message: string): Invalid {
  return { status: 'invalid', errors: [message] };
}

function position(text: string, offset: number): string {
  const lines = text.slice(0, offset).split(/\r\n|[\r\n]/);
  return `line ${lines.length}, column ${(lines.at(-1)?.length ?? 0) + 1}`;
}

function objectEntries(node: Node): [string, Node][] {
  const entries: [string, Node][] = [];
  if (node.type !== 'object') return entries;
  for (const property of node.children ?? []) {
    const [key, value] = property.children ?? [];
    const name: unknown = key?.value;
    if (typeof name === 'string' && value) entries.push([name, value]);
  }
  return entries;
}

function parseDocument(text: string): Invalid | { status: 'parsed'; root: Node } {
  if (text.length > MAX_DOCUMENT_BYTES || utf8.encode(text).length > MAX_DOCUMENT_BYTES) {
    return invalid('The document exceeds the 128 KiB import limit.');
  }

  const scanner = createScanner(text, true);
  const closingTokens = [];
  for (let token = scanner.scan(); token !== endOfInput; token = scanner.scan()) {
    if (token === objectStart || token === arrayStart) {
      closingTokens.push(token === objectStart ? objectEnd : arrayEnd);
      if (closingTokens.length > MAX_NESTING_DEPTH)
        return invalid('The document is nested too deeply.');
    } else if ((token === objectEnd || token === arrayEnd) && closingTokens.pop() !== token) {
      return invalid(`Malformed JSON or JSONC at ${position(text, scanner.getTokenOffset())}.`);
    }
  }

  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true });
  if (errors[0]) return invalid(`Malformed JSON or JSONC at ${position(text, errors[0].offset)}.`);
  if (root?.type !== 'object') return invalid('Expected a JSON object.');

  const pending = [root];
  for (let node = pending.pop(); node; node = pending.pop()) {
    if (node.type === 'object') {
      const names = new Set<string>();
      for (const [name, value] of objectEntries(node)) {
        if (names.has(name)) {
          return invalid(
            `Duplicate property at ${position(text, value.parent?.offset ?? value.offset)}.`
          );
        }
        names.add(name);
        pending.push(value);
      }
    } else if (node.type === 'array') {
      for (const child of node.children ?? []) pending.push(child);
    }
  }

  return { status: 'parsed', root };
}

const policyFields = new Set([
  'type',
  'data',
  'schema_version',
  'unrestricted_mode',
  'tools',
  'shell',
  'bash',
  'powershell',
  'rules',
  'pattern',
  'action',
  'fallback',
  'mode',
  'clients',
  'feature',
  'min_version',
]);

function policyPath(path: PropertyKey[]): string {
  return (
    path.reduce<string>((location, part, index) => {
      if (index === 2 && path[0] === 'data' && path[1] === 'tools') return `${location}[tool]`;
      if (typeof part === 'number') return `${location}[${part}]`;
      const field = typeof part === 'string' && policyFields.has(part) ? part : '[field]';
      return location ? `${location}.${field}` : field;
    }, '') || 'Policy'
  );
}

const safeSchemaMessages = new Set([
  'Control characters are not allowed',
  'Duplicate client feature',
  'Expected a SemVer version',
  'Invalid tool key',
  'Policy too large',
  'Too many tool permissions',
  'Use shell profiles for Bash command rules',
  'Version must not contain surrounding whitespace',
]);

function validatePolicy(
  value: unknown,
  policyType: OrganizationPermissionPolicy['type'],
  warnings: string[] = []
): Invalid | Valid {
  const parsed = OrganizationPermissionPolicySchema.safeParse(value);
  if (!parsed.success) {
    const errors = parsed.error.issues.map(issue => {
      const location = policyPath(issue.path);
      if (safeSchemaMessages.has(issue.message)) return `${location}: ${issue.message}.`;
      switch (issue.code) {
        case 'unrecognized_keys':
          return `${location}: Contains unsupported fields.`;
        case 'invalid_type':
          return `${location}: Expected ${issue.expected}.`;
        case 'invalid_union':
          return `${location}: Does not match a supported policy shape.`;
        case 'too_big':
          return `${location}: Must not exceed ${issue.maximum}.`;
        case 'too_small':
          return `${location}: Must be at least ${issue.minimum}.`;
        default:
          return `${location}: Invalid value.`;
      }
    });
    return { status: 'invalid', errors: [...new Set(errors)] };
  }
  if (parsed.data.type !== policyType) return invalid(`Expected a ${policyType} policy document.`);
  return { status: 'valid', policy: parsed.data, warnings };
}

function validateVersionedDocument(root: Node, policyType: OrganizationPermissionPolicy['type']) {
  if (findNodeAtLocation(root, ['data', 'tools', '__proto__'])) {
    return invalid('data.tools: Contains an unsupported tool key.');
  }
  return validatePolicy(getNodeValue(root), policyType);
}

export function parsePermissionPolicyDocument(
  text: string,
  policyType: OrganizationPermissionPolicy['type']
): PermissionPolicyImportResult {
  const document = parseDocument(text);
  if (document.status === 'invalid') return document;
  return validateVersionedDocument(document.root, policyType);
}

function isAction(value: unknown): value is PermissionRule['action'] {
  return value === 'allow' || value === 'ask' || value === 'deny';
}

export function reviewPermissionPolicyImport(
  text: string,
  policyType: OrganizationPermissionPolicy['type'],
  shell?: ShellChoice
): PermissionPolicyImportResult {
  const document = parseDocument(text);
  if (document.status === 'invalid') return document;
  const { root } = document;
  const config = new Map(objectEntries(root));
  if (config.has('type') || config.has('data') || config.has('schema_version')) {
    return validateVersionedDocument(root, policyType);
  }
  if (policyType === 'client_access') {
    return invalid('Client access can only be imported from a versioned policy document.');
  }

  const permission = config.get('permission');
  if (permission?.type !== 'object') {
    return invalid('Expected a top-level permission object in the Kilo configuration.');
  }
  const tools: [string, ToolRule][] = [];
  let shellRules: PermissionRule[] | undefined;
  let numericRuleOrderChanged = false;
  for (const [key, entry] of objectEntries(permission)) {
    if (/[*?]/.test(key)) {
      return invalid(
        'Tool name wildcards in local permission settings cannot be imported without changing precedence. Use exact tool names or a versioned policy document.'
      );
    }
    if (key === '__proto__') return invalid('permission: Contains an unsupported tool key.');

    const action: unknown = entry.value;
    if (isAction(action)) {
      tools.push([key, action]);
      continue;
    }
    if (entry.type !== 'object') {
      return invalid('Each local tool permission must be an action or an object of ordered rules.');
    }
    const rules: PermissionRule[] = [];
    for (const [pattern, rule] of objectEntries(entry)) {
      const ruleAction: unknown = rule.value;
      if (!isAction(ruleAction)) {
        return invalid('Each local permission rule must use allow, ask, or deny.');
      }
      if (pattern === '~' || pattern.startsWith('~/') || pattern.startsWith('$HOME')) {
        return invalid(
          'Local home-directory patterns cannot be imported. Replace them with portable patterns.'
        );
      }
      rules.push({ pattern, action: ruleAction });
    }
    if (rules.some(({ pattern }) => /^(0|[1-9]\d*)$/.test(pattern))) {
      const objectKeys = Object.keys(
        Object.fromEntries(rules.map(rule => [rule.pattern, rule.action]))
      );
      numericRuleOrderChanged ||= objectKeys.some((key, index) => key !== rules[index]?.pattern);
    }
    if (key === 'bash') shellRules = rules;
    else tools.push([key, { rules }]);
  }
  if (!tools.length && !shellRules)
    return invalid('No local permission settings were found to import.');

  const warnings: string[] = [];
  if (config.size > 1) {
    warnings.push(
      'Other configuration fields were ignored. Only top-level permission settings were imported.'
    );
  }
  if (numericRuleOrderChanged) {
    warnings.push(
      'Numeric rule patterns keep their order in the file. Local Kilo may read them in a different order.'
    );
  }
  if (shellRules?.some(({ pattern }) => pattern === '*')) {
    warnings.push(
      'A wildcard stays in the ordered shell rules. It does not set the unmatched-command action.'
    );
  }
  const policy: AgentPolicy = {
    type: 'agent_permissions',
    data: { schema_version: 1, ...(tools.length > 0 && { tools: Object.fromEntries(tools) }) },
  };
  if (!shellRules) return validatePolicy(policy, policyType, warnings);
  if (
    shell &&
    ((shell.kind !== 'bash' && shell.kind !== 'powershell') ||
      (shell.fallback !== 'ask' && shell.fallback !== 'deny'))
  ) {
    return invalid('Choose Bash or PowerShell and an unmatched-command action of ask or deny.');
  }

  // The placeholder validates the complete rule list and size but never becomes part of the preview.
  const { kind, fallback } = shell ?? { kind: 'bash', fallback: 'ask' };
  const resolved = validatePolicy(
    {
      ...policy,
      data: { ...policy.data, shell: { [kind]: { fallback, rules: shellRules } } },
    },
    policyType,
    warnings
  );
  if (shell) return resolved;
  if (resolved.status === 'invalid') {
    return {
      status: 'invalid',
      errors: resolved.errors.map(error =>
        error.replace(/^data\.shell\.bash\b/, 'permission.bash')
      ),
    };
  }
  const base = validatePolicy(policy, policyType, warnings);
  if (base.status === 'invalid') return base;
  return { status: 'needs-shell', policy: base.policy, rules: shellRules, warnings };
}
