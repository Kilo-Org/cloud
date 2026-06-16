export const WEB_ENV_PROJECTS = ['kilocode-app', 'kilocode-global-app'] as const;
export const WEB_ENVIRONMENTS = ['development', 'staging', 'production'] as const;
export const WEB_ENV_VAULT = 'Kilo Web ENV Production';
export const VERCEL_VERSION = '53.3.1';

export type WebEnvProject = (typeof WEB_ENV_PROJECTS)[number];
export type WebEnvironment = (typeof WEB_ENVIRONMENTS)[number];
export type WebEnvMode = 'add' | 'update' | 'resume';
export type VercelVariableType = 'plain' | 'encrypted' | 'sensitive' | 'system';

export type VariableMetadata = {
  key: string;
  type: VercelVariableType;
};

export type TargetState = {
  project: WebEnvProject;
  environment: WebEnvironment;
  variable?: VariableMetadata;
};

export type EnvironmentValues = Record<WebEnvironment, string>;

export type VercelWriteOperation = {
  project: WebEnvProject;
  environment: WebEnvironment;
  sensitive: boolean;
  expectedType: 'encrypted' | 'sensitive';
};

const VARIABLE_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export function validateVariableName(name: string, sensitive: boolean): void {
  if (!VARIABLE_NAME_PATTERN.test(name)) {
    throw new Error(
      'Variable names must use uppercase letters, digits, and underscores, and cannot start with a digit.'
    );
  }
  if (sensitive && name.startsWith('NEXT_PUBLIC_')) {
    throw new Error('NEXT_PUBLIC_* variables are client-exposed and must use --no-sensitive.');
  }
}

export function validateTargetPreconditions(mode: 'add' | 'update', states: TargetState[]): void {
  const present = states.filter(state => state.variable !== undefined);
  if (mode === 'add' && present.length > 0) {
    const locations = present
      .map(state => `${state.project}/${state.environment}`)
      .sort()
      .join(', ');
    throw new Error(`Cannot add: the variable already exists in ${locations}. Use update instead.`);
  }

  if (mode === 'update' && present.length !== states.length) {
    const missing = states
      .filter(state => state.variable === undefined)
      .map(state => `${state.project}/${state.environment}`)
      .sort()
      .join(', ');
    throw new Error(`Cannot update: the variable is missing from ${missing}.`);
  }
}

export function buildWriteOperations(sensitive: boolean): VercelWriteOperation[] {
  return WEB_ENVIRONMENTS.flatMap(environment =>
    WEB_ENV_PROJECTS.map(project => {
      const targetIsSensitive = sensitive && environment !== 'development';
      return {
        project,
        environment,
        sensitive: targetIsSensitive,
        expectedType: targetIsSensitive ? 'sensitive' : 'encrypted',
      } satisfies VercelWriteOperation;
    })
  );
}

export function assertNonEmptyValues(values: EnvironmentValues): void {
  for (const environment of WEB_ENVIRONMENTS) {
    if (values[environment].length === 0) {
      throw new Error(`${environment} cannot be empty.`);
    }
  }
}
