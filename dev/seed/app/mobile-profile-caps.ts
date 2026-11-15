import {
  agent_environment_profile_agents,
  agent_environment_profile_commands,
  agent_environment_profile_instructions,
  agent_environment_profile_kilo_commands,
  agent_environment_profile_mcp_servers,
  agent_environment_profile_skills,
  agent_environment_profile_vars,
  agent_environment_profiles,
  kilocode_users,
} from '@kilocode/db/schema';
import { eq, or } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import { isValidEmail } from '../lib/users';

export const usage = '--email <address>';

/**
 * The server caps, mirrored so the fixture cannot drift from the screens it
 * serves: `profile-instructions-service.ts`, `contracts/skills.ts`,
 * `profile-vars-service.ts`, `CommandsSchema` (`max(20)`), `contracts/agents.ts`,
 * `profile-mcp-service.ts` and `contracts/kilo-commands.ts`.
 */
const INSTRUCTION_CAP = 50;
const SKILL_CAP = 50;
const VARIABLE_CAP = 50;
const COMMAND_CAP = 20;
const AGENT_CAP = 20;
const MCP_SERVER_CAP = 20;
const SLASH_COMMAND_CAP = 50;

/** The two states a pair of profiles shows: the list at its cap and one row under. */
const AT_CAP = 'at the cap';
const BELOW_CAP = 'below the cap';

/**
 * Stable profile ids, so a deep link a previous run printed keeps opening the
 * screen after a rerun.
 */
const PROFILE_IDS = {
  instructionsAtCap: '4f1c8d02-7a63-4b95-91de-2c0a5b7e13a4',
  instructionsBelowCap: '5a2d9e13-8b74-4ca6-a2ef-3d1b6c8f24b5',
  skillsAtCap: '6b3ea024-9c85-4db7-b3f0-4e2c7d90356c',
  skillsBelowCap: '7c4fb135-0d96-4ec8-8401-5f3d8ea1467d',
  variablesAtCap: '8d50c246-1ea7-4fd9-a512-604e9fb2578e',
  variablesBelowCap: '9e61d357-2fb8-4aea-b623-715fa0c3689f',
  commandsAtCap: 'a072e468-30c9-4bfb-9734-8260b1d479a0',
  commandsBelowCap: 'b183f579-41da-4c0c-8845-9371c2e58ab1',
  agentsAtCap: 'c294068a-52eb-4d1d-9956-a482d3f69bc2',
  agentsBelowCap: 'd3a5179b-63fc-4e2e-aa67-b593e407acd3',
  mcpAtCap: 'e4b628ac-740d-4f3f-bb78-c6a4f518bde4',
  mcpBelowCap: 'f5c739bd-851e-4a40-9c89-d7b50629cef5',
  slashCommandsAtCap: '06d84ace-962f-4b51-ad9a-e8c61730daf6',
  slashCommandsBelowCap: '17e95bdf-a730-4c62-beab-f9d72841eb07',
} as const;

/**
 * Setup commands from this repository's own root scripts, so every row is a
 * command the dev stack really runs. The first `COMMAND_CAP` entries fill the
 * capped profile.
 */
const SETUP_COMMANDS = [
  'pnpm install --frozen-lockfile',
  'pnpm run dev:env',
  'pnpm run drizzle:verify-bootstrap',
  'pnpm run test:db',
  'pnpm run build',
  'pnpm run typecheck',
  'pnpm run lint',
  'pnpm run format:check',
  'pnpm run dependency-cycle-check',
  'pnpm run validate',
  'pnpm run test:setup-smoke',
  'pnpm run test:scripts',
  'pnpm run test',
  'pnpm run test:dev-local',
  'pnpm run test:e2e',
  'pnpm run test:web-rewrites',
  'pnpm run test:oxlint-plugins',
  'pnpm run test:mobile-artifacts',
  'pnpm run test:mobile-sbom',
  'pnpm run drizzle',
] as const;

type InstructionRow = typeof agent_environment_profile_instructions.$inferInsert;
type SkillRow = typeof agent_environment_profile_skills.$inferInsert;
type VariableRow = typeof agent_environment_profile_vars.$inferInsert;
type CommandRow = typeof agent_environment_profile_commands.$inferInsert;
type AgentRow = typeof agent_environment_profile_agents.$inferInsert;
type McpServerRow = typeof agent_environment_profile_mcp_servers.$inferInsert;
type SlashCommandRow = typeof agent_environment_profile_kilo_commands.$inferInsert;

type Section = {
  /** Result-key stem, e.g. `instructions`. */
  stem: string;
  /** Route segment under `(app)/(tabs)/(3_profile)/profiles/[profileId]/`. */
  segment: string;
  baseName: string;
  baseDescription: string;
  cap: number;
  atCapProfileId: string;
  belowCapProfileId: string;
};

const SECTIONS: readonly Section[] = [
  {
    stem: 'instructions',
    segment: 'instructions',
    baseName: 'Design gate instructions',
    baseDescription: 'Instruction files the design gate opens on the profile Instructions screen',
    cap: INSTRUCTION_CAP,
    atCapProfileId: PROFILE_IDS.instructionsAtCap,
    belowCapProfileId: PROFILE_IDS.instructionsBelowCap,
  },
  {
    stem: 'skills',
    segment: 'skills',
    baseName: 'Design gate skills',
    baseDescription: 'Skills the design gate opens on the profile Skills screen',
    cap: SKILL_CAP,
    atCapProfileId: PROFILE_IDS.skillsAtCap,
    belowCapProfileId: PROFILE_IDS.skillsBelowCap,
  },
  {
    stem: 'variables',
    segment: 'variables',
    baseName: 'Design gate variables',
    baseDescription: 'Variables the design gate opens on the profile Variables screen',
    cap: VARIABLE_CAP,
    atCapProfileId: PROFILE_IDS.variablesAtCap,
    belowCapProfileId: PROFILE_IDS.variablesBelowCap,
  },
  {
    stem: 'commands',
    segment: 'commands',
    baseName: 'Design gate setup commands',
    baseDescription: 'Setup commands the design gate opens on the profile Commands screen',
    cap: COMMAND_CAP,
    atCapProfileId: PROFILE_IDS.commandsAtCap,
    belowCapProfileId: PROFILE_IDS.commandsBelowCap,
  },
  {
    stem: 'agents',
    segment: 'agents',
    baseName: 'Design gate agent list',
    baseDescription: 'Agents the design gate opens on the profile Agents screen',
    cap: AGENT_CAP,
    atCapProfileId: PROFILE_IDS.agentsAtCap,
    belowCapProfileId: PROFILE_IDS.agentsBelowCap,
  },
  {
    stem: 'mcpServers',
    segment: 'mcp',
    baseName: 'Design gate MCP server list',
    baseDescription: 'MCP servers the design gate opens on the profile MCP screen',
    cap: MCP_SERVER_CAP,
    atCapProfileId: PROFILE_IDS.mcpAtCap,
    belowCapProfileId: PROFILE_IDS.mcpBelowCap,
  },
  {
    stem: 'slashCommands',
    segment: 'slash-commands',
    baseName: 'Design gate slash command list',
    baseDescription: 'Slash commands the design gate opens on the profile Slash commands screen',
    cap: SLASH_COMMAND_CAP,
    atCapProfileId: PROFILE_IDS.slashCommandsAtCap,
    belowCapProfileId: PROFILE_IDS.slashCommandsBelowCap,
  },
];

/** Two digits keep the rows in the order the name column sorts them. */
function pad(position: number): string {
  return String(position).padStart(2, '0');
}

function instructionRows(profileId: string, count: number): InstructionRow[] {
  return Array.from({ length: count }, (_, index) => {
    const position = index + 1;
    return {
      profile_id: profileId,
      name: `rule-${pad(position)}`,
      content: [
        `# Rule ${position}`,
        '',
        `- Keep the change inside the task rule ${position} names.`,
        '- Report the checks the change runs.',
        '',
      ].join('\n'),
    };
  });
}

function skillRows(profileId: string, count: number): SkillRow[] {
  return Array.from({ length: count }, (_, index) => {
    const position = index + 1;
    const name = `skill-${pad(position)}`;
    const description = `Skill ${position} the profile lists at its own step.`;
    return {
      profile_id: profileId,
      name,
      description,
      source_type: 'custom',
      source_url: null,
      raw_markdown: [
        '---',
        `name: ${name}`,
        `description: ${description}`,
        '---',
        '',
        `# Skill ${position}`,
        '',
        'Use this skill when the task names its step.',
        '',
      ].join('\n'),
    };
  });
}

function variableRows(profileId: string, count: number): VariableRow[] {
  return Array.from({ length: count }, (_, index) => {
    const position = index + 1;
    return {
      profile_id: profileId,
      key: `VAR_${pad(position)}`,
      value: `example-value-${pad(position)}`,
      is_secret: false,
    };
  });
}

function commandRows(profileId: string, count: number): CommandRow[] {
  return SETUP_COMMANDS.slice(0, count).map((command, index) => ({
    profile_id: profileId,
    sequence: index,
    command,
  }));
}

function agentRows(profileId: string, count: number): AgentRow[] {
  return Array.from({ length: count }, (_, index) => {
    const position = index + 1;
    return {
      profile_id: profileId,
      slug: `agent-${pad(position)}`,
      name: `Agent ${position}`,
      config: {
        mode: 'subagent',
        description: `Agent ${position} the profile lists at its own step.`,
      },
    };
  });
}

function mcpServerRows(profileId: string, count: number): McpServerRow[] {
  return Array.from({ length: count }, (_, index) => {
    const position = index + 1;
    return {
      profile_id: profileId,
      name: `server-${pad(position)}`,
      type: 'remote',
      enabled: true,
      timeout: null,
      config: { url: `https://mcp.example.com/server-${pad(position)}` },
    };
  });
}

function slashCommandRows(profileId: string, count: number): SlashCommandRow[] {
  return Array.from({ length: count }, (_, index) => {
    const position = index + 1;
    return {
      profile_id: profileId,
      name: `command-${pad(position)}`,
      description: `Command ${position} the profile lists at its own step.`,
      template: [
        `Review the change for step ${position}.`,
        '',
        'Read the diff, then report every file it touches.',
        '',
      ].join('\n'),
      subtask: false,
      enabled: true,
      sort_order: index,
    };
  });
}

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:mobile-profile-caps ${usage}`);
  console.log('');
  console.log('Seeds one local account with fourteen personal profiles: for each profile');
  console.log('list, one profile at the server cap and one profile one row under it.');
  console.log('');
  console.log('  instructions     50 and 49');
  console.log('  skills           50 and 49');
  console.log('  variables        50 and 49');
  console.log('  setup commands   20 and 19');
  console.log('  agents           20 and 19');
  console.log('  MCP servers      20 and 19');
  console.log('  slash commands   50 and 49');
  console.log('');
  console.log('The topic resolves the owner from the account email, so sign the app in');
  console.log('first: the device-code sign-in creates the user row the profiles belong to.');
  console.log('Re-running replaces the profiles of that owner and their children.');
  console.log('');
  console.log('It prints one deep link per profile, in the form:');
  console.log('  kiloapp:///(app)/(tabs)/(3_profile)/profiles/<profileId>/<section>');
  console.log('');
  console.log('Example:');
  console.log('  pnpm dev:seed app:mobile-profile-caps --email ada@example.com');
}

type Options = { email: string };

function parseArgs(args: string[]): Options {
  let email: string | null = null;
  const extra: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--email') {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error('--email needs an address');
      }
      email = value.trim();
      index += 1;
      continue;
    }
    if (arg.startsWith('--email=')) {
      email = arg.slice('--email='.length).trim();
      continue;
    }
    extra.push(arg);
  }
  if (extra.length > 1 || (extra.length === 1 && email !== null)) {
    throw new Error(`unexpected argument: ${extra[0]}`);
  }
  const resolved = email ?? extra[0] ?? null;
  if (resolved === null || resolved.length === 0) {
    printUsage();
    throw new Error('an account email is required');
  }
  if (!isValidEmail(resolved)) {
    throw new Error(`email is not a valid address: ${resolved}`);
  }
  return { email: resolved };
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const { email } = parseArgs(args);
  const trimmedEmail = email.trim();
  const normalizedEmail = normalizeSeedEmail(trimmedEmail);
  assertLocalSeedDatabase('app:mobile-profile-caps');
  const db = getSeedDb();

  // The app signs in through the device-code flow, which writes the user row
  // the profile screens read. This topic never creates a user: it seeds the
  // profiles of an account that already signed in.
  const matches = await db
    .select({ id: kilocode_users.id, email: kilocode_users.google_user_email })
    .from(kilocode_users)
    .where(
      or(
        eq(kilocode_users.google_user_email, trimmedEmail),
        eq(kilocode_users.normalized_email, normalizedEmail)
      )
    );
  const exact = matches.filter(match => match.email === trimmedEmail);
  const resolved = exact.length > 0 ? exact : matches;
  if (resolved.length === 0) {
    throw new Error(
      `no local account for ${trimmedEmail}. Sign the app in through device-code sign-in first, then rerun this topic.`
    );
  }
  if (resolved.length > 1) {
    const listed = resolved.map(match => `${match.email} (${match.id})`).join(', ');
    throw new Error(`multiple accounts matched ${trimmedEmail}: ${listed}`);
  }
  const ownerId = resolved[0].id;

  // The owner cascade removes the children of every profile, so only the
  // profiles of this owner are deleted.
  await db
    .delete(agent_environment_profiles)
    .where(eq(agent_environment_profiles.owned_by_user_id, ownerId));

  // Exactly one profile carries the default flag: the partial unique index
  // allows one default per owner, and the list shows that state on a row.
  const defaultProfileId = PROFILE_IDS.instructionsAtCap;
  await db.insert(agent_environment_profiles).values(
    SECTIONS.flatMap(section => [
      {
        id: section.atCapProfileId,
        owned_by_user_id: ownerId,
        created_by_user_id: ownerId,
        name: `${section.baseName} (${AT_CAP})`,
        description: `${section.baseDescription}; this profile is ${AT_CAP}.`,
        is_default: section.atCapProfileId === defaultProfileId,
      },
      {
        id: section.belowCapProfileId,
        owned_by_user_id: ownerId,
        created_by_user_id: ownerId,
        name: `${section.baseName} (${BELOW_CAP})`,
        description: `${section.baseDescription}; this profile is ${BELOW_CAP}.`,
        is_default: false,
      },
    ])
  );

  await db
    .insert(agent_environment_profile_instructions)
    .values(instructionRows(PROFILE_IDS.instructionsAtCap, INSTRUCTION_CAP));
  await db
    .insert(agent_environment_profile_instructions)
    .values(instructionRows(PROFILE_IDS.instructionsBelowCap, INSTRUCTION_CAP - 1));

  await db
    .insert(agent_environment_profile_skills)
    .values(skillRows(PROFILE_IDS.skillsAtCap, SKILL_CAP));
  await db
    .insert(agent_environment_profile_skills)
    .values(skillRows(PROFILE_IDS.skillsBelowCap, SKILL_CAP - 1));

  await db
    .insert(agent_environment_profile_vars)
    .values(variableRows(PROFILE_IDS.variablesAtCap, VARIABLE_CAP));
  await db
    .insert(agent_environment_profile_vars)
    .values(variableRows(PROFILE_IDS.variablesBelowCap, VARIABLE_CAP - 1));

  await db
    .insert(agent_environment_profile_commands)
    .values(commandRows(PROFILE_IDS.commandsAtCap, COMMAND_CAP));
  await db
    .insert(agent_environment_profile_commands)
    .values(commandRows(PROFILE_IDS.commandsBelowCap, COMMAND_CAP - 1));

  await db
    .insert(agent_environment_profile_agents)
    .values(agentRows(PROFILE_IDS.agentsAtCap, AGENT_CAP));
  await db
    .insert(agent_environment_profile_agents)
    .values(agentRows(PROFILE_IDS.agentsBelowCap, AGENT_CAP - 1));

  await db
    .insert(agent_environment_profile_mcp_servers)
    .values(mcpServerRows(PROFILE_IDS.mcpAtCap, MCP_SERVER_CAP));
  await db
    .insert(agent_environment_profile_mcp_servers)
    .values(mcpServerRows(PROFILE_IDS.mcpBelowCap, MCP_SERVER_CAP - 1));

  await db
    .insert(agent_environment_profile_kilo_commands)
    .values(slashCommandRows(PROFILE_IDS.slashCommandsAtCap, SLASH_COMMAND_CAP));
  await db
    .insert(agent_environment_profile_kilo_commands)
    .values(slashCommandRows(PROFILE_IDS.slashCommandsBelowCap, SLASH_COMMAND_CAP - 1));

  console.log(
    'This fixture represents: one owner whose personal profiles sit at, and one row under, every profile list cap.'
  );

  const result: SeedResult = { userId: ownerId, email: trimmedEmail };
  for (const section of SECTIONS) {
    const atCapLink = `kiloapp:///(app)/(tabs)/(3_profile)/profiles/${section.atCapProfileId}/${section.segment}`;
    const belowCapLink = `kiloapp:///(app)/(tabs)/(3_profile)/profiles/${section.belowCapProfileId}/${section.segment}`;
    console.log(`Deep link (${section.stem}, ${AT_CAP}): ${atCapLink}`);
    console.log(`Deep link (${section.stem}, ${BELOW_CAP}): ${belowCapLink}`);
    Object.assign(result, {
      [`${section.stem}AtCapProfileId`]: section.atCapProfileId,
      [`${section.stem}AtCapCount`]: section.cap,
      [`${section.stem}AtCapDeepLink`]: atCapLink,
      [`${section.stem}BelowCapProfileId`]: section.belowCapProfileId,
      [`${section.stem}BelowCapCount`]: section.cap - 1,
      [`${section.stem}BelowCapDeepLink`]: belowCapLink,
    });
  }
  return result;
}
