import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PRIVATE_FILE_MODE = 0o600;
const OUTPUT_DIRECTORY_MODE = 0o700;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

type KeypairConfig = {
  outputDir: string;
  publicEnvName: string;
  privateEnvName: string;
};

function printUsage(): void {
  console.log(`Usage:
  pnpm exec tsx dev/generate-rsa-env-keypair.ts -- --out-dir <secure-output-dir> --public-env <PUBLIC_KEY_ENV> --private-env <PRIVATE_KEY_ENV>

Generates a dedicated 4096-bit RSA keypair for one encryption domain.
Writes PKCS#8 private and SPKI public PEM files plus base64-encoded env assignments.
The output directory must be outside the repository and must not already exist.`);
}

function requireOptionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${option}`);
  }
  return value;
}

function validateEnvName(value: string, option: string): string {
  if (!ENV_NAME_PATTERN.test(value)) {
    throw new Error(`${option} must be an uppercase environment variable name`);
  }
  return value;
}

function parseArgs(args: string[]): KeypairConfig | null {
  let outputDir: string | undefined;
  let publicEnvName: string | undefined;
  let privateEnvName: string | undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    switch (arg) {
      case '--':
        break;
      case '--out-dir':
        outputDir = requireOptionValue(args, index, arg);
        index++;
        break;
      case '--public-env':
        publicEnvName = validateEnvName(requireOptionValue(args, index, arg), arg);
        index++;
        break;
      case '--private-env':
        privateEnvName = validateEnvName(requireOptionValue(args, index, arg), arg);
        index++;
        break;
      case '--help':
      case '-h':
        printUsage();
        return null;
      default:
        throw new Error(`Unknown argument: ${arg ?? ''}`);
    }
  }

  if (!outputDir || !publicEnvName || !privateEnvName) {
    throw new Error('Required options: --out-dir, --public-env, and --private-env');
  }
  if (publicEnvName === privateEnvName) {
    throw new Error('--public-env and --private-env must be different');
  }

  return { outputDir: path.resolve(outputDir), publicEnvName, privateEnvName };
}

function writeRestrictedFile(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: PRIVATE_FILE_MODE, flag: 'wx' });
}

function isPathWithin(parentDir: string, candidatePath: string): boolean {
  const relativePath = path.relative(parentDir, candidatePath);
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== '..' &&
      !path.isAbsolute(relativePath))
  );
}

function generateEnvKeypair(config: KeypairConfig): void {
  if (fs.existsSync(config.outputDir)) {
    throw new Error(`Output directory already exists: ${config.outputDir}`);
  }
  const parentDir = path.dirname(config.outputDir);
  if (!fs.existsSync(parentDir) || !fs.statSync(parentDir).isDirectory()) {
    throw new Error(`Output directory parent does not exist: ${parentDir}`);
  }
  const realOutputDir = path.join(fs.realpathSync(parentDir), path.basename(config.outputDir));
  if (isPathWithin(fs.realpathSync(REPO_ROOT), realOutputDir)) {
    throw new Error('Output directory must be outside the repository');
  }

  process.umask(0o077);
  fs.mkdirSync(config.outputDir, { mode: OUTPUT_DIRECTORY_MODE });

  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 4096,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const publicAssignment = `${config.publicEnvName}=${Buffer.from(publicKey).toString('base64')}`;
  const privateAssignment = `${config.privateEnvName}=${Buffer.from(privateKey).toString('base64')}`;

  writeRestrictedFile(path.join(config.outputDir, 'public.pem'), publicKey);
  writeRestrictedFile(path.join(config.outputDir, 'private.pem'), privateKey);
  writeRestrictedFile(path.join(config.outputDir, 'public.env'), `${publicAssignment}\n`);
  writeRestrictedFile(path.join(config.outputDir, 'private.env'), `${privateAssignment}\n`);

  console.log(`Generated dedicated RSA env keypair in ${config.outputDir}`);
  console.log(`Public env assignment: ${publicAssignment}`);
  console.log(`Private env assignment written to: ${path.join(config.outputDir, 'private.env')}`);
  console.log(
    'Keep private.pem and private.env in an approved secrets manager; never commit them.'
  );
}

function main(): void {
  const config = parseArgs(process.argv.slice(2));
  if (config) {
    generateEnvKeypair(config);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  printUsage();
  process.exit(1);
}
