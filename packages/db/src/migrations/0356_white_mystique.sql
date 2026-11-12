ALTER TABLE "session_step_up_challenges" ADD COLUMN "action_class" text;--> statement-breakpoint
ALTER TABLE "session_step_up_proofs" ADD COLUMN "action_class" text;--> statement-breakpoint
ALTER TABLE "session_step_up_proofs" ADD COLUMN "target_identifier" text;--> statement-breakpoint
CREATE INDEX "idx_session_step_up_proofs_user_binding" ON "session_step_up_proofs" USING btree ("kilo_user_id","session_id_hash","action_binding_hash");--> statement-breakpoint
ALTER TABLE "session_step_up_challenges" ADD CONSTRAINT "check_session_step_up_challenges_action_class" CHECK (("session_step_up_challenges"."purpose" = 'operation') = ("session_step_up_challenges"."action_class" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "session_step_up_proofs" ADD CONSTRAINT "check_session_step_up_proofs_action_class" CHECK (("session_step_up_proofs"."purpose" = 'operation') = ("session_step_up_proofs"."action_class" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "session_step_up_proofs" ADD CONSTRAINT "check_session_step_up_proofs_target_identifier" CHECK (("session_step_up_proofs"."purpose" = 'operation') = ("session_step_up_proofs"."target_identifier" IS NOT NULL));