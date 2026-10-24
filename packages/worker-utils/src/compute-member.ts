import { sql, type SQLWrapper } from 'drizzle-orm';

// Both settlement and charge-history SQL interpret immutable interval attribution here.
const memberSource = { user: 'actorId', bot: 'billingUserId' } as const;

type Actor = { type: keyof typeof memberSource; id: string };

export function computeMemberId(
  actor: Actor,
  metadata?: { billingUserId?: string }
): string | undefined {
  return { actorId: actor.id, billingUserId: metadata?.billingUserId }[memberSource[actor.type]];
}

export function computeMemberMetadata(actor: Actor, userId: string): { billingUserId?: string } {
  return memberSource[actor.type] === 'billingUserId' ? { billingUserId: userId } : {};
}

export function computeMemberIdSql(columns: {
  actorType: SQLWrapper;
  actorId: SQLWrapper;
  metadata: SQLWrapper;
}) {
  const values = {
    actorId: columns.actorId,
    billingUserId: sql`${columns.metadata}->>'billingUserId'`,
  };
  // Inline these fixed enum values so SELECT and GROUP BY use identical expressions.
  const branches = Object.entries(memberSource).map(
    ([actorType, source]) =>
      sql`WHEN ${columns.actorType} = ${sql`${actorType}`.inlineParams()} THEN ${values[source]}`
  );
  return sql<string | null>`CASE ${sql.join(branches, sql` `)} ELSE NULL END`;
}
