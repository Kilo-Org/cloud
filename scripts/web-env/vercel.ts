import type { CommandExecutor, CommandResult } from './command.js';
import { requireSuccess } from './command.js';
import { isRecord, parseJsonObject, readRecords, readString } from './json.js';
import {
  VERCEL_VERSION,
  WEB_ENV_PROJECTS,
  type VariableMetadata,
  type VercelVariableType,
  type WebEnvironment,
  type WebEnvProject,
} from './plan.js';

const VERCEL_SCOPE = 'kilocode';
const VERCEL_TYPES = new Set<VercelVariableType>(['plain', 'encrypted', 'sensitive', 'system']);

function parseVariableType(value: unknown): VercelVariableType | undefined {
  if (typeof value !== 'string') return undefined;
  if (value === 'plain' || value === 'encrypted' || value === 'sensitive' || value === 'system') {
    return value;
  }
  return undefined;
}

export type ResolvedVercelProject = {
  name: WebEnvProject;
  id: string;
};

export class VercelAdapter {
  readonly #execute: CommandExecutor;
  readonly #tempRoot: string;
  readonly #projectIds = new Map<WebEnvProject, string>();
  readonly #stagingEnvironmentIds = new Map<WebEnvProject, string>();
  #orgId = '';

  constructor(execute: CommandExecutor, tempRoot: string) {
    this.#execute = execute;
    this.#tempRoot = tempRoot;
  }

  async #run(args: string[], project?: WebEnvProject, stdin?: string): Promise<CommandResult> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AI_AGENT: 'kilo-web-env-adapter',
    };
    if (project) {
      env.VERCEL_ORG_ID = this.#orgId;
      env.VERCEL_PROJECT_ID = this.#getProjectId(project);
    }
    return this.#execute({
      command: 'pnpm',
      args: [
        'exec',
        'vercel',
        ...args,
        '--scope',
        VERCEL_SCOPE,
        '--cwd',
        this.#tempRoot,
        '--non-interactive',
        '--no-color',
      ],
      cwd: this.#tempRoot,
      env,
      stdin,
      timeoutMs: 120_000,
    });
  }

  #getProjectId(project: WebEnvProject): string {
    const id = this.#projectIds.get(project);
    if (!id) throw new Error(`Vercel project ${project} has not been resolved.`);
    return id;
  }

  #getEnvironmentTarget(project: WebEnvProject, environment: WebEnvironment): string {
    if (environment !== 'staging') return environment;
    const id = this.#stagingEnvironmentIds.get(project);
    if (!id) throw new Error(`Vercel staging environment for ${project} has not been resolved.`);
    return id;
  }

  async initialize(requireNonSensitivePolicy = false): Promise<ResolvedVercelProject[]> {
    const versionResult = await this.#run(['--version']);
    const version = requireSuccess(versionResult, 'Vercel CLI version check');
    if (!version.includes(VERCEL_VERSION)) {
      throw new Error(`Expected Vercel CLI ${VERCEL_VERSION}. Run pnpm install.`);
    }

    const whoamiResult = await this.#run(['whoami', '--format=json']);
    const whoami = parseJsonObject(
      requireSuccess(whoamiResult, 'Vercel authentication check'),
      'Vercel authentication check'
    );
    const team = whoami.team;
    if (!isRecord(team) || readString(team, 'slug') !== VERCEL_SCOPE) {
      throw new Error(`Vercel CLI is not authenticated to the ${VERCEL_SCOPE} scope.`);
    }
    const orgId = readString(team, 'id');
    if (!orgId) throw new Error('Vercel authentication response did not include a team ID.');
    this.#orgId = orgId;

    const resolved: ResolvedVercelProject[] = [];
    for (const project of WEB_ENV_PROJECTS) {
      const listResult = await this.#run(['project', 'list', '--filter', project, '--format=json']);
      const response = parseJsonObject(
        requireSuccess(listResult, `Resolve Vercel project ${project}`),
        `Resolve Vercel project ${project}`
      );
      const exactMatches = readRecords(response, 'projects').filter(
        candidate => readString(candidate, 'name') === project
      );
      if (exactMatches.length !== 1) {
        throw new Error(`Expected exactly one Vercel project named ${project}.`);
      }
      const id = readString(exactMatches[0] ?? {}, 'id');
      if (!id) throw new Error(`Vercel project ${project} did not include an ID.`);
      this.#projectIds.set(project, id);
      resolved.push({ name: project, id });
    }

    for (const project of WEB_ENV_PROJECTS) {
      const targetsResult = await this.#run(['target', 'list', '--format=json'], project);
      const targets = parseJsonObject(
        requireSuccess(targetsResult, `List Vercel targets for ${project}`),
        `List Vercel targets for ${project}`
      );
      const stagingTargets = readRecords(targets, 'targets').filter(
        target => readString(target, 'slug') === 'staging'
      );
      if (stagingTargets.length !== 1) {
        throw new Error(`Vercel project ${project} must have one custom staging environment.`);
      }
      const stagingId = readString(stagingTargets[0] ?? {}, 'id');
      if (!stagingId) throw new Error(`Vercel staging environment for ${project} has no ID.`);
      this.#stagingEnvironmentIds.set(project, stagingId);
    }

    if (requireNonSensitivePolicy) {
      const policyResult = await this.#run(['api', `/teams/${this.#orgId}`, '--raw']);
      const policy = parseJsonObject(
        requireSuccess(policyResult, 'Vercel sensitive-variable policy check'),
        'Vercel sensitive-variable policy check'
      );
      if (readString(policy, 'sensitiveEnvironmentVariablePolicy') === 'on') {
        throw new Error(
          'The Vercel team policy forces sensitive deployed variables, so --no-sensitive cannot be honored.'
        );
      }
    }

    return resolved;
  }

  async listVariables(
    project: WebEnvProject,
    environment: WebEnvironment
  ): Promise<VariableMetadata[]> {
    const target = this.#getEnvironmentTarget(project, environment);
    const result = await this.#run(['env', 'list', target, '--format=json'], project);
    const response = parseJsonObject(
      requireSuccess(result, `List ${project}/${environment} variables`),
      `List ${project}/${environment} variables`
    );
    const variables: VariableMetadata[] = [];
    for (const candidate of readRecords(response, 'envs')) {
      const key = readString(candidate, 'key');
      const type = parseVariableType(candidate.type);
      if (key && type && VERCEL_TYPES.has(type)) variables.push({ key, type });
    }
    return variables;
  }

  async getVariable(
    project: WebEnvProject,
    environment: WebEnvironment,
    key: string
  ): Promise<VariableMetadata | undefined> {
    const matches = (await this.listVariables(project, environment)).filter(
      variable => variable.key === key
    );
    if (matches.length > 1) {
      throw new Error(`Multiple ${key} definitions exist in ${project}/${environment}.`);
    }
    return matches[0];
  }

  async writeVariable(options: {
    mode: 'add' | 'update' | 'resume';
    project: WebEnvProject;
    environment: WebEnvironment;
    key: string;
    value: string;
    sensitive: boolean;
    expectedType: 'encrypted' | 'sensitive';
  }): Promise<void> {
    const target = this.#getEnvironmentTarget(options.project, options.environment);
    const args = ['env', 'add', options.key, target];
    if (options.mode !== 'add') args.push('--force');
    args.push(options.sensitive ? '--sensitive' : '--no-sensitive', '--yes');

    const result = await this.#run(args, options.project, options.value);
    requireSuccess(result, `Write ${options.project}/${options.environment}`);

    const metadata = await this.getVariable(options.project, options.environment, options.key);
    if (metadata?.type !== options.expectedType) {
      throw new Error(
        `Vercel type verification failed for ${options.project}/${options.environment}.`
      );
    }
  }

  async pullReadableValue(
    project: WebEnvProject,
    environment: WebEnvironment,
    key: string
  ): Promise<string | undefined> {
    const target = encodeURIComponent(this.#getEnvironmentTarget(project, environment));
    const projectId = encodeURIComponent(this.#getProjectId(project));
    const endpoint = `/v3/env/pull/${projectId}/${target}?source=vercel-cli%3Aenv%3Apull`;
    const result = await this.#run(['api', endpoint, '--raw'], project);
    const response = parseJsonObject(
      requireSuccess(result, `Pull ${project}/${environment} variables`),
      `Pull ${project}/${environment} variables`
    );
    const environmentValues = response.env;
    if (!isRecord(environmentValues)) {
      throw new Error(`Vercel returned an unexpected ${project}/${environment} response.`);
    }
    const value = environmentValues[key];
    return typeof value === 'string' ? value : undefined;
  }
}
