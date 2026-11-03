CREATE TABLE `client_case_grading_claims` (
	`profile_id` text NOT NULL,
	`case_id` text NOT NULL,
	`rep` integer NOT NULL,
	`token` text NOT NULL,
	`lease_until` integer NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`profile_id`, `case_id`, `rep`),
	FOREIGN KEY (`profile_id`) REFERENCES `client_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
