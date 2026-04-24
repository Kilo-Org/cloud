ALTER TABLE "kilocode_users" ADD COLUMN "web_session_pepper" text;
--> statement-breakpoint
UPDATE "kilocode_users" SET "web_session_pepper" = "api_token_pepper";
