import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { cli_sessions_v2, organizations, type Organization, type User } from '@kilocode/db/schema';
import { inArray } from 'drizzle-orm';
import { orderRepositoriesByUsage } from './order-repositories';

const GITHUB_REPO_A = 'https://github.com/acme/repo-a';
const GITHUB_REPO_B = 'https://github.com/acme/repo-b';

let owner: User;
let other: User;
let organization: Organization;

const insertedSessionIds: string[] = [];

async function insertSession(session: {
  session_id: string;
  kilo_user_id: string;
  parent_session_id?: string | null;
  organization_id?: string | null;
  cloud_agent_session_id?: string | null;
  git_url?: string | null;
  created_at?: string;
  created_on_platform?: string;
}) {
  insertedSessionIds.push(session.session_id);
  await db.insert(cli_sessions_v2).values({
    session_id: session.session_id,
    kilo_user_id: session.kilo_user_id,
    parent_session_id: session.parent_session_id ?? null,
    organization_id: session.organization_id ?? null,
    cloud_agent_session_id: session.cloud_agent_session_id ?? null,
    git_url: session.git_url ?? null,
    created_at: session.created_at,
    created_on_platform: session.created_on_platform ?? 'cloud-agent-web',
  });
}

describe('orderRepositoriesByUsage', () => {
  beforeAll(async () => {
    owner = await insertTestUser({
      google_user_email: 'order-repositories-owner@example.com',
      google_user_name: 'Order Repositories Owner',
      is_admin: false,
    });
    other = await insertTestUser({
      google_user_email: 'order-repositories-other@example.com',
      google_user_name: 'Order Repositories Other',
      is_admin: false,
    });

    [organization] = await db
      .insert(organizations)
      .values({
        name: 'Order Repositories Test Organization',
        created_by_kilo_user_id: owner.id,
      })
      .returning();
  });

  afterEach(async () => {
    if (insertedSessionIds.length > 0) {
      await db
        .delete(cli_sessions_v2)
        .where(inArray(cli_sessions_v2.session_id, insertedSessionIds.splice(0)));
    }
  });

  afterAll(async () => {
    await db.delete(organizations).where(inArray(organizations.id, [organization.id]));
  });

  it('separates personal and organization scope for the same repository', async () => {
    await insertSession({
      session_id: 'ses_order_scope_personal',
      kilo_user_id: owner.id,
      cloud_agent_session_id: 'agent_order_scope_personal',
      git_url: 'https://github.com/acme/personal',
    });
    await insertSession({
      session_id: 'ses_order_scope_org',
      kilo_user_id: owner.id,
      cloud_agent_session_id: 'agent_order_scope_org',
      organization_id: organization.id,
      git_url: 'https://github.com/acme/org',
    });

    const repositories = [{ fullName: 'acme/personal' }, { fullName: 'acme/org' }];

    const personal = await orderRepositoriesByUsage({
      userId: owner.id,
      organizationId: null,
      platform: 'github',
      repositories,
    });
    expect(personal.map(repo => repo.fullName)).toEqual(['acme/personal', 'acme/org']);

    const org = await orderRepositoriesByUsage({
      userId: owner.id,
      organizationId: organization.id,
      platform: 'github',
      repositories,
    });
    expect(org.map(repo => repo.fullName)).toEqual(['acme/org', 'acme/personal']);
  });

  it('isolates history by user', async () => {
    await insertSession({
      session_id: 'ses_order_user_owner',
      kilo_user_id: owner.id,
      cloud_agent_session_id: 'agent_order_user_owner',
      git_url: GITHUB_REPO_A,
    });
    await insertSession({
      session_id: 'ses_order_user_other',
      kilo_user_id: other.id,
      cloud_agent_session_id: 'agent_order_user_other',
      git_url: GITHUB_REPO_B,
    });

    const repositories = [{ fullName: 'acme/repo-a' }, { fullName: 'acme/repo-b' }];

    const forOwner = await orderRepositoriesByUsage({
      userId: owner.id,
      organizationId: null,
      platform: 'github',
      repositories,
    });
    expect(forOwner.map(repo => repo.fullName)).toEqual(['acme/repo-a', 'acme/repo-b']);

    const forOther = await orderRepositoriesByUsage({
      userId: other.id,
      organizationId: null,
      platform: 'github',
      repositories,
    });
    expect(forOther.map(repo => repo.fullName)).toEqual(['acme/repo-b', 'acme/repo-a']);
  });

  it('orders used repositories by session count descending', async () => {
    for (let i = 0; i < 3; i += 1) {
      await insertSession({
        session_id: `ses_order_count_a_${i}`,
        kilo_user_id: owner.id,
        cloud_agent_session_id: `agent_order_count_a_${i}`,
        git_url: GITHUB_REPO_A,
      });
    }
    await insertSession({
      session_id: 'ses_order_count_b',
      kilo_user_id: owner.id,
      cloud_agent_session_id: 'agent_order_count_b',
      git_url: GITHUB_REPO_B,
    });

    const result = await orderRepositoriesByUsage({
      userId: owner.id,
      organizationId: null,
      platform: 'github',
      repositories: [{ fullName: 'acme/repo-b' }, { fullName: 'acme/repo-a' }],
    });
    expect(result.map(repo => repo.fullName)).toEqual(['acme/repo-a', 'acme/repo-b']);
  });

  it('merges raw URL variants into one normalized key', async () => {
    await insertSession({
      session_id: 'ses_order_variant_a_plain',
      kilo_user_id: owner.id,
      cloud_agent_session_id: 'agent_order_variant_a_plain',
      git_url: 'https://github.com/acme/repo-a',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    await insertSession({
      session_id: 'ses_order_variant_a_git',
      kilo_user_id: owner.id,
      cloud_agent_session_id: 'agent_order_variant_a_git',
      git_url: 'https://github.com/acme/repo-a.git',
      created_at: '2026-01-03T00:00:00.000Z',
    });
    await insertSession({
      session_id: 'ses_order_variant_b_1',
      kilo_user_id: owner.id,
      cloud_agent_session_id: 'agent_order_variant_b_1',
      git_url: GITHUB_REPO_B,
      created_at: '2026-01-02T00:00:00.000Z',
    });
    await insertSession({
      session_id: 'ses_order_variant_b_2',
      kilo_user_id: owner.id,
      cloud_agent_session_id: 'agent_order_variant_b_2',
      git_url: GITHUB_REPO_B,
      created_at: '2026-01-02T00:00:00.000Z',
    });

    const result = await orderRepositoriesByUsage({
      userId: owner.id,
      organizationId: null,
      platform: 'github',
      repositories: [{ fullName: 'acme/repo-b' }, { fullName: 'acme/repo-a' }],
    });
    // repo-a sums to 2 across its raw variants and keeps the latest date (01-03).
    // repo-b has 2 uses with latest 01-02. repo-a wins the latest-use tie.
    expect(result.map(repo => repo.fullName)).toEqual(['acme/repo-a', 'acme/repo-b']);
  });

  it('breaks count ties by latest use descending', async () => {
    await insertSession({
      session_id: 'ses_order_tie_a_early',
      kilo_user_id: owner.id,
      cloud_agent_session_id: 'agent_order_tie_a_early',
      git_url: GITHUB_REPO_A,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    await insertSession({
      session_id: 'ses_order_tie_a_late',
      kilo_user_id: owner.id,
      cloud_agent_session_id: 'agent_order_tie_a_late',
      git_url: GITHUB_REPO_A,
      created_at: '2026-01-02T00:00:00.000Z',
    });
    await insertSession({
      session_id: 'ses_order_tie_b_1',
      kilo_user_id: owner.id,
      cloud_agent_session_id: 'agent_order_tie_b_1',
      git_url: GITHUB_REPO_B,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    await insertSession({
      session_id: 'ses_order_tie_b_2',
      kilo_user_id: owner.id,
      cloud_agent_session_id: 'agent_order_tie_b_2',
      git_url: GITHUB_REPO_B,
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const result = await orderRepositoriesByUsage({
      userId: owner.id,
      organizationId: null,
      platform: 'github',
      repositories: [{ fullName: 'acme/repo-b' }, { fullName: 'acme/repo-a' }],
    });
    expect(result.map(repo => repo.fullName)).toEqual(['acme/repo-a', 'acme/repo-b']);
  });

  it('breaks latest-use ties by normalized key ascending', async () => {
    await insertSession({
      session_id: 'ses_order_key_alpha',
      kilo_user_id: owner.id,
      cloud_agent_session_id: 'agent_order_key_alpha',
      git_url: 'https://github.com/acme/alpha',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    await insertSession({
      session_id: 'ses_order_key_beta',
      kilo_user_id: owner.id,
      cloud_agent_session_id: 'agent_order_key_beta',
      git_url: 'https://github.com/acme/beta',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const result = await orderRepositoriesByUsage({
      userId: owner.id,
      organizationId: null,
      platform: 'github',
      repositories: [{ fullName: 'acme/beta' }, { fullName: 'acme/alpha' }],
    });
    expect(result.map(repo => repo.fullName)).toEqual(['acme/alpha', 'acme/beta']);
  });

  it('keeps provider order when history is empty', async () => {
    const result = await orderRepositoriesByUsage({
      userId: owner.id,
      organizationId: null,
      platform: 'github',
      repositories: [{ fullName: 'acme/repo-b' }, { fullName: 'acme/repo-a' }],
    });
    expect(result.map(repo => repo.fullName)).toEqual(['acme/repo-b', 'acme/repo-a']);
  });

  it('ignores history keys absent from the provider response', async () => {
    for (let i = 0; i < 5; i += 1) {
      await insertSession({
        session_id: `ses_order_stale_${i}`,
        kilo_user_id: owner.id,
        cloud_agent_session_id: `agent_order_stale_${i}`,
        git_url: 'https://github.com/acme/stale',
      });
    }
    await insertSession({
      session_id: 'ses_order_current',
      kilo_user_id: owner.id,
      cloud_agent_session_id: 'agent_order_current',
      git_url: GITHUB_REPO_A,
    });

    const result = await orderRepositoriesByUsage({
      userId: owner.id,
      organizationId: null,
      platform: 'github',
      repositories: [{ fullName: 'acme/repo-a' }, { fullName: 'acme/repo-b' }],
    });
    expect(result.map(repo => repo.fullName)).toEqual(['acme/repo-a', 'acme/repo-b']);
  });

  it('appends unused repositories in original provider order', async () => {
    await insertSession({
      session_id: 'ses_order_unused_used',
      kilo_user_id: owner.id,
      cloud_agent_session_id: 'agent_order_unused_used',
      git_url: GITHUB_REPO_A,
    });

    const result = await orderRepositoriesByUsage({
      userId: owner.id,
      organizationId: null,
      platform: 'github',
      repositories: [
        { fullName: 'acme/unused-1' },
        { fullName: 'acme/repo-a' },
        { fullName: 'acme/unused-2' },
      ],
    });
    expect(result.map(repo => repo.fullName)).toEqual([
      'acme/repo-a',
      'acme/unused-1',
      'acme/unused-2',
    ]);
  });

  it('excludes child rows and non-Cloud-Agent CLI rows', async () => {
    await insertSession({
      session_id: 'ses_order_exclude_parent',
      kilo_user_id: owner.id,
      cloud_agent_session_id: 'agent_order_exclude_parent',
      git_url: GITHUB_REPO_A,
    });
    await insertSession({
      session_id: 'ses_order_exclude_child',
      kilo_user_id: owner.id,
      parent_session_id: 'ses_order_exclude_parent',
      cloud_agent_session_id: 'agent_order_exclude_child',
      git_url: GITHUB_REPO_A,
    });
    await insertSession({
      session_id: 'ses_order_exclude_cli',
      kilo_user_id: owner.id,
      cloud_agent_session_id: null,
      git_url: GITHUB_REPO_A,
    });
    await insertSession({
      session_id: 'ses_order_exclude_b_1',
      kilo_user_id: owner.id,
      cloud_agent_session_id: 'agent_order_exclude_b_1',
      git_url: GITHUB_REPO_B,
    });
    await insertSession({
      session_id: 'ses_order_exclude_b_2',
      kilo_user_id: owner.id,
      cloud_agent_session_id: 'agent_order_exclude_b_2',
      git_url: GITHUB_REPO_B,
    });

    const result = await orderRepositoriesByUsage({
      userId: owner.id,
      organizationId: null,
      platform: 'github',
      repositories: [{ fullName: 'acme/repo-a' }, { fullName: 'acme/repo-b' }],
    });
    // repo-b has two eligible rows; repo-a has one. Excluded rows must not count.
    expect(result.map(repo => repo.fullName)).toEqual(['acme/repo-b', 'acme/repo-a']);
  });

  it('matches GitLab instance URLs despite case and suffix differences', async () => {
    await insertSession({
      session_id: 'ses_order_gitlab',
      kilo_user_id: owner.id,
      cloud_agent_session_id: 'agent_order_gitlab',
      git_url: 'https://gitlab.example.com/group/project',
    });

    const result = await orderRepositoriesByUsage({
      userId: owner.id,
      organizationId: null,
      platform: 'gitlab',
      gitlabInstanceUrl: 'https://gitlab.example.com',
      repositories: [{ fullName: 'Other/Repo' }, { fullName: 'Group/Project' }],
    });
    expect(result.map(repo => repo.fullName)).toEqual(['Group/Project', 'Other/Repo']);
  });

  it('matches Bitbucket .git source URLs despite case and suffix differences', async () => {
    await insertSession({
      session_id: 'ses_order_bitbucket',
      kilo_user_id: owner.id,
      cloud_agent_session_id: 'agent_order_bitbucket',
      git_url: 'https://bitbucket.org/acme/repo',
    });

    const result = await orderRepositoriesByUsage({
      userId: owner.id,
      organizationId: null,
      platform: 'bitbucket',
      repositories: [{ fullName: 'Other/Repo' }, { fullName: 'Acme/Repo' }],
    });
    expect(result.map(repo => repo.fullName)).toEqual(['Acme/Repo', 'Other/Repo']);
  });

  it('returns the original array when the rank read fails', async () => {
    const selectSpy = jest.spyOn(db, 'select').mockImplementationOnce(() => {
      throw new Error('database unavailable');
    });

    const repositories = [{ fullName: 'acme/repo-b' }, { fullName: 'acme/repo-a' }];
    const result = await orderRepositoriesByUsage({
      userId: owner.id,
      organizationId: null,
      platform: 'github',
      repositories,
    });

    expect(result).toBe(repositories);
    expect(result.map(repo => repo.fullName)).toEqual(['acme/repo-b', 'acme/repo-a']);
    selectSpy.mockRestore();
  });
});
