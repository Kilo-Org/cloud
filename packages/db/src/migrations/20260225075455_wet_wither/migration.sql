CREATE TABLE "temp_phase" (
	"key" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "IDX_temp_phase_created_at" ON "temp_phase" USING btree ("created_at");