import { afterEach, describe, expect, it } from '@jest/globals';
import { security_audit_log } from '@kilocode/db/schema';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';
import { SecurityAuditLogAction } from '@/lib/security-agent/core/enums';

const COLUMNS = [
  'id',
  'timestamp',
  'action',
  'actor_id',
  'actor_email',
  'actor_name',
  'resource_type',
  'resource_id',
  'before_state',
  'after_state',
  'metadata',
] as const;

const cell = (row: string[], column: (typeof COLUMNS)[number]): string => {
  const index = COLUMNS.indexOf(column);
  if (index === -1) throw new Error(`Unknown column ${column}`);
  return row[index];
};

/** Parse one exported CSV line, honouring doubled quotes inside quoted cells. */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      cells.push(current);
      current = '';
    } else {
      current += character;
    }
  }

  cells.push(current);
  return cells;
}

async function seedOrganizationAuditRow(
  values: Partial<typeof security_audit_log.$inferInsert> = {}
) {
  const owner = await insertTestUser();
  const organization = await createTestOrganization(
    `Audit export ${crypto.randomUUID()}`,
    owner.id,
    0
  );

  await db.insert(security_audit_log).values({
    owned_by_organization_id: organization.id,
    actor_id: 'actor-1',
    actor_email: 'analyst@example.test',
    actor_name: 'Analyst',
    action: SecurityAuditLogAction.ConfigUpdated,
    resource_type: 'security_config',
    resource_id: 'config-1',
    metadata: { source: 'test' },
    ...values,
  });

  return { owner, organization };
}

describe('organizations.securityAuditLog.export', () => {
  afterEach(cleanupDbForTest);

  it('writes each exported cell as literal text', async () => {
    const actorName = '=SUM(A1)';
    const { owner, organization } = await seedOrganizationAuditRow({
      actor_email: '+analyst@example.test',
      actor_name: actorName,
      resource_id: '=2+2',
      metadata: { value: '=2+2' },
    });

    const caller = await createCallerForUser(owner.id);
    const result = await caller.organizations.securityAuditLog.export({
      organizationId: organization.id,
      format: 'csv',
    });

    const [header, ...rows] = result.data.split('\n');
    expect(parseCsvLine(header)).toEqual([...COLUMNS]);
    expect(rows).toHaveLength(1);

    const row = parseCsvLine(rows[0]);
    expect(cell(row, 'actor_email')).toBe("'+analyst@example.test");
    expect(cell(row, 'actor_name')).toBe(`'${actorName}`);
    expect(cell(row, 'resource_id')).toBe("'=2+2");
    expect(cell(row, 'action')).toBe(SecurityAuditLogAction.ConfigUpdated);
    expect(cell(row, 'actor_id')).toBe('actor-1');
    expect(cell(row, 'metadata')).toBe('{"value":"=2+2"}');

    expect(rows[0]).toContain(`"'=SUM(A1)"`);
    expect(rows[0]).toContain(`"'+analyst@example.test"`);
    expect(rows[0]).toContain('"{""value"":""=2+2""}"');
  });

  it('exports ordinary values unchanged and leaves the JSON export untouched', async () => {
    const { owner, organization } = await seedOrganizationAuditRow();
    const caller = await createCallerForUser(owner.id);

    const csv = await caller.organizations.securityAuditLog.export({
      organizationId: organization.id,
      format: 'csv',
    });
    const row = parseCsvLine(csv.data.split('\n')[1]);
    expect(cell(row, 'actor_email')).toBe('analyst@example.test');
    expect(cell(row, 'actor_name')).toBe('Analyst');
    expect(cell(row, 'metadata')).toBe('{"source":"test"}');
    expect(cell(row, 'timestamp')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);

    const json = await caller.organizations.securityAuditLog.export({
      organizationId: organization.id,
      format: 'json',
    });
    const entries = JSON.parse(json.data) as {
      action: string;
      actor_email: string;
      actor_name: string;
    }[];
    const entry = entries.find(row => row.action === SecurityAuditLogAction.ConfigUpdated);
    expect(entry?.actor_email).toBe('analyst@example.test');
    expect(entry?.actor_name).toBe('Analyst');
  });
});
