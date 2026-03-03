-- Custom SQL migration file, put your code below! --
CREATE TABLE IF NOT EXISTS "discord_gateway_listener" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"listener_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
