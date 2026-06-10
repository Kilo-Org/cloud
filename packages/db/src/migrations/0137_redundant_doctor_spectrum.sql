ALTER TABLE "model_experiment_request" DROP CONSTRAINT "model_experiment_request_system_prompt_sha256_format";--> statement-breakpoint
ALTER TABLE "model_experiment_request" ADD COLUMN "request_kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "model_experiment_request" DROP COLUMN "system_prompt_sha256";--> statement-breakpoint
ALTER TABLE "model_experiment_request" ADD CONSTRAINT "model_experiment_request_request_kind_valid" CHECK ("model_experiment_request"."request_kind" IN ('chat_completions', 'messages', 'responses'));