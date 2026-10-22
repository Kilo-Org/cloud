import type { ZodType } from 'zod';
import { agentCreateInputSchema } from '../contracts/agents';
import { kiloCommandCreateInputSchema } from '../contracts/kilo-commands';
import { skillCustomInputSchema } from '../contracts/skills';
import { instructionImportSchema } from './instructions';
import {
  RuntimeAgentContractSchema,
  RuntimeKiloCommandContractSchema,
  RuntimeSkillContractSchema,
} from './runtime-contract';
import type {
  ImportCategory,
  ImportedAgent,
  ImportedInstruction,
  ImportedKiloCommand,
  ImportedSkill,
  ImportIssue,
  ImportIssueCode,
} from './types';

export type Sourced<T> = {
  item: T;
  source: string;
};

type PathClaim = {
  category: ImportCategory;
  name: string;
};

/** Registry of definitions accepted by both contracts, plus every issue raised so far. */
export type ParseState = {
  issues: ImportIssue[];
  agents: Map<string, Sourced<ImportedAgent>>;
  commands: Map<string, Sourced<ImportedKiloCommand>>;
  skills: Map<string, Sourced<ImportedSkill>>;
  instructions: Map<string, Sourced<ImportedInstruction>>;
  /** First source of every identity seen, valid or not, so repeats are detected. */
  identities: Record<ImportCategory, Map<string, string>>;
  claimedPaths: Map<string, PathClaim>;
};

export function createParseState(): ParseState {
  return {
    issues: [],
    agents: new Map(),
    commands: new Map(),
    skills: new Map(),
    instructions: new Map(),
    identities: {
      agents: new Map(),
      commands: new Map(),
      skills: new Map(),
      instructions: new Map(),
    },
    claimedPaths: new Map(),
  };
}

export function makeIssue(
  severity: ImportIssue['severity'],
  code: ImportIssueCode,
  category: ImportIssue['category'],
  path: string | null,
  field: string | null,
  message: string
): ImportIssue {
  return { severity, code, category, path, field, message };
}

function contractIssueCode(category: ImportCategory, field: string | null): ImportIssueCode {
  switch (category) {
    case 'agents':
      if (field === 'slug') return 'agent-slug-invalid';
      if (field === 'name') return 'agent-name-invalid';
      return 'agent-config-invalid';
    case 'commands':
      if (field === 'name') return 'command-name-invalid';
      if (field === 'template') return 'command-template-invalid';
      return 'command-field-invalid';
    case 'skills':
      if (field === 'name') return 'skill-name-invalid';
      if (field === 'rawMarkdown') return 'skill-markdown-invalid';
      if (field === 'files') return 'skill-files-invalid';
      return 'skill-name-invalid';
    case 'instructions':
      return 'instruction-invalid';
  }
}

/**
 * Validate a mapped item against the profile storage contract and the runtime
 * session contract, reporting the first failure per field. The item is only
 * accepted when both contracts accept it; the storage schema's parsed output is
 * returned so the stored shape matches the storage contract exactly.
 */
function validateItem<T>(
  state: ParseState,
  category: ImportCategory,
  source: string,
  value: unknown,
  profileSchema: ZodType<T>,
  runtimeSchema: ZodType
): T | null {
  const profileResult = profileSchema.safeParse(value);
  const runtimeResult = runtimeSchema.safeParse(value);
  if (profileResult.success && runtimeResult.success) return profileResult.data;

  const failedFields = new Set<string>();
  for (const [label, error] of [
    ['profile', profileResult.success ? null : profileResult.error],
    ['runtime', runtimeResult.success ? null : runtimeResult.error],
  ] as const) {
    if (!error) continue;
    for (const zodIssue of error.issues) {
      const field = zodIssue.path.length > 0 ? zodIssue.path.map(String).join('.') : null;
      const key = field ?? '<root>';
      if (failedFields.has(key)) continue;
      failedFields.add(key);
      state.issues.push(
        makeIssue(
          'error',
          contractIssueCode(category, field),
          category,
          source,
          field,
          `${label} contract: ${zodIssue.message}`
        )
      );
    }
  }
  return null;
}

/**
 * Register one definition of `name`. A repeated identity is ambiguous, so every
 * definition of it is excluded, including one that was already accepted;
 * importing the first source would silently pick a winner.
 */
export function registerIdentity(
  state: ParseState,
  category: ImportCategory,
  name: string,
  source: string
): boolean {
  const firstSource = state.identities[category].get(name);
  if (firstSource === undefined) {
    state.identities[category].set(name, source);
    return true;
  }
  state[category].delete(name);
  state.issues.push(
    makeIssue(
      'error',
      'duplicate-definition',
      category,
      source,
      null,
      `Duplicate ${category.slice(0, -1)} "${name}" from ${firstSource} and ${source}; neither is imported`
    )
  );
  return false;
}

/**
 * Claim an archive path for a definition category. Re-claiming the same path
 * for the same category and name is idempotent (an instruction directory file
 * also matched by a `kilo.json` glob); claiming it for another definition is
 * ambiguous and rejected.
 */
export function claimPath(
  state: ParseState,
  path: string,
  category: ImportCategory,
  name: string
): boolean {
  const existing = state.claimedPaths.get(path);
  if (!existing) {
    state.claimedPaths.set(path, { category, name });
    return true;
  }
  if (existing.category === category && existing.name === name) return false;
  state.issues.push(
    makeIssue(
      'error',
      'duplicate-definition',
      category,
      path,
      null,
      `${path} is claimed by both ${existing.category} "${existing.name}" and ${category} "${name}"`
    )
  );
  return false;
}

/** Copy the fields the import maps; local-only fields are not part of the import. */
export function pickFields(
  fields: Record<string, unknown>,
  allowed: Set<string>
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (allowed.has(key)) picked[key] = value;
  }
  return picked;
}

export function addAgent(
  state: ParseState,
  slug: string,
  name: string,
  config: Record<string, unknown>,
  source: string
): void {
  if (!registerIdentity(state, 'agents', slug, source)) return;
  const item = validateItem(
    state,
    'agents',
    source,
    { slug, name, config },
    agentCreateInputSchema,
    RuntimeAgentContractSchema
  );
  if (!item) return;
  state.agents.set(slug, { item, source });
}

export function addCommand(
  state: ParseState,
  name: string,
  fields: Record<string, unknown>,
  source: string
): void {
  if (!registerIdentity(state, 'commands', name, source)) return;
  const candidate: Record<string, unknown> = { name };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) candidate[key] = value;
  }
  if (candidate.template === undefined) candidate.template = '';
  const item = validateItem(
    state,
    'commands',
    source,
    candidate,
    kiloCommandCreateInputSchema,
    RuntimeKiloCommandContractSchema
  );
  if (!item) return;
  state.commands.set(name, { item, source });
}

export function addSkill(
  state: ParseState,
  name: string,
  description: string | undefined,
  rawMarkdown: string,
  files: Record<string, string>,
  source: string
): void {
  if (!registerIdentity(state, 'skills', name, source)) return;
  const parsed = validateItem(
    state,
    'skills',
    source,
    { name, description, rawMarkdown, files },
    skillCustomInputSchema,
    RuntimeSkillContractSchema
  );
  if (!parsed) return;
  const item: ImportedSkill = {
    name: parsed.name,
    description: parsed.description,
    rawMarkdown: parsed.rawMarkdown,
    files: parsed.files ?? {},
  };
  state.skills.set(name, { item, source });
}

export function addInstruction(
  state: ParseState,
  name: string,
  content: string,
  source: string
): void {
  if (!registerIdentity(state, 'instructions', name, source)) return;
  const result = instructionImportSchema.safeParse({ name, content });
  if (!result.success) {
    const seenFields = new Set<string>();
    for (const zodIssue of result.error.issues) {
      const field = zodIssue.path.length > 0 ? zodIssue.path.map(String).join('.') : null;
      const key = field ?? '<root>';
      if (seenFields.has(key)) continue;
      seenFields.add(key);
      state.issues.push(
        makeIssue(
          'error',
          'instruction-invalid',
          'instructions',
          source,
          field,
          `Instruction is not importable: ${zodIssue.message}`
        )
      );
    }
    return;
  }
  state.instructions.set(name, { item: result.data, source });
}
