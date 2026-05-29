export function eventDescription(event: {
  event_type: string;
  old_value: string | null;
  new_value: string | null;
  metadata: Record<string, unknown>;
  rig_name?: string;
}): string {
  const rigPrefix = event.rig_name ? `[${event.rig_name}] ` : '';
  switch (event.event_type) {
    case 'created': {
      const title = event.metadata?.title;
      return `${rigPrefix}Bead created: ${typeof title === 'string' ? title : (event.new_value ?? 'unknown')}`;
    }
    case 'hooked':
      return `${rigPrefix}Agent hooked to bead`;
    case 'unhooked':
      return `${rigPrefix}Agent unhooked from bead`;
    case 'status_changed': {
      const desc = `${rigPrefix}Status: ${event.old_value ?? '?'} → ${event.new_value ?? '?'}`;
      if (event.new_value === 'failed') {
        const fr = event.metadata?.failure_reason;
        if (typeof fr === 'object' && fr !== null && 'message' in fr) {
          const msg = (fr as Record<string, unknown>).message;
          if (typeof msg === 'string') return `${desc} — ${msg}`;
        }
      }
      return desc;
    }
    case 'closed':
      return `${rigPrefix}Bead closed`;
    case 'escalated':
      return `${rigPrefix}Escalation created`;
    case 'review_submitted':
      return `${rigPrefix}Submitted for review: ${event.new_value ?? ''}`;
    case 'review_completed':
      return `${rigPrefix}Review ${event.new_value ?? 'completed'}`;
    case 'mail_sent':
      return `${rigPrefix}Mail sent`;
    case 'triage_resolved': {
      const action = event.new_value ?? (event.metadata?.action as string | undefined) ?? 'unknown';
      const notes = event.metadata?.resolution_notes as string | undefined;
      const desc = `${rigPrefix}Triage: ${action}`;
      return notes ? `${desc} — ${notes}` : desc;
    }
    case 'agent_status': {
      const msg = event.new_value ?? (event.metadata?.message as string | undefined);
      const agentName = event.metadata?.agent_name as string | undefined;
      const rigName = event.metadata?.rig_name as string | undefined;
      const body = msg ?? 'Agent status update';
      const prefix = rigName ? `[${rigName}] ` : rigPrefix;
      return agentName ? `${prefix}${agentName}: ${body}` : `${prefix}${body}`;
    }
    case 'babysit_started':
      return `${rigPrefix}Babysit started — town is now monitoring this PR`;
    case 'pr_feedback_detected': {
      const source = event.metadata?.source as string | undefined;
      return source
        ? `${rigPrefix}PR feedback detected (${source})`
        : `${rigPrefix}PR feedback detected`;
    }
    case 'pr_conflict_detected':
      return `${rigPrefix}PR merge conflict detected`;
    case 'pr_auto_merge':
      return `${rigPrefix}PR auto-merge triggered`;
    case 'pr_status_changed': {
      const state = event.new_value ?? 'unknown';
      return `${rigPrefix}PR status changed: ${state}`;
    }
    default:
      return `${rigPrefix}${event.event_type}`;
  }
}
