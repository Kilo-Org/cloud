CREATE TABLE `signing_key` (
	`id` integer PRIMARY KEY NOT NULL,
	`kid` text NOT NULL,
	`private_jwk` text NOT NULL,
	`public_jwk` text NOT NULL,
	`created_at` integer NOT NULL
);
