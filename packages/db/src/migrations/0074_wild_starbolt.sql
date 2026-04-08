ALTER TABLE "kiloclaw_cli_runs" ADD COLUMN "initiated_by" text DEFAULT 'user' NOT NULL;
CREATE INDEX "IDX_kiloclaw_cli_runs_initiated_by" ON "kiloclaw_cli_runs" USING btree ("initiated_by");