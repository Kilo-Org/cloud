CREATE TABLE `cloud_agent_child_sessions` (
	`child_session_id` text PRIMARY KEY NOT NULL,
	`initial_message_id` text,
	`worktree_id` text,
	`created_at` integer NOT NULL
);
