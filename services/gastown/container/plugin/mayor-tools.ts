import { tool } from '@kilocode/plugin';
import type { MayorGastownClient } from './client';
import type { UiActionInput } from './types';

const UI_ACTION_TYPES = new Set([
  'open_bead_drawer',
  'open_convoy_drawer',
  'open_agent_drawer',
  'navigate',
  'highlight_bead',
]);

/** Validate and narrow a parsed JSON object to UiActionInput.
 * Full schema validation happens server-side; this guards the type locally. */
function parseUiAction(value: unknown): UiActionInput {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    throw new Error('"action_json" must be a JSON object with a "type" field');
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.type !== 'string' || !UI_ACTION_TYPES.has(obj.type)) {
    throw new Error(
      `Unknown UI action type: "${String(obj.type)}". Supported: ${[...UI_ACTION_TYPES].join(', ')}`
    );
  }
  // Server-side Zod schema validates required fields per action type.
  // The cast is safe because we've verified the type discriminator.
  return value as UiActionInput;
}

/**
 * Mayor-specific tools for cross-rig delegation.
 * These are only registered when `GASTOWN_AGENT_ROLE=mayor`.
 */
export function createMayorTools(client: MayorGastownClient) {
  return {
    gt_sling: tool({
      description:
        'Delegate a task to a polecat agent in a specific rig. ' +
        'Creates a bead (work item), assigns a polecat, and arms the dispatch alarm. ' +
        'The polecat will be started automatically and begin working on the task. ' +
        'You must specify which rig the work belongs to — use gt_list_rigs first if unsure.',
      args: {
        rig_id: tool.schema.string().describe('The UUID of the rig to assign work to'),
        title: tool.schema.string().describe('Short title describing the task'),
        body: tool.schema
          .string()
          .describe(
            'Detailed description of the work to be done. Include requirements, context, acceptance criteria.'
          )
          .optional(),
        metadata: tool.schema
          .record(tool.schema.string(), tool.schema.unknown())
          .describe(
            'Metadata object for additional context (e.g. { pr_url, branch, target_branch })'
          )
          .optional(),
        labels: tool.schema
          .array(tool.schema.string())
          .describe('Labels to attach to the bead (e.g. ["gt:pr-fixup"])')
          .optional(),
      },
      async execute(args) {
        const result = await client.sling({
          rig_id: args.rig_id,
          title: args.title,
          body: args.body,
          metadata: args.metadata,
          labels: args.labels,
        });
        return [
          `Task slung successfully.`,
          `Bead: ${result.bead.bead_id} — "${result.bead.title}"`,
          `Assigned to: ${result.agent.name} (${result.agent.role}, id: ${result.agent.id})`,
          `Status: ${result.bead.status}`,
          `The polecat will be dispatched automatically by the alarm scheduler.`,
        ].join('\n');
      },
    }),

    gt_list_rigs: tool({
      description:
        'List all rigs (repositories) in your town. ' +
        'Returns the rig ID, name, git URL, and default branch for each rig. ' +
        'Use this to discover available rigs before delegating work with gt_sling.',
      args: {},
      async execute() {
        const rigs = await client.listRigs();
        if (rigs.length === 0) {
          return 'No rigs configured in this town. A rig must be created before work can be delegated.';
        }
        return JSON.stringify(rigs, null, 2);
      },
    }),

    gt_list_beads: tool({
      description:
        'List beads (work items) in a specific rig. ' +
        'Optionally filter by status (open, in_progress, in_review, closed, failed) or type (issue, message, escalation, merge_request). ' +
        'Use this to check what work exists in a rig, what is in progress, and what has been completed.',
      args: {
        rig_id: tool.schema.string().describe('The UUID of the rig to list beads from'),
        status: tool.schema
          .enum(['open', 'in_progress', 'in_review', 'closed', 'failed'])
          .describe('Filter by bead status')
          .optional(),
        type: tool.schema
          .enum(['issue', 'message', 'escalation', 'merge_request'])
          .describe('Filter by bead type')
          .optional(),
      },
      async execute(args) {
        const beads = await client.listBeads(args.rig_id, {
          status: args.status,
          type: args.type,
        });
        if (beads.length === 0) {
          return 'No beads found matching the filter.';
        }
        return JSON.stringify(beads, null, 2);
      },
    }),

    gt_list_agents: tool({
      description:
        'List all agents in a specific rig. ' +
        'Returns agent ID, role, name, status, and current hook (assigned bead). ' +
        'Use this to see which agents are active, idle, or working on what.',
      args: {
        rig_id: tool.schema.string().describe('The UUID of the rig to list agents from'),
      },
      async execute(args) {
        const agents = await client.listAgents(args.rig_id);
        if (agents.length === 0) {
          return 'No agents registered in this rig.';
        }
        return JSON.stringify(agents, null, 2);
      },
    }),

    gt_sling_batch: tool({
      description:
        'Sling multiple beads as a tracked convoy. Use this when a task should be broken ' +
        'into parallel sub-tasks that you want to track as a group. Creates N beads + 1 convoy, ' +
        'assigns polecats, and dispatches all in one call. Use gt_list_convoys to check progress later.',
      args: {
        rig_id: tool.schema.string().describe('The UUID of the rig to assign work to'),
        convoy_title: tool.schema
          .string()
          .describe('Title for the convoy — describes the overall task being decomposed'),
        tasks: tool.schema
          .array(
            tool.schema.object({
              title: tool.schema.string().describe('Short title describing the sub-task'),
              body: tool.schema
                .string()
                .describe('Detailed requirements for the sub-task')
                .optional(),
              depends_on: tool.schema
                .array(tool.schema.number().int().min(0))
                .describe(
                  'Zero-based indices of tasks in this array that must complete before this task can start. ' +
                    'Example: [0] means this task depends on the first task. Omit or use [] for tasks with no dependencies.'
                )
                .optional(),
            })
          )
          .min(1)
          .describe('Array of sub-tasks to create as beads in the convoy'),
        merge_mode: tool.schema
          .enum(['review-then-land', 'review-and-merge'])
          .describe(
            'Controls how completed beads are handled:\n' +
              '- "review-then-land" (default): Each bead is reviewed by the refinery and merged into the convoy feature branch. ' +
              'Only at the end of the convoy does a PR or merge into main occur. Best for tightly coupled work where ' +
              'intermediate PRs would be noisy or where tasks build on each other.\n' +
              '- "review-and-merge": Each bead goes through the full review + merge/PR cycle independently. ' +
              'Best for loosely coupled tasks where each bead stands on its own and you want incremental merges.'
          )
          .optional(),
        parallel: tool.schema
          .boolean()
          .describe(
            'Set to true ONLY when ALL tasks are genuinely independent — they touch completely ' +
              'different files with no shared state. Without this flag, the system REQUIRES at least ' +
              'one task to declare depends_on. This prevents accidental parallel execution of tasks ' +
              'that need ordering, which causes merge conflicts and failures.'
          )
          .optional(),
        staged: tool.schema
          .boolean()
          .describe(
            'If true, creates the convoy plan without dispatching agents. ' +
              'The user can review and edit before calling gt_convoy_start to begin execution. ' +
              'Default: false (dispatch immediately).'
          )
          .optional(),
      },
      async execute(args) {
        const result = await client.slingBatch({
          rig_id: args.rig_id,
          convoy_title: args.convoy_title,
          tasks: args.tasks,
          merge_mode: args.merge_mode,
          parallel: args.parallel,
          staged: args.staged,
        });

        const beadLines = result.beads.map(
          (b: { bead: { title: string }; agent: { name: string; id: string } | null }, i: number) =>
            b.agent
              ? `  ${i + 1}. "${b.bead.title}" → ${b.agent.name} (${b.agent.id})`
              : `  ${i + 1}. "${b.bead.title}" (unassigned, pending gt_convoy_start)`
        );
        const mode = args.merge_mode ?? 'review-then-land';
        const staged = result.convoy.staged;
        return [
          `Convoy ${staged ? 'staged' : 'created'}: "${result.convoy.title}" (${result.convoy.id})`,
          `Merge mode: ${mode}`,
          `Tracking ${result.convoy.total_beads} beads:`,
          ...beadLines,
          staged
            ? `Convoy is staged — agents have NOT been dispatched. Call gt_convoy_start with convoy_id "${result.convoy.id}" when ready to begin execution.`
            : mode === 'review-then-land'
              ? `Beads will be reviewed and merged into the convoy feature branch. A final PR/merge to main occurs when all beads are done.`
              : `Each bead will go through the full review + merge/PR cycle independently.`,
        ].join('\n');
      },
    }),

    gt_list_convoys: tool({
      description:
        'List active convoys with progress. Shows how many beads are closed vs total for each convoy. ' +
        'Use this to check on batched work or answer "how is X going?" questions.',
      args: {},
      async execute() {
        const convoys = await client.listConvoys();
        if (convoys.length === 0) {
          return 'No active convoys. All batched work has either landed or none has been created.';
        }
        return JSON.stringify(convoys, null, 2);
      },
    }),

    gt_convoy_status: tool({
      description:
        'Show detailed status of a convoy: each tracked bead with its status and assignee. ' +
        'Use this for a detailed progress report on a specific batch of work.',
      args: {
        convoy_id: tool.schema.string().describe('The UUID of the convoy to inspect'),
      },
      async execute(args) {
        const status = await client.getConvoyStatus(args.convoy_id);
        return JSON.stringify(status, null, 2);
      },
    }),

    gt_convoy_start: tool({
      description:
        'Start a staged convoy. Transitions the convoy from staged (planned but not executing) ' +
        'to active: hooks agents to all tracked beads and begins dispatch. ' +
        'Call this when the user approves a staged plan and says to start it.',
      args: {
        convoy_id: tool.schema.string().describe('The UUID of the staged convoy to start'),
      },
      async execute(args) {
        const result = await client.startConvoy(args.convoy_id);
        const beadCount = result.beads?.length ?? 0;
        return `Convoy started. ${beadCount} bead(s) dispatched to agents.`;
      },
    }),

    gt_mail_send: tool({
      description:
        'Send a mail message to an agent in any rig. ' +
        'Use this for cross-rig coordination, instructions, or status requests. ' +
        'The recipient must be identified by their agent UUID and rig UUID.',
      args: {
        rig_id: tool.schema.string().describe('The UUID of the rig the recipient agent belongs to'),
        to_agent_id: tool.schema.string().describe('The UUID of the recipient agent'),
        subject: tool.schema.string().describe('Subject line for the mail'),
        body: tool.schema.string().describe('Body content of the mail'),
      },
      async execute(args) {
        await client.sendMail({
          rig_id: args.rig_id,
          to_agent_id: args.to_agent_id,
          subject: args.subject,
          body: args.body,
        });
        return `Mail sent to agent ${args.to_agent_id} in rig ${args.rig_id}.`;
      },
    }),

    gt_bead_update: tool({
      description: "Edit a bead's status, title, body, priority, labels, or dependency blockers.",
      args: {
        rig_id: tool.schema.string().describe('The UUID of the rig the bead belongs to'),
        bead_id: tool.schema.string().describe('The UUID of the bead to update'),
        title: tool.schema.string().describe('New title for the bead').optional(),
        body: tool.schema.string().describe('New body/description for the bead').optional(),
        status: tool.schema
          .enum(['open', 'in_progress', 'in_review', 'closed', 'failed'])
          .describe('New status for the bead')
          .optional(),
        priority: tool.schema
          .enum(['low', 'medium', 'high', 'critical'])
          .describe('New priority for the bead')
          .optional(),
        labels: tool.schema
          .array(tool.schema.string())
          .describe('Replacement labels array for the bead')
          .optional(),
        depends_on: tool.schema
          .array(tool.schema.string())
          .describe(
            "Replace this bead's blockers. Pass an array of bead UUIDs that must be closed before this bead can be dispatched. " +
              'Pass an empty array [] to remove all blockers. Omit to leave dependencies unchanged.'
          )
          .optional(),
      },
      async execute(args) {
        const bead = await client.updateBead(args.rig_id, args.bead_id, {
          title: args.title,
          body: args.body,
          status: args.status,
          priority: args.priority,
          labels: args.labels,
          depends_on: args.depends_on,
        });
        return `Bead ${bead.bead_id} updated. Status: ${bead.status}, Priority: ${bead.priority}, Title: "${bead.title}".`;
      },
    }),

    gt_bead_reassign: tool({
      description: 'Reassign a bead to a different agent.',
      args: {
        rig_id: tool.schema.string().describe('The UUID of the rig the bead belongs to'),
        bead_id: tool.schema.string().describe('The UUID of the bead to reassign'),
        agent_id: tool.schema.string().describe('The UUID of the agent to assign the bead to'),
      },
      async execute(args) {
        const bead = await client.reassignBead(args.rig_id, args.bead_id, args.agent_id);
        return `Bead ${bead.bead_id} reassigned to agent ${args.agent_id}.`;
      },
    }),

    gt_bead_delete: tool({
      description:
        'Delete one or more beads. Use with caution — this is irreversible. Pass a single UUID string or an array of UUIDs to bulk-delete up to 5000 at once.',
      args: {
        rig_id: tool.schema.string().describe('The UUID of the rig the bead(s) belong to'),
        bead_id: tool.schema
          .union([tool.schema.string(), tool.schema.array(tool.schema.string())])
          .describe('A single bead UUID or an array of bead UUIDs to delete'),
      },
      async execute(args) {
        const ids = Array.isArray(args.bead_id) ? args.bead_id : [args.bead_id];
        if (ids.length === 1 && ids[0]) {
          await client.deleteBead(args.rig_id, ids[0]);
          return `Bead ${ids[0]} deleted.`;
        }
        const result = await client.deleteBeads(args.rig_id, ids);
        return `Deleted ${result.deleted} beads.`;
      },
    }),

    gt_agent_reset: tool({
      description: 'Force-reset an agent to idle, unhooking from any bead.',
      args: {
        rig_id: tool.schema.string().describe('The UUID of the rig the agent belongs to'),
        agent_id: tool.schema.string().describe('The UUID of the agent to reset'),
      },
      async execute(args) {
        await client.resetAgent(args.rig_id, args.agent_id);
        return `Agent ${args.agent_id} reset to idle.`;
      },
    }),

    gt_convoy_close: tool({
      description: 'Force-close a convoy and optionally its tracked beads.',
      args: {
        convoy_id: tool.schema.string().describe('The UUID of the convoy to force-close'),
      },
      async execute(args) {
        await client.closeConvoy(args.convoy_id);
        return `Convoy ${args.convoy_id} force-closed.`;
      },
    }),

    gt_convoy_add_bead: tool({
      description:
        'Add an existing bead to an existing convoy. Use this after gt_sling to make a standalone bead ' +
        "part of a convoy's tracked progress and landing. The bead will count toward the convoy's " +
        'completion and will be included in the convoy landing.',
      args: {
        convoy_id: tool.schema.string().describe('UUID of the convoy to add the bead to'),
        bead_id: tool.schema.string().describe('UUID of the bead to add'),
        depends_on: tool.schema
          .array(tool.schema.string())
          .describe('Optional: bead UUIDs that must complete before this bead is dispatched')
          .optional(),
      },
      async execute(args) {
        const result = await client.convoyAddBead(args.convoy_id, args.bead_id, args.depends_on);
        return `Bead ${args.bead_id} added to convoy ${args.convoy_id}. Convoy now tracking ${result.total_beads} beads.`;
      },
    }),

    gt_convoy_remove_bead: tool({
      description:
        'Remove a bead from a convoy. The bead will no longer count toward convoy progress or landing. ' +
        'Dependency edges between this bead and other convoy beads are also removed. ' +
        'The bead itself is not deleted — it becomes a standalone bead.',
      args: {
        convoy_id: tool.schema.string().describe('UUID of the convoy'),
        bead_id: tool.schema.string().describe('UUID of the bead to remove from the convoy'),
      },
      async execute(args) {
        const result = await client.convoyRemoveBead(args.convoy_id, args.bead_id);
        return `Bead ${args.bead_id} removed from convoy ${args.convoy_id}. Convoy now tracking ${result.total_beads} beads.`;
      },
    }),

    gt_convoy_update: tool({
      description: 'Edit convoy metadata (merge_mode, feature_branch).',
      args: {
        convoy_id: tool.schema.string().describe('The UUID of the convoy to update'),
        merge_mode: tool.schema
          .enum(['review-then-land', 'review-and-merge'])
          .describe('New merge mode for the convoy')
          .optional(),
        feature_branch: tool.schema
          .string()
          .describe('New feature branch name for the convoy')
          .optional(),
      },
      async execute(args) {
        await client.updateConvoy(args.convoy_id, {
          merge_mode: args.merge_mode,
          feature_branch: args.feature_branch,
        });
        return `Convoy ${args.convoy_id} updated.`;
      },
    }),

    gt_escalation_acknowledge: tool({
      description: 'Acknowledge an escalation.',
      args: {
        escalation_id: tool.schema.string().describe('The UUID of the escalation to acknowledge'),
      },
      async execute(args) {
        await client.acknowledgeEscalation(args.escalation_id);
        return `Escalation ${args.escalation_id} acknowledged.`;
      },
    }),

    gt_ui_action: tool({
      description:
        "Trigger a UI action in the user's dashboard. " +
        'Lets you open drawers, navigate pages, and highlight items on behalf of the user.\n\n' +
        'Supported action types:\n' +
        '- open_bead_drawer: Open a bead detail drawer. Required fields: beadId, rigId.\n' +
        '- open_convoy_drawer: Open a convoy detail drawer. Required fields: convoyId, townId.\n' +
        '- open_agent_drawer: Open an agent detail drawer. Required fields: agentId, rigId, townId.\n' +
        '- navigate: Navigate to a dashboard page. Required field: page (one of: town-overview, beads, agents, rigs, settings).\n' +
        '- highlight_bead: Highlight a bead in the list. Required fields: beadId, rigId.\n\n' +
        'Examples:\n' +
        '- Open bead drawer: action_json = \'{"type":"open_bead_drawer","beadId":"<id>","rigId":"<id>"}\'\n' +
        '- Navigate to beads: action_json = \'{"type":"navigate","page":"beads"}\'',
      args: {
        action_json: tool.schema
          .string()
          .describe('JSON-encoded UiAction object specifying the UI action to perform'),
      },
      async execute(args) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(args.action_json);
        } catch {
          throw new Error('Invalid JSON in "action_json"');
        }
        const action = parseUiAction(parsed);
        await client.broadcastUiAction(action);
        return `UI action "${action.type}" broadcast to dashboard.`;
      },
    }),

    gt_nudge: tool({
      description:
        'Send a real-time nudge to a polecat agent in any rig. Unlike gt_mail_send (which queues ' +
        "a formal persistent message), gt_nudge delivers immediately at the agent's next idle moment. " +
        'Use this for time-sensitive coordination: wake up an agent, request a status check, ' +
        'or notify of a blocking issue.',
      args: {
        rig_id: tool.schema.string().describe('The UUID of the rig the target agent belongs to'),
        target_agent_id: tool.schema.string().describe('UUID of the agent to nudge'),
        message: tool.schema.string().describe('The message to deliver'),
        mode: tool.schema
          .enum(['wait-idle', 'immediate', 'queue'])
          .describe(
            'Delivery mode: wait-idle (default) delivers at next idle moment; ' +
              'immediate injects mid-task; queue delivers with TTL'
          )
          .optional(),
      },
      async execute(args) {
        const result = await client.nudge({
          rig_id: args.rig_id,
          target_agent_id: args.target_agent_id,
          message: args.message,
          mode: args.mode ?? 'wait-idle',
        });
        return `Nudge queued: ${result.nudge_id} (mode: ${args.mode ?? 'wait-idle'})`;
      },
    }),

    gt_report_bug: tool({
      description:
        'File a bug report on the Kilo-Org/cloud GitHub repo. ' +
        'Searches existing issues first to avoid duplicates. ' +
        'Use this when a user reports a bug or you encounter a repeating system error. ' +
        'Do NOT file bugs for user errors, expected behavior, or issues you can resolve yourself ' +
        '(e.g. re-slinging a failed bead). Do NOT file bugs about yourself being unable to start.',
      args: {
        title: tool.schema.string().describe('Concise bug title'),
        description: tool.schema
          .string()
          .describe('What happened vs. what was expected. Include error messages if available.'),
        area: tool.schema
          .enum([
            'Mayor / Chat',
            'Terminal UI',
            'Bead Board / Dashboard',
            'Convoys',
            'Merge Queue / Refinery',
            'Agent Dispatch / Scheduling',
            'Container / Git',
            'Other',
          ])
          .describe('Which area of Gastown is affected'),
        rig_id: tool.schema
          .string()
          .describe('The rig ID where the bug was observed, if applicable')
          .optional(),
        recent_errors: tool.schema
          .string()
          .describe('Recent error messages or log snippets for context')
          .optional(),
      },
      async execute(args) {
        const ghToken = process.env.GH_TOKEN;
        if (!ghToken) {
          return 'Cannot file bug report: GH_TOKEN is not available in this container. Ask the user to file manually at https://github.com/Kilo-Org/cloud/issues/new?template=gastown-bug.yml';
        }

        const repo = 'Kilo-Org/cloud';
        const headers = {
          Authorization: `Bearer ${ghToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        };

        // Search for potential duplicates (match both Mayor-filed and user-filed bug issues)
        const searchKeywords = args.title.split(/\s+/).slice(0, 5).join(' ');
        const searchQuery = encodeURIComponent(
          `repo:${repo} is:issue is:open label:bug ${searchKeywords}`
        );

        let duplicates: Array<{ number: number; title: string; html_url: string }> = [];
        try {
          const searchRes = await fetch(
            `https://api.github.com/search/issues?q=${searchQuery}&per_page=5`,
            { headers }
          );
          if (searchRes.ok) {
            const searchData = (await searchRes.json()) as {
              items: Array<{ number: number; title: string; html_url: string }>;
            };
            duplicates = searchData.items;
          }
        } catch {
          // Search failure is non-fatal — proceed to create
        }

        if (duplicates.length > 0) {
          const list = duplicates
            .map(d => `  - #${d.number}: ${d.title} (${d.html_url})`)
            .join('\n');
          return [
            `Found ${duplicates.length} potentially related open issue(s):`,
            list,
            '',
            'Review these before filing a new issue. If none match, call gt_report_bug again with a more specific title.',
          ].join('\n');
        }

        // Build issue body with structured context
        const townId = process.env.GASTOWN_TOWN_ID ?? 'unknown';
        const agentId = process.env.GASTOWN_AGENT_ID ?? 'unknown';
        const bodyParts = [
          `## What happened?\n\n${args.description}`,
          `## Area\n\n${args.area}`,
          `## Context\n\n- **Town ID:** ${townId}\n- **Agent:** Mayor (${agentId})`,
        ];
        if (args.rig_id) {
          bodyParts[bodyParts.length - 1] += `\n- **Rig ID:** ${args.rig_id}`;
        }
        if (args.recent_errors) {
          bodyParts.push(`## Recent Errors\n\n\`\`\`\n${args.recent_errors}\n\`\`\``);
        }
        bodyParts.push('*Filed automatically by the Mayor via `gt_report_bug`.*');
        const body = bodyParts.join('\n\n');

        const issuePayload = {
          title: `[Gastown] ${args.title}`,
          body,
          labels: ['bug', 'gt:mayor'],
        };

        let createRes = await fetch(`https://api.github.com/repos/${repo}/issues`, {
          method: 'POST',
          headers,
          body: JSON.stringify(issuePayload),
        });

        // If labeling failed (e.g. token lacks label permissions), retry without labels
        if (!createRes.ok && createRes.status === 422) {
          createRes = await fetch(`https://api.github.com/repos/${repo}/issues`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ title: issuePayload.title, body: issuePayload.body }),
          });
        }

        if (!createRes.ok) {
          const errText = await createRes.text();
          return `Failed to create issue (HTTP ${createRes.status}): ${errText}`;
        }

        const issue = (await createRes.json()) as { number: number; html_url: string };
        return `Bug report filed: #${issue.number} — ${issue.html_url}`;
      },
    }),
  };
}
