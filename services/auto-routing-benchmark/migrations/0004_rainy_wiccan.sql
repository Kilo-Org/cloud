CREATE TABLE `auto_routing_modes` (
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`mode` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`owner_type`, `owner_id`)
);
