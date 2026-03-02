import type { requests } from './sqlite-schema';

export type ProcessStatus = 'captured' | 'inprogress' | 'success' | 'failed';

export type RequestUpdates = {
  process_status?: ProcessStatus;
  cloud_agent_session_id?: string;
  started_at?: string;
  completed_at?: string;
  error_message?: string;
};

export type RequestRow = typeof requests.$inferSelect;
