CREATE TABLE "gateway_config" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"vercel_routing_percentage" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
