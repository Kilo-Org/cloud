import 'server-only';

import { z } from 'zod';

const VERCEL_API_URL = 'https://api.vercel.com';
const OPERATION_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const MAX_RESULTS = 1_000;

const ERROR_MESSAGES = {
  UNAUTHORIZED: 'The Vercel token is invalid or expired.',
  FORBIDDEN: 'The Vercel token cannot access the selected team or project.',
  NOT_FOUND: 'The selected Vercel team or project was not found.',
  TOO_MANY_REQUESTS: 'Vercel is rate limiting requests. Try again later.',
  SERVICE_UNAVAILABLE: 'Vercel is temporarily unavailable. Try again later.',
  BAD_GATEWAY: 'Vercel returned an invalid response.',
  BAD_REQUEST: 'Vercel returned too many teams or projects to discover safely.',
} as const;

export class VercelApiError extends Error {
  constructor(readonly code: keyof typeof ERROR_MESSAGES) {
    super(ERROR_MESSAGES[code]);
    this.name = 'VercelApiError';
  }
}

export type VercelTeam = {
  id: string;
  slug: string;
  name: string;
};

export type VercelProject = {
  id: string;
  name: string;
  slug: string;
  teamId: string;
};

const TeamSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().nullable(),
  limited: z.boolean().optional(),
});

const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  accountId: z.string().min(1),
});

const TimestampSchema = z.number().int().nonnegative();
const PaginationSchema = z.object({
  count: z.number().int().nonnegative(),
  next: TimestampSchema.nullable(),
  prev: TimestampSchema.nullable(),
});

const TeamsPageSchema = z
  .object({
    teams: z.array(TeamSchema),
    pagination: PaginationSchema,
  })
  .transform(({ teams, pagination }) => ({ items: teams, pagination }));

const ProjectsPageSchema = z
  .object({
    projects: z.array(ProjectSchema),
    pagination: z.union([
      PaginationSchema,
      PaginationSchema.extend({
        next: z.string().min(1).nullable(),
        prev: TimestampSchema.nullable().optional(),
      }),
    ]),
  })
  .transform(({ projects, pagination }) => ({ items: projects, pagination }));

type VercelPage<T> = {
  items: T[];
  pagination: { count: number; next: number | string | null };
};

async function requestVercel<T>(
  token: string,
  url: URL,
  schema: z.ZodType<T>,
  signal: AbortSignal
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      cache: 'no-store',
      redirect: 'error',
      signal,
    });
  } catch {
    throw new VercelApiError('SERVICE_UNAVAILABLE');
  }

  if (response.redirected) throw new VercelApiError('BAD_GATEWAY');
  if (!response.ok) {
    switch (response.status) {
      case 401:
        throw new VercelApiError('UNAUTHORIZED');
      case 403:
        throw new VercelApiError('FORBIDDEN');
      case 404:
      case 410:
        throw new VercelApiError('NOT_FOUND');
      case 429:
        throw new VercelApiError('TOO_MANY_REQUESTS');
      default:
        throw new VercelApiError(
          response.status >= 500 || response.status === 408 ? 'SERVICE_UNAVAILABLE' : 'BAD_GATEWAY'
        );
    }
  }

  try {
    return schema.parse(await response.json());
  } catch {
    throw new VercelApiError(signal.aborted ? 'SERVICE_UNAVAILABLE' : 'BAD_GATEWAY');
  }
}

async function listVercelResources<T>(
  token: string,
  url: URL,
  schema: z.ZodType<VercelPage<T>>,
  cursorParameter: 'until' | 'from',
  signal: AbortSignal
): Promise<T[]> {
  const results: T[] = [];
  const seenCursors = new Set<string>();
  url.searchParams.set('limit', String(PAGE_SIZE));

  for (let page = 0; page < MAX_PAGES; page++) {
    const { items, pagination } = await requestVercel(token, url, schema, signal);
    if (pagination.count !== items.length) throw new VercelApiError('BAD_GATEWAY');
    if (results.length + items.length > MAX_RESULTS) throw new VercelApiError('BAD_REQUEST');
    results.push(...items);
    if (pagination.next === null) return results;
    if (results.length === MAX_RESULTS) throw new VercelApiError('BAD_REQUEST');

    const next = String(pagination.next);
    if (seenCursors.has(next)) throw new VercelApiError('BAD_GATEWAY');
    seenCursors.add(next);
    url.searchParams.set(cursorParameter, next);
  }

  throw new VercelApiError('BAD_REQUEST');
}

async function inspectVercelTeam(
  token: string,
  teamId: string,
  signal: AbortSignal
): Promise<void> {
  const team = await requestVercel(
    token,
    new URL(`/v2/teams/${encodeURIComponent(teamId)}`, VERCEL_API_URL),
    TeamSchema,
    signal
  );
  if (team.id !== teamId || team.limited) throw new VercelApiError('FORBIDDEN');
}

export async function discoverVercelTeams(token: string): Promise<VercelTeam[]> {
  const teams = await listVercelResources(
    token,
    new URL('/v2/teams', VERCEL_API_URL),
    TeamsPageSchema,
    'until',
    AbortSignal.timeout(OPERATION_TIMEOUT_MS)
  );
  return teams
    .filter(team => !team.limited)
    .map(({ id, slug, name }) => ({ id, slug, name: name || slug }));
}

export async function discoverVercelProjects(
  token: string,
  teamId: string
): Promise<VercelProject[]> {
  const signal = AbortSignal.timeout(OPERATION_TIMEOUT_MS);
  await inspectVercelTeam(token, teamId, signal);
  const url = new URL('/v10/projects', VERCEL_API_URL);
  url.searchParams.set('teamId', teamId);
  const projects = await listVercelResources(token, url, ProjectsPageSchema, 'from', signal);
  if (projects.some(project => project.accountId !== teamId)) throw new VercelApiError('FORBIDDEN');
  return projects.map(({ id, name }) => ({ id, name, slug: name, teamId }));
}

export async function validateVercelSelection(
  token: string,
  teamId: string,
  projectId: string
): Promise<void> {
  const signal = AbortSignal.timeout(OPERATION_TIMEOUT_MS);
  await inspectVercelTeam(token, teamId, signal);
  const url = new URL(`/v9/projects/${encodeURIComponent(projectId)}`, VERCEL_API_URL);
  url.searchParams.set('teamId', teamId);
  const project = await requestVercel(token, url, ProjectSchema, signal);
  if (project.id !== projectId || project.accountId !== teamId) {
    throw new VercelApiError('FORBIDDEN');
  }
}
