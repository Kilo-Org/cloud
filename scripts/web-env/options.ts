import { ENVIRONMENTS, type Environment } from './shared.js';

export type Options = {
  name: string;
  dryRun: boolean;
  only?: Environment;
  valueFiles: Partial<Record<Environment, string>>;
};

function usage(): never {
  throw new Error(
    [
      'Usage: pnpm web:env set VARIABLE [--dry-run] [--only ENVIRONMENT]',
      '       [--development-file PATH] [--staging-file PATH] [--production-file PATH]',
      `       ENVIRONMENT: ${ENVIRONMENTS.join(' | ')}`,
    ].join('\n')
  );
}

function environment(value: string | undefined): Environment {
  const match = ENVIRONMENTS.find(candidate => candidate === value);
  if (!match) usage();
  return match;
}

export function parseOptions(args: string[]): Options {
  if (args[0] !== 'set' || !args[1]) usage();
  const name = args[1];
  const valueFiles: Partial<Record<Environment, string>> = {};
  let dryRun = false;
  let only: Environment | undefined;

  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--dry-run') {
      dryRun = true;
      continue;
    }

    if (argument === '--only' || argument?.startsWith('--only=')) {
      if (only) usage();
      const inlineValue = argument.startsWith('--only=')
        ? argument.slice('--only='.length)
        : undefined;
      only = environment(inlineValue ?? args[index + 1]);
      if (inlineValue === undefined) index += 1;
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

  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
    throw new Error('Variable names must contain only uppercase letters, digits, and underscores.');
  }
  if (only && ENVIRONMENTS.some(target => target !== only && valueFiles[target])) {
    throw new Error(`--only ${only} cannot be combined with value files for other environments.`);
  }
  return { name, dryRun, only, valueFiles };
}
