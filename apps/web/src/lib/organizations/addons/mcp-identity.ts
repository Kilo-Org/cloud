import type { OrganizationMcpAddonConfig } from '@kilocode/db/schema-types';

export type McpPackageEcosystem = 'npm' | 'pypi';

export type McpTarget =
  | { kind: 'remote'; url: string }
  | { kind: 'package'; ecosystem: McpPackageEcosystem; identifier: string };

export type Normalized<T> = { ok: true; value: T } | { ok: false; reason: string };

const NPM_PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const PYPI_PACKAGE_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const MIN_VERSION = /^[0-9][0-9A-Za-z.+!_~-]{0,63}$/;
const MAX_NPM_NAME_LENGTH = 214;
const MAX_PYPI_NAME_LENGTH = 100;

export function normalizeRemoteMcpUrl(input: string): Normalized<string> {
  const trimmed = input.trim();
  if (trimmed.includes('{') || trimmed.includes('}')) {
    return { ok: false, reason: 'URLs with placeholders can’t be allowlisted yet.' };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'Enter a full URL, such as https://mcp.example.com/mcp.' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'Only https URLs can be allowlisted.' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'URLs can’t contain a username or password.' };
  }
  const path = url.pathname.replace(/\/+$/, '');
  return { ok: true, value: `https://${url.host}${path}` };
}

export function normalizePackageIdentifier(
  ecosystem: McpPackageEcosystem,
  input: string
): Normalized<string> {
  const trimmed = input.trim();
  if (ecosystem === 'npm') {
    if (trimmed.length > MAX_NPM_NAME_LENGTH || !NPM_PACKAGE_NAME.test(trimmed.toLowerCase())) {
      return { ok: false, reason: 'Enter an npm package name, such as @scope/package-name.' };
    }
    return { ok: true, value: trimmed };
  }
  if (trimmed.length > MAX_PYPI_NAME_LENGTH || !PYPI_PACKAGE_NAME.test(trimmed)) {
    return { ok: false, reason: 'Enter a PyPI package name, such as package-name.' };
  }
  return { ok: true, value: trimmed };
}

export function normalizeMinVersion(input: string | null | undefined): Normalized<string | null> {
  const trimmed = input?.trim() ?? '';
  if (trimmed === '') return { ok: true, value: null };
  if (!MIN_VERSION.test(trimmed)) {
    return { ok: false, reason: 'Enter a version such as 1.2.3.' };
  }
  return { ok: true, value: trimmed };
}

export function mcpIdentityKey(target: McpTarget): string {
  if (target.kind === 'remote') return `remote:${target.url}`;
  if (target.ecosystem === 'npm') return `npm:${target.identifier.toLowerCase()}`;
  return `pypi:${target.identifier.toLowerCase().replace(/[-_.]+/g, '-')}`;
}

export function mcpTargetFromConfig(config: OrganizationMcpAddonConfig): McpTarget {
  return config.kind === 'remote'
    ? { kind: 'remote', url: config.url }
    : { kind: 'package', ecosystem: config.ecosystem, identifier: config.identifier };
}

export function mcpConfigFromTarget(
  target: McpTarget,
  minVersion: string | null
): OrganizationMcpAddonConfig {
  return target.kind === 'remote' ? target : { ...target, min_version: minVersion };
}
