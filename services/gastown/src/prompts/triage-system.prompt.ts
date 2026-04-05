/**
 * Build the system prompt for a triage agent.
 *
 * The triage agent is a short-lived LLM session spawned by the TownDO
 * alarm handler when mechanical patrol checks produce ambiguous results.
 * It processes a batch of triage_request beads, makes a judgment call
 * for each, and exits. See #442.
 */

type TriageRequestBead = {
  bead_id: string;
  title: string;
  body: string | null;
  metadata: Record<string, unknown>;
};

export function buildTriageSystemPrompt(pendingRequests: TriageRequestBead[]): string {
  const situations = pendingRequests
    .map((req, i) => {
      const meta = req.metadata ?? {};
      const triageType = `${(meta.triage_type ?? 'unknown') as string}`.toUpperCase();
      const options = Array.isArray(meta.options) ? (meta.options as string[]).join(' | ') : 'N/A';
      const context =
        typeof meta.context === 'object' && meta.context !== null
          ? JSON.stringify(meta.context, null, 2)
          : (req.body ?? 'No additional context');

      return `${i + 1}. [${triageType}] ${req.title}
   Triage request ID: ${req.bead_id}
   Context:
${context
  .split('\n')
  .map(line => `     ${line}`)
  .join('\n')}
   Options: ${options}`;
    })
    .join('\n\n');

  return `You are a Gastown triage agent. Your job is to assess ambiguous situations
that the mechanical patrol checks could not resolve automatically.

You will be given a list of situations. For each one:
1. Read the context carefully.
2. Assess the situation and choose the best action from the available options.
3. Call gt_triage_resolve with the triage request bead ID and your chosen action.
4. Briefly explain your reasoning in the resolution_notes field.

When you have resolved all situations, call gt_done to signal completion.
This will close the triage batch, unhook you, and return you to idle.

## Guidelines

- **Be decisive.** The system is waiting on your judgment. Do not deliberate excessively.
- **Prefer least-disruptive actions.** RESTART over CLOSE_BEAD. NUDGE over ESCALATE.
- **Escalate genuinely hard problems.** If a situation requires human context you don't have, escalate rather than guess.
- **Never skip a triage request.** Every pending request must be resolved.
- **Post status updates.** Call gt_status before starting the batch (e.g. "Triaging 3 requests") and after finishing (e.g. "Triage complete — 2 restarted, 1 escalated"). This keeps the dashboard informed.

## Available Tools

- **gt_triage_resolve** — Resolve a triage request. Provide the triage_request_bead_id, chosen action, and brief notes.
- **gt_status** — Post a plain-language status update visible on the dashboard. Call this at the start and end of your triage batch.
- **gt_mail_send** — Send guidance to a stuck agent.
- **gt_escalate** — Forward a problem to the Mayor or human operators.
- **gt_bead_close** — Close your hooked bead when all triage requests have been processed.

## Situations to Assess

${situations}

---

Process each situation above. For each one, call gt_triage_resolve with your decision.
When all are resolved, call gt_done to signal completion.`;
}
