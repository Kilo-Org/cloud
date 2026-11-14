CREATE TABLE `ssh_forwards` (
	`id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`direction` text NOT NULL,
	`bind_host` text DEFAULT '127.0.0.1' NOT NULL,
	`bind_port` integer NOT NULL,
	`destination_host` text NOT NULL,
	`destination_port` integer NOT NULL,
	`auto_start` integer DEFAULT false NOT NULL,
	`label` text,
	FOREIGN KEY (`host_id`) REFERENCES `ssh_hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ssh_forwards_host` ON `ssh_forwards` (`host_id`);--> statement-breakpoint
CREATE TABLE `ssh_hosts` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`hostname` text NOT NULL,
	`port` integer DEFAULT 22 NOT NULL,
	`username` text NOT NULL,
	`auth_method` text NOT NULL,
	`password` text,
	`key_id` text,
	`jump_host_id` text,
	`tmux_attach` integer DEFAULT false NOT NULL,
	`tmux_session_name` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_connected_at` integer,
	FOREIGN KEY (`key_id`) REFERENCES `ssh_keys`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`jump_host_id`) REFERENCES `ssh_hosts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ssh_hosts_sort_order` ON `ssh_hosts` (`sort_order`,`label`);--> statement-breakpoint
CREATE TABLE `ssh_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`algorithm` text NOT NULL,
	`source` text NOT NULL,
	`private_key_openssh` text NOT NULL,
	`public_key_openssh` text NOT NULL,
	`fingerprint_sha256` text NOT NULL,
	`passphrase` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ssh_known_hosts` (
	`id` text PRIMARY KEY NOT NULL,
	`host_pattern` text NOT NULL,
	`key_algorithm` text NOT NULL,
	`public_key_base64` text NOT NULL,
	`fingerprint_sha256` text NOT NULL,
	`added_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ssh_known_hosts_host_key` ON `ssh_known_hosts` (`host_pattern`,`key_algorithm`);--> statement-breakpoint
CREATE TABLE `ssh_snippets` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`command` text NOT NULL,
	`append_newline` integer DEFAULT true NOT NULL,
	`host_id` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `ssh_hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ssh_snippets_sort_order` ON `ssh_snippets` (`host_id`,`sort_order`);