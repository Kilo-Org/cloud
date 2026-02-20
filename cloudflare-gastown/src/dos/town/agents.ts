/**
 * Agent CRUD, hook management (GUPP), and name allocation for the Town DO.
 */

import { rig_agents, RigAgentRecord, createTableRigAgents } from '../../db/tables/rig-agents.table';
import { rig_beads, RigBeadRecord } from '../../db/tables/rig-beads.table';
import { rig_mail, RigMailRecord } from '../../db/tables/rig-mail.table';
import { query } from '../../util/query.util';
import { logBeadEvent, getBead } from './beads';
import type {
  RegisterAgentInput,
  AgentFilter,
  Agent,
  AgentRole,
  PrimeContext,
  Bead,
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

export function initAgentTables(sql: SqlStorage): void {
  query(sql, createTableRigAgents(), []);
}

export function registerAgent(sql: SqlStorage, input: RegisterAgentInput): Agent {
  const id = generateId();
  const timestamp = now();

  query(
    sql,
    /* sql */ `
      INSERT INTO ${rig_agents} (
        ${rig_agents.columns.id},
        ${rig_agents.columns.role},
        ${rig_agents.columns.name},
        ${rig_agents.columns.identity},
        ${rig_agents.columns.status},
        ${rig_agents.columns.current_hook_bead_id},
        ${rig_agents.columns.dispatch_attempts},
        ${rig_agents.columns.last_activity_at},
        ${rig_agents.columns.checkpoint},
        ${rig_agents.columns.created_at}
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [id, input.role, input.name, input.identity, 'idle', null, 0, null, null, timestamp]
  );

  const agent = getAgent(sql, id);
  if (!agent) throw new Error('Failed to create agent');
  return agent;
}

export function getAgent(sql: SqlStorage, agentId: string): Agent | null {
  const rows = [
    ...query(sql, /* sql */ `SELECT * FROM ${rig_agents} WHERE ${rig_agents.columns.id} = ?`, [
      agentId,
    ]),
  ];
  if (rows.length === 0) return null;
  return RigAgentRecord.parse(rows[0]);
}

export function getAgentByIdentity(sql: SqlStorage, identity: string): Agent | null {
  const rows = [
    ...query(
      sql,
      /* sql */ `SELECT * FROM ${rig_agents} WHERE ${rig_agents.columns.identity} = ?`,
      [identity]
    ),
  ];
  if (rows.length === 0) return null;
  return RigAgentRecord.parse(rows[0]);
}

export function listAgents(sql: SqlStorage, filter?: AgentFilter): Agent[] {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${rig_agents}
        WHERE (? IS NULL OR ${rig_agents.columns.role} = ?)
          AND (? IS NULL OR ${rig_agents.columns.status} = ?)
        ORDER BY ${rig_agents.columns.created_at} ASC
      `,
      [filter?.role ?? null, filter?.role ?? null, filter?.status ?? null, filter?.status ?? null]
    ),
  ];
  return RigAgentRecord.array().parse(rows);
}

export function updateAgentStatus(sql: SqlStorage, agentId: string, status: string): void {
  query(
    sql,
    /* sql */ `
      UPDATE ${rig_agents}
      SET ${rig_agents.columns.status} = ?
      WHERE ${rig_agents.columns.id} = ?
    `,
    [status, agentId]
  );
}

export function deleteAgent(sql: SqlStorage, agentId: string): void {
  // Clean up mail referencing this agent
  query(
    sql,
    /* sql */ `
      DELETE FROM ${rig_mail}
      WHERE ${rig_mail.columns.from_agent_id} = ? OR ${rig_mail.columns.to_agent_id} = ?
    `,
    [agentId, agentId]
  );

  // Unassign beads
  query(
    sql,
    /* sql */ `
      UPDATE ${rig_beads}
      SET ${rig_beads.columns.assignee_agent_id} = NULL,
          ${rig_beads.columns.status} = 'open',
          ${rig_beads.columns.updated_at} = ?
      WHERE ${rig_beads.columns.assignee_agent_id} = ?
    `,
    [now(), agentId]
  );

  query(sql, /* sql */ `DELETE FROM ${rig_agents} WHERE ${rig_agents.columns.id} = ?`, [agentId]);
}

// ── Hooks (GUPP) ────────────────────────────────────────────────────

export function hookBead(sql: SqlStorage, agentId: string, beadId: string): void {
  const agent = getAgent(sql, agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  const bead = getBead(sql, beadId);
  if (!bead) throw new Error(`Bead ${beadId} not found`);

  // Already hooked to this bead — idempotent
  if (agent.current_hook_bead_id === beadId) return;

  // Agent already has a different hook — unhook first
  if (agent.current_hook_bead_id) {
    unhookBead(sql, agentId);
  }

  query(
    sql,
    /* sql */ `
      UPDATE ${rig_agents}
      SET ${rig_agents.columns.current_hook_bead_id} = ?,
          ${rig_agents.columns.status} = 'idle',
          ${rig_agents.columns.dispatch_attempts} = 0,
          ${rig_agents.columns.last_activity_at} = ?
      WHERE ${rig_agents.columns.id} = ?
    `,
    [beadId, now(), agentId]
  );

  query(
    sql,
    /* sql */ `
      UPDATE ${rig_beads}
      SET ${rig_beads.columns.status} = 'in_progress',
          ${rig_beads.columns.assignee_agent_id} = ?,
          ${rig_beads.columns.updated_at} = ?
      WHERE ${rig_beads.columns.id} = ?
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
      UPDATE ${rig_agents}
      SET ${rig_agents.columns.current_hook_bead_id} = NULL,
          ${rig_agents.columns.status} = 'idle'
      WHERE ${rig_agents.columns.id} = ?
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

export function allocatePolecatName(sql: SqlStorage, rigId: string): string {
  const usedRows = [
    ...query(
      sql,
      /* sql */ `
        SELECT ${rig_agents.columns.name} FROM ${rig_agents}
        WHERE ${rig_agents.columns.role} = 'polecat'
      `,
      []
    ),
  ];
  const usedNames = new Set(usedRows.map(r => String(r.name)));

  for (const name of POLECAT_NAME_POOL) {
    if (!usedNames.has(name)) return name;
  }

  // Fallback: use rig prefix + counter
  return `Polecat-${rigId.slice(0, 4)}-${usedNames.size + 1}`;
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
          SELECT * FROM ${rig_agents}
          WHERE ${rig_agents.columns.role} = 'polecat'
            AND ${rig_agents.columns.status} = 'idle'
            AND ${rig_agents.columns.current_hook_bead_id} IS NULL
          LIMIT 1
        `,
        []
      ),
    ];
    if (idle.length > 0) return RigAgentRecord.parse(idle[0]);
  }

  // Create a new agent
  const name = role === 'polecat' ? allocatePolecatName(sql, rigId) : role;
  const identity = `${name}-${role}-${rigId.slice(0, 8)}@${townId.slice(0, 8)}`;

  return registerAgent(sql, { role, name, identity });
}

// ── Prime Context ───────────────────────────────────────────────────

export function prime(sql: SqlStorage, agentId: string): PrimeContext {
  const agent = getAgent(sql, agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);

  const hookedBead = agent.current_hook_bead_id ? getBead(sql, agent.current_hook_bead_id) : null;

  // Undelivered mail
  const mailRows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${rig_mail}
        WHERE ${rig_mail.columns.to_agent_id} = ?
          AND ${rig_mail.columns.delivered} = 0
        ORDER BY ${rig_mail.columns.created_at} ASC
      `,
      [agentId]
    ),
  ];
  const undeliveredMail = RigMailRecord.array().parse(mailRows);

  // Open beads (for context awareness)
  const openBeadRows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${rig_beads}
        WHERE ${rig_beads.columns.status} IN ('open', 'in_progress')
        ORDER BY ${rig_beads.columns.created_at} DESC
        LIMIT 20
      `,
      []
    ),
  ];
  const openBeads = RigBeadRecord.array().parse(openBeadRows);

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
      UPDATE ${rig_agents}
      SET ${rig_agents.columns.checkpoint} = ?
      WHERE ${rig_agents.columns.id} = ?
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
      UPDATE ${rig_agents}
      SET ${rig_agents.columns.last_activity_at} = ?
      WHERE ${rig_agents.columns.id} = ?
    `,
    [now(), agentId]
  );
}
