/**
 * Agent CRUD, hook management (GUPP), and name allocation for the Town DO.
 *
 * After the beads-centric refactor (#441), agents are beads with type='agent'
 * joined with agent_metadata for operational state.
 */

import { beads, BeadRecord } from '../../db/tables/beads.table';
import { agent_metadata, AgentMetadataRecord } from '../../db/tables/agent-metadata.table';
import { query } from '../../util/query.util';
import { logBeadEvent, getBead } from './beads';
import type {
  RegisterAgentInput,
  AgentFilter,
  Agent,
  AgentRole,
  PrimeContext,
  Bead,
  Mail,
} from '../../types';

// Polecat name pool (20 names, used in allocation order)
const POLECAT_NAME_POOL = [
  'Toast',
  'Maple',
  'Birch',
  'Shadow',
  'Clover',
  'Ember',
  'Sage',
  'Dusk',
  'Flint',
  'Coral',
  'Slate',
  'Reed',
  'Thorn',
  'Pike',
  'Moss',
  'Wren',
  'Blaze',
  'Gale',
  'Drift',
  'Lark',
];

function generateId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

function parseCheckpoint(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

/**
 * Parse a joined bead + agent_metadata row into an Agent object.
 * The SQL query aliases bead columns and agent_metadata columns into
 * a flat row that we reconstruct here.
 */
function parseAgent(row: Record<string, unknown>): Agent {
  return {
    id: String(row.bead_id),
    rig_id: row.rig_id === null ? null : String(row.rig_id),
    role: AgentMetadataRecord.shape.role.parse(row.role),
    name: String(row.title),
    identity: String(row.identity),
    status: AgentMetadataRecord.shape.status.parse(row.status),
    current_hook_bead_id:
      row.current_hook_bead_id === null ? null : String(row.current_hook_bead_id),
    dispatch_attempts: Number(row.dispatch_attempts ?? 0),
    last_activity_at: row.last_activity_at === null ? null : String(row.last_activity_at),
    checkpoint: parseCheckpoint(row.checkpoint),
    created_at: String(row.created_at),
  };
}

/** SQL fragment for joining beads + agent_metadata */
const AGENT_JOIN = /* sql */ `
  SELECT ${beads.bead_id}, ${beads.rig_id}, ${beads.title}, ${beads.created_at},
         ${agent_metadata.role}, ${agent_metadata.identity},
         ${agent_metadata.status}, ${agent_metadata.current_hook_bead_id},
         ${agent_metadata.dispatch_attempts}, ${agent_metadata.last_activity_at},
         ${agent_metadata.checkpoint}
  FROM ${beads}
  INNER JOIN ${agent_metadata} ON ${beads.bead_id} = ${agent_metadata.bead_id}
`;

export function initAgentTables(_sql: SqlStorage): void {
  // Agent tables are now initialized in beads.initBeadTables()
  // (beads table + agent_metadata satellite)
}

export function registerAgent(sql: SqlStorage, input: RegisterAgentInput): Agent {
  const id = generateId();
  const timestamp = now();

  // Create the agent bead
  query(
    sql,
    /* sql */ `
      INSERT INTO ${beads} (
        ${beads.columns.bead_id}, ${beads.columns.type}, ${beads.columns.status},
        ${beads.columns.title}, ${beads.columns.body}, ${beads.columns.rig_id},
        ${beads.columns.parent_bead_id}, ${beads.columns.assignee_agent_bead_id},
        ${beads.columns.priority}, ${beads.columns.labels}, ${beads.columns.metadata},
        ${beads.columns.created_by}, ${beads.columns.created_at}, ${beads.columns.updated_at},
        ${beads.columns.closed_at}
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      'agent',
      'open',
      input.name,
      null,
      input.rig_id ?? null,
      null,
      null,
      'medium',
      '[]',
      '{}',
      null,
      timestamp,
      timestamp,
      null,
    ]
  );

  // Create the agent_metadata satellite row
  query(
    sql,
    /* sql */ `
      INSERT INTO ${agent_metadata} (
        ${agent_metadata.columns.bead_id}, ${agent_metadata.columns.role},
        ${agent_metadata.columns.identity}, ${agent_metadata.columns.container_process_id},
        ${agent_metadata.columns.status}, ${agent_metadata.columns.current_hook_bead_id},
        ${agent_metadata.columns.dispatch_attempts}, ${agent_metadata.columns.checkpoint},
        ${agent_metadata.columns.last_activity_at}
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [id, input.role, input.identity, null, 'idle', null, 0, null, null]
  );

  const agent = getAgent(sql, id);
  if (!agent) throw new Error('Failed to create agent');
  return agent;
}

export function getAgent(sql: SqlStorage, agentId: string): Agent | null {
  const rows = [...query(sql, /* sql */ `${AGENT_JOIN} WHERE ${beads.bead_id} = ?`, [agentId])];
  if (rows.length === 0) return null;
  return parseAgent(rows[0] as Record<string, unknown>);
}

export function getAgentByIdentity(sql: SqlStorage, identity: string): Agent | null {
  const rows = [
    ...query(sql, /* sql */ `${AGENT_JOIN} WHERE ${agent_metadata.identity} = ?`, [identity]),
  ];
  if (rows.length === 0) return null;
  return parseAgent(rows[0] as Record<string, unknown>);
}

export function listAgents(sql: SqlStorage, filter?: AgentFilter): Agent[] {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        ${AGENT_JOIN}
        WHERE (? IS NULL OR ${agent_metadata.role} = ?)
          AND (? IS NULL OR ${agent_metadata.status} = ?)
          AND (? IS NULL OR ${beads.rig_id} = ?)
        ORDER BY ${beads.created_at} ASC
      `,
      [
        filter?.role ?? null,
        filter?.role ?? null,
        filter?.status ?? null,
        filter?.status ?? null,
        filter?.rig_id ?? null,
        filter?.rig_id ?? null,
      ]
    ),
  ];
  return rows.map(r => parseAgent(r as Record<string, unknown>));
}

export function updateAgentStatus(sql: SqlStorage, agentId: string, status: string): void {
  query(
    sql,
    /* sql */ `
      UPDATE ${agent_metadata}
      SET ${agent_metadata.columns.status} = ?
      WHERE ${agent_metadata.columns.bead_id} = ?
    `,
    [status, agentId]
  );
}

export function deleteAgent(sql: SqlStorage, agentId: string): void {
  // Unassign beads that reference this agent
  query(
    sql,
    /* sql */ `
      UPDATE ${beads}
      SET ${beads.columns.assignee_agent_bead_id} = NULL,
          ${beads.columns.status} = 'open',
          ${beads.columns.updated_at} = ?
      WHERE ${beads.columns.assignee_agent_bead_id} = ?
    `,
    [now(), agentId]
  );

  // Delete mail beads where this agent is sender or recipient (via labels)
  // Mail beads reference agents in their metadata, but we clean up directly
  // since the FK is via assignee_agent_bead_id for received mail.

  // Delete agent_metadata first (FK to beads)
  query(
    sql,
    /* sql */ `DELETE FROM ${agent_metadata} WHERE ${agent_metadata.columns.bead_id} = ?`,
    [agentId]
  );

  // Delete the agent bead itself
  query(sql, /* sql */ `DELETE FROM ${beads} WHERE ${beads.columns.bead_id} = ?`, [agentId]);
}

// ── Hooks (GUPP) ────────────────────────────────────────────────────

export function hookBead(sql: SqlStorage, agentId: string, beadId: string): void {
  const agent = getAgent(sql, agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  const bead = getBead(sql, beadId);
  if (!bead) throw new Error(`Bead ${beadId} not found`);

  // Already hooked to this bead — idempotent
  if (agent.current_hook_bead_id === beadId) return;

  // Agent already has a different hook — caller must unhook first
  if (agent.current_hook_bead_id) {
    throw new Error(
      `Agent ${agentId} is already hooked to bead ${agent.current_hook_bead_id}. Unhook first.`
    );
  }

  query(
    sql,
    /* sql */ `
      UPDATE ${agent_metadata}
      SET ${agent_metadata.columns.current_hook_bead_id} = ?,
          ${agent_metadata.columns.status} = 'idle',
          ${agent_metadata.columns.dispatch_attempts} = 0,
          ${agent_metadata.columns.last_activity_at} = ?
      WHERE ${agent_metadata.columns.bead_id} = ?
    `,
    [beadId, now(), agentId]
  );

  query(
    sql,
    /* sql */ `
      UPDATE ${beads}
      SET ${beads.columns.status} = 'in_progress',
          ${beads.columns.assignee_agent_bead_id} = ?,
          ${beads.columns.updated_at} = ?
      WHERE ${beads.columns.bead_id} = ?
    `,
    [agentId, now(), beadId]
  );

  logBeadEvent(sql, {
    beadId,
    agentId,
    eventType: 'hooked',
    newValue: agentId,
  });
}

export function unhookBead(sql: SqlStorage, agentId: string): void {
  const agent = getAgent(sql, agentId);
  if (!agent || !agent.current_hook_bead_id) return;

  const beadId = agent.current_hook_bead_id;

  query(
    sql,
    /* sql */ `
      UPDATE ${agent_metadata}
      SET ${agent_metadata.columns.current_hook_bead_id} = NULL,
          ${agent_metadata.columns.status} = 'idle'
      WHERE ${agent_metadata.columns.bead_id} = ?
    `,
    [agentId]
  );

  logBeadEvent(sql, {
    beadId,
    agentId,
    eventType: 'unhooked',
    oldValue: agentId,
  });
}

export function getHookedBead(sql: SqlStorage, agentId: string): Bead | null {
  const agent = getAgent(sql, agentId);
  if (!agent?.current_hook_bead_id) return null;
  return getBead(sql, agent.current_hook_bead_id);
}

// ── Name Allocation ─────────────────────────────────────────────────

/**
 * Allocate a unique polecat name from the pool.
 * Names are town-global (agents belong to the town, not rigs) so we
 * check all existing polecats across every rig.
 */
export function allocatePolecatName(sql: SqlStorage): string {
  const usedRows = [
    ...query(
      sql,
      /* sql */ `
        SELECT ${beads.title} FROM ${beads}
        INNER JOIN ${agent_metadata} ON ${beads.bead_id} = ${agent_metadata.bead_id}
        WHERE ${agent_metadata.role} = 'polecat'
      `,
      []
    ),
  ];
  const usedNames = new Set(usedRows.map(r => String((r as Record<string, unknown>).title)));

  for (const name of POLECAT_NAME_POOL) {
    if (!usedNames.has(name)) return name;
  }

  // Fallback: sequential numbering beyond the 20-name pool
  return `Polecat-${usedNames.size + 1}`;
}

/**
 * Find an idle agent of the given role, or create one.
 * For singleton roles (witness, refinery, mayor), reuse existing.
 * For polecats, create a new one.
 */
export function getOrCreateAgent(
  sql: SqlStorage,
  role: AgentRole,
  rigId: string,
  townId: string
): Agent {
  const singletonRoles = ['witness', 'refinery', 'mayor'];

  if (singletonRoles.includes(role)) {
    // Try to find an existing agent with this role
    const existing = listAgents(sql, { role });
    if (existing.length > 0) return existing[0];
  } else {
    // For polecats, try to find an idle one without a hook
    const idle = [
      ...query(
        sql,
        /* sql */ `
          ${AGENT_JOIN}
          WHERE ${agent_metadata.role} = 'polecat'
            AND ${agent_metadata.status} = 'idle'
            AND ${agent_metadata.current_hook_bead_id} IS NULL
          LIMIT 1
        `,
        []
      ),
    ];
    if (idle.length > 0) return parseAgent(idle[0] as Record<string, unknown>);
  }

  // Create a new agent
  const name = role === 'polecat' ? allocatePolecatName(sql) : role;
  const identity = `${name}-${role}-${rigId.slice(0, 8)}@${townId.slice(0, 8)}`;

  return registerAgent(sql, { role, name, identity, rig_id: rigId });
}

// ── Prime Context ───────────────────────────────────────────────────

export function prime(sql: SqlStorage, agentId: string): PrimeContext {
  const agent = getAgent(sql, agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  const hookedBead = agent.current_hook_bead_id ? getBead(sql, agent.current_hook_bead_id) : null;

  // Undelivered mail: message beads assigned to this agent that are still open
  const mailRows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${beads}
        WHERE ${beads.columns.type} = 'message'
          AND ${beads.columns.assignee_agent_bead_id} = ?
          AND ${beads.columns.status} = 'open'
        ORDER BY ${beads.columns.created_at} ASC
      `,
      [agentId]
    ),
  ];
  const mailBeads = BeadRecord.array().parse(mailRows);
  const undeliveredMail: Mail[] = mailBeads.map(mb => ({
    id: mb.bead_id,
    from_agent_id: String(mb.metadata?.from_agent_id ?? mb.created_by ?? ''),
    to_agent_id: agentId,
    subject: mb.title,
    body: mb.body ?? '',
    delivered: false,
    created_at: mb.created_at,
    delivered_at: null,
  }));

  // Mark mail as delivered (close the message beads)
  if (mailBeads.length > 0) {
    const timestamp = now();
    for (const mb of mailBeads) {
      query(
        sql,
        /* sql */ `
          UPDATE ${beads}
          SET ${beads.columns.status} = 'closed',
              ${beads.columns.closed_at} = ?,
              ${beads.columns.updated_at} = ?
          WHERE ${beads.columns.bead_id} = ?
        `,
        [timestamp, timestamp, mb.bead_id]
      );
    }
  }

  // Open beads (for context awareness, scoped to agent's rig)
  const openBeadRows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${beads}
        WHERE ${beads.columns.status} IN ('open', 'in_progress')
          AND ${beads.columns.type} != 'agent'
          AND ${beads.columns.type} != 'message'
          AND (${beads.columns.rig_id} IS NULL OR ${beads.columns.rig_id} = ?)
        ORDER BY ${beads.columns.created_at} DESC
        LIMIT 20
      `,
      [agent.rig_id]
    ),
  ];
  const openBeads = BeadRecord.array().parse(openBeadRows);

  return {
    agent,
    hooked_bead: hookedBead,
    undelivered_mail: undeliveredMail,
    open_beads: openBeads,
  };
}

// ── Checkpoint ──────────────────────────────────────────────────────

export function writeCheckpoint(sql: SqlStorage, agentId: string, data: unknown): void {
  const serialized = data === null || data === undefined ? null : JSON.stringify(data);
  query(
    sql,
    /* sql */ `
      UPDATE ${agent_metadata}
      SET ${agent_metadata.columns.checkpoint} = ?
      WHERE ${agent_metadata.columns.bead_id} = ?
    `,
    [serialized, agentId]
  );
}

export function readCheckpoint(sql: SqlStorage, agentId: string): unknown {
  const agent = getAgent(sql, agentId);
  return agent?.checkpoint ?? null;
}

// ── Touch (heartbeat helper) ────────────────────────────────────────

export function touchAgent(sql: SqlStorage, agentId: string): void {
  query(
    sql,
    /* sql */ `
      UPDATE ${agent_metadata}
      SET ${agent_metadata.columns.last_activity_at} = ?
      WHERE ${agent_metadata.columns.bead_id} = ?
    `,
    [now(), agentId]
  );
}
