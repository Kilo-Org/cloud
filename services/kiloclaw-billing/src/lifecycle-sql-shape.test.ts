import { describe, expect, it } from 'vitest';
import { getWorkerDb } from '@kilocode/db';

import { buildComplementaryInferenceEndedCandidateQuery } from './lifecycle.js';

describe('complementary inference ended candidate query SQL shape', () => {
  it('uses normalized instance email log path without legacy OR/string concat joins', () => {
    const db = getWorkerDb('postgres://unused:unused@localhost:0/unused');
    const query = buildComplementaryInferenceEndedCandidateQuery(
      db,
      '2026-04-17T00:00:00.000Z'
    ).toSQL();
    const sql = query.sql.toLowerCase();

    expect(sql).toContain('from "kiloclaw_email_log"');
    expect(sql).toContain('"kiloclaw_email_log"."instance_id" = "kiloclaw_instances"."id"');
    expect(sql).toContain('"kiloclaw_email_log"."user_id" = "kiloclaw_instances"."user_id"');
    expect(sql).toContain('"kiloclaw_email_log"."email_type" = $1');
    expect(sql).toContain('"kiloclaw_email_log"."instance_id" is not null');
    expect(sql).toContain('"kiloclaw_instances"."destroyed_at" is null');
    expect(sql).toContain('not exists');
    expect(sql).toContain('from "credit_transactions"');
    expect(sql).toContain('"credit_transactions"."is_free" = false');
    expect(sql).toContain('"credit_transactions"."organization_id" is null');
    expect(sql).not.toMatch(/\bor\b/i);
    expect(sql).not.toContain('||');
    expect(sql).not.toContain('claw_instance_ready:');
    expect(sql).not.toContain('claw_complementary_inference_ended:');
    expect(query.params).toEqual([
      'claw_instance_ready',
      '2026-04-10T00:00:00.000Z',
      '2026-04-17T00:00:00.000Z',
      'claw_complementary_inference_ended',
    ]);
  });
});
