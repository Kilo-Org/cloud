import type { SeedResult } from '../index';
import {
  deleteFixtureSessions,
  FIXTURE_INSTALLATION_ID,
  FIXTURE_SESSION_ID,
  insertFixtureSession,
  readFixtureIntegration,
} from '../lib/frequent-repository-order-fixture';

export const usage = '<user-id> --state=before|used|cleanup';

const STATES: ReadonlyArray<string> = ['before', 'used', 'cleanup'];

type FixtureState = 'before' | 'used' | 'cleanup';

type FixtureOptions = {
  userId: string;
  state: FixtureState;
};

function isFixtureState(value: string): value is FixtureState {
  return STATES.includes(value);
}

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:frequent-repository-order ${usage}`);
  console.log('');
  console.log('Seeds one deterministic Cloud Agent repository-use row for the frequent');
  console.log('repository ordering E2E. The fixture reads the user-owned GitHub integration');
  console.log(`(installation ${FIXTURE_INSTALLATION_ID}) and records the second provider-order`);
  console.log('repository as one successful Cloud Agent use.');
  console.log('');
  console.log('States:');
  console.log('  before   Delete the fixture row and print the current provider order.');
  console.log('  used     Record the lower provider-order repository as one Cloud Agent use.');
  console.log('  cleanup  Delete only the fixture row.');
  console.log('');
  console.log('Examples:');
  console.log('  pnpm dev:seed app:frequent-repository-order <user-id> --state=before');
  console.log('  pnpm -s dev:seed app:frequent-repository-order <user-id> --state=used --json');
}

function takeFlagValue(args: string[], index: number, flag: string): string {
  const arg = args[index];
  if (arg.length > flag.length && arg[flag.length] === '=') {
    const inline = arg.slice(flag.length + 1).trim();
    if (!inline) {
      throw new Error(`${flag} requires a value`);
    }
    return inline;
  }

  const next = args[index + 1];
  if (next === undefined || next.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return next.trim();
}

function parseArgs(args: string[]): FixtureOptions {
  let userId: string | null = null;
  let state: FixtureState | null = null;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--state' || arg.startsWith('--state=')) {
      const value = takeFlagValue(args, index, '--state');
      if (arg === '--state') index++; // value came from the next argv slot
      if (!isFixtureState(value)) {
        throw new Error(`--state must be one of: ${STATES.join(', ')}`);
      }
      state = value;
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    if (userId !== null) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    userId = arg.trim();
  }

  if (!userId) {
    printUsage();
    throw new Error('user-id is required');
  }
  if (!state) {
    printUsage();
    throw new Error('--state is required');
  }

  return { userId, state };
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const { userId, state } = parseArgs(args);

  if (state === 'cleanup') {
    await deleteFixtureSessions(userId);
    const fixture = await readFixtureIntegration(userId);
    console.log('');
    console.log('This fixture represents: the removed frequent-repository-order fixture row.');
    console.log('The GitHub integration and its cached repositories are untouched.');
    return {
      userId: fixture.userId,
      integrationId: fixture.integrationId,
      unusedRepository: fixture.unusedRepository,
      usedRepository: fixture.usedRepository,
      state,
    };
  }

  const fixture = await readFixtureIntegration(userId);
  await deleteFixtureSessions(userId);

  if (state === 'used') {
    await insertFixtureSession(userId, fixture.usedRepository);
    console.log('');
    console.log('This fixture represents: one successful Cloud Agent repository use for');
    console.log(`the lower provider-order repository (${fixture.usedRepository}).`);
    console.log(`Note: the fixture row is ${FIXTURE_SESSION_ID} for user ${userId}.`);
  } else {
    console.log('');
    console.log('This fixture represents: the current provider repository order before');
    console.log('the E2E records a use.');
    console.log(
      `Note: unusedRepository=${fixture.unusedRepository}, usedRepository=${fixture.usedRepository}.`
    );
  }

  return {
    userId: fixture.userId,
    integrationId: fixture.integrationId,
    unusedRepository: fixture.unusedRepository,
    usedRepository: fixture.usedRepository,
    state,
  };
}
