CREATE TABLE "agent_harness_clients" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"session_binding" text NOT NULL,
	"supported_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "agent_harness_clients_kind_check" CHECK ("agent_harness_clients"."kind" IN ('browser', 'mobile'))
);
--> statement-breakpoint
CREATE TABLE "agent_harness_conversation_grants" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"client_id" uuid NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "agent_harness_grants_generation_check" CHECK ("agent_harness_conversation_grants"."generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE "agent_harness_conversation_registry" (
	"thread_id" uuid PRIMARY KEY NOT NULL,
	"user_id" text,
	"organization_id" uuid,
	"generation" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_harness_registry_generation_check" CHECK ("agent_harness_conversation_registry"."generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE "agent_harness_invitation_results" (
	"thread_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"input_digest" text NOT NULL,
	"invitation_id" uuid NOT NULL,
	"canonical_result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_harness_invitation_results_thread_id_operation_id_pk" PRIMARY KEY("thread_id","operation_id")
);
--> statement-breakpoint
CREATE TABLE "agent_harness_retirements" (
	"thread_id" uuid NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"reason" text NOT NULL,
	"retired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	CONSTRAINT "agent_harness_retirements_thread_id_generation_pk" PRIMARY KEY("thread_id","generation"),
	CONSTRAINT "agent_harness_retirements_generation_check" CHECK ("agent_harness_retirements"."generation" >= 0),
	CONSTRAINT "agent_harness_retirements_reason_check" CHECK ("agent_harness_retirements"."reason" IN ('account_deleted', 'context_retired')),
	CONSTRAINT "agent_harness_retirements_lease_check" CHECK (("agent_harness_retirements"."lease_token" IS NULL) = ("agent_harness_retirements"."lease_expires_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "quick_chat_messages" ADD COLUMN "provenance" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "quick_chat_messages" ADD COLUMN "server_projection_key" text;--> statement-breakpoint
ALTER TABLE "quick_chat_messages" ADD COLUMN "ingress_acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quick_chat_messages" ADD COLUMN "ingress_lease_token" uuid;--> statement-breakpoint
ALTER TABLE "quick_chat_messages" ADD COLUMN "ingress_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_harness_clients" ADD CONSTRAINT "agent_harness_clients_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_harness_conversation_grants" ADD CONSTRAINT "agent_harness_conversation_grants_thread_id_quick_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."quick_chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_harness_conversation_grants" ADD CONSTRAINT "agent_harness_conversation_grants_user_id_kilocode_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_harness_conversation_grants" ADD CONSTRAINT "agent_harness_conversation_grants_client_id_agent_harness_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."agent_harness_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_harness_invitation_results" ADD CONSTRAINT "agent_harness_invitation_results_thread_id_quick_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."quick_chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_agent_harness_clients_user" ON "agent_harness_clients" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "IDX_agent_harness_grants_thread" ON "agent_harness_conversation_grants" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "IDX_agent_harness_grants_user" ON "agent_harness_conversation_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "IDX_agent_harness_grants_client" ON "agent_harness_conversation_grants" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "IDX_agent_harness_registry_user" ON "agent_harness_conversation_registry" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "IDX_agent_harness_registry_org" ON "agent_harness_conversation_registry" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "IDX_agent_harness_retirements_pending" ON "agent_harness_retirements" USING btree ("lease_expires_at" NULLS FIRST,"thread_id","generation") WHERE "agent_harness_retirements"."acknowledged_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "quick_chat_messages_server_projection_uidx" ON "quick_chat_messages" USING btree ("server_projection_key");--> statement-breakpoint
CREATE INDEX "IDX_quick_chat_messages_pending_ingress" ON "quick_chat_messages" USING btree ("thread_id","created_at","id") WHERE "quick_chat_messages"."provenance" = 'legacy' AND "quick_chat_messages"."ingress_acknowledged_at" IS NULL;--> statement-breakpoint
CREATE INDEX "IDX_quick_chat_messages_ingress_lease" ON "quick_chat_messages" USING btree ("ingress_lease_expires_at" NULLS FIRST,"thread_id","id") WHERE "quick_chat_messages"."provenance" = 'legacy' AND "quick_chat_messages"."ingress_acknowledged_at" IS NULL;--> statement-breakpoint
ALTER TABLE "quick_chat_messages" ADD CONSTRAINT "quick_chat_messages_projection_check" CHECK (("quick_chat_messages"."provenance" = 'legacy' AND "quick_chat_messages"."server_projection_key" IS NULL)
        OR ("quick_chat_messages"."provenance" = 'harness' AND "quick_chat_messages"."server_projection_key" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "quick_chat_messages" ADD CONSTRAINT "quick_chat_messages_ingress_lease_check" CHECK (("quick_chat_messages"."ingress_lease_token" IS NULL) = ("quick_chat_messages"."ingress_lease_expires_at" IS NULL));