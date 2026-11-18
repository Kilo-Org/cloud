export function parseDevStatus(input: string): unknown;

export function resolveE2ePorts(
  payload: unknown,
  env?: Record<string, string | undefined>
): Record<string, string>;

export function formatE2ePortExports(vars: Record<string, string>): string;
