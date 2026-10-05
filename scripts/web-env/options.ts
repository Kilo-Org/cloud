import { ENVIRONMENTS, PROJECTS, type Environment, type Project } from './shared.js';

export type SetOptions = {
  command: 'set';
  name: string;
  dryRun: boolean;
  only?: Environment;
  valueFiles: Partial<Record<Environment, string>>;
};

export type CopyOptions = {
  command: 'copy';
  from: Project;
  to: Project;
  dryRun: boolean;
  only?: Environment;
  exclude: string[];
};

export type Options = SetOptions | CopyOptions;

function usage(): never {
  throw new Error(
    [
      'Usage: pnpm web:env set VARIABLE [--dry-run] [--only ENVIRONMENT]',
      '       [--development-file PATH] [--staging-file PATH] [--production-file PATH]',
      '       pnpm web:env copy --from PROJECT --to PROJECT [--dry-run] [--only ENVIRONMENT]',
      '       [--exclude VARIABLE]...',
      `       ENVIRONMENT: ${ENVIRONMENTS.join(' | ')}`,
      `       PROJECT: ${PROJECTS.join(' | ')}`,
    ].join('\n')
  );
}

function environment(value: string | undefined): Environment {
  const match = ENVIRONMENTS.find(candidate => candidate === value);
  if (!match) usage();
  return match;
}

function project(value: string | undefined): Project {
  const match = PROJECTS.find(candidate => candidate === value);
  if (!match) usage();
  return match;
}

function assertVariableName(name: string): void {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
    throw new Error('Variable names must contain only uppercase letters, digits, and underscores.');
  }
}

function flagValue(
  args: string[],
  index: number,
  flag: string
): { value: string | undefined; consumed: number } | undefined {
  const argument = args[index];
  if (argument === flag) return { value: args[index + 1], consumed: 2 };
  if (argument?.startsWith(`${flag}=`)) {
    return { value: argument.slice(flag.length + 1), consumed: 1 };
  }
  return undefined;
}

function parseSetOptions(args: string[]): SetOptions {
  const name = args[1];
  if (!name) usage();
  const valueFiles: Partial<Record<Environment, string>> = {};
  let dryRun = false;
  let only: Environment | undefined;

  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--dry-run') {
      dryRun = true;
      continue;
    }

    const onlyFlag = flagValue(args, index, '--only');
    if (onlyFlag) {
      if (only) usage();
      only = environment(onlyFlag.value);
      index += onlyFlag.consumed - 1;
      continue;
    }

    const match = argument?.match(/^--(development|staging|production)-file(?:=(.*))?$/);
    if (!match) usage();
    const target = environment(match[1]);
    const nextArgument = args[index + 1];
    const file = match[2] || nextArgument;
    if (!file) usage();
    if (!match[2]) index += 1;
    valueFiles[target] = file;
  }

  assertVariableName(name);
  if (only && ENVIRONMENTS.some(target => target !== only && valueFiles[target])) {
    throw new Error(`--only ${only} cannot be combined with value files for other environments.`);
  }
  return { command: 'set', name, dryRun, only, valueFiles };
}

function parseCopyOptions(args: string[]): CopyOptions {
  let from: Project | undefined;
  let to: Project | undefined;
  let dryRun = false;
  let only: Environment | undefined;
  const exclude: string[] = [];

  for (let index = 1; index < args.length; index += 1) {
    if (args[index] === '--dry-run') {
      dryRun = true;
      continue;
    }

    const fromFlag = flagValue(args, index, '--from');
    const toFlag = flagValue(args, index, '--to');
    const onlyFlag = flagValue(args, index, '--only');
    const excludeFlag = flagValue(args, index, '--exclude');
    if (fromFlag) {
      if (from) usage();
      from = project(fromFlag.value);
      index += fromFlag.consumed - 1;
    } else if (toFlag) {
      if (to) usage();
      to = project(toFlag.value);
      index += toFlag.consumed - 1;
    } else if (onlyFlag) {
      if (only) usage();
      only = environment(onlyFlag.value);
      index += onlyFlag.consumed - 1;
    } else if (excludeFlag) {
      if (!excludeFlag.value) usage();
      assertVariableName(excludeFlag.value);
      exclude.push(excludeFlag.value);
      index += excludeFlag.consumed - 1;
    } else {
      usage();
    }
  }

  if (!from || !to) usage();
  if (from === to) throw new Error('--from and --to must be different projects.');
  return { command: 'copy', from, to, dryRun, only, exclude };
}

export function parseOptions(args: string[]): Options {
  if (args[0] === 'set') return parseSetOptions(args);
  if (args[0] === 'copy') return parseCopyOptions(args);
  usage();
}
