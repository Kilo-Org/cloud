CREATE TABLE IF NOT EXISTS "model_experiment_request_2026_08" PARTITION OF "model_experiment_request"
	FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_experiment_request_2026_09" PARTITION OF "model_experiment_request"
	FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_experiment_request_2026_10" PARTITION OF "model_experiment_request"
	FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
