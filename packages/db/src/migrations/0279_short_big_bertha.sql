CREATE TABLE "auto_routing_benchmark_holds" (
	"admission_id" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"pair_key" text NOT NULL,
	"model" text NOT NULL,
	"variant" text,
	"estimated_microdollars" bigint NOT NULL,
	"charged_microdollars" bigint,
	"run_id" text,
	"hold_credit_transaction_id" uuid NOT NULL,
	"settlement_credit_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "auto_routing_benchmark_holds_owner_type_owner_id_admission_id_pair_key_pk" PRIMARY KEY("owner_type","owner_id","admission_id","pair_key"),
	CONSTRAINT "auto_routing_benchmark_holds_owner_check" CHECK ("auto_routing_benchmark_holds"."owner_type" IN ('user', 'org')),
	CONSTRAINT "auto_routing_benchmark_holds_amount_check" CHECK ("auto_routing_benchmark_holds"."estimated_microdollars" >= 0 AND ("auto_routing_benchmark_holds"."charged_microdollars" IS NULL OR "auto_routing_benchmark_holds"."charged_microdollars" >= 0)),
	CONSTRAINT "auto_routing_benchmark_holds_settlement_check" CHECK (("auto_routing_benchmark_holds"."charged_microdollars" IS NULL AND "auto_routing_benchmark_holds"."settled_at" IS NULL AND "auto_routing_benchmark_holds"."settlement_credit_transaction_id" IS NULL AND "auto_routing_benchmark_holds"."run_id" IS NULL)
        OR ("auto_routing_benchmark_holds"."charged_microdollars" IS NOT NULL AND "auto_routing_benchmark_holds"."settled_at" IS NOT NULL AND "auto_routing_benchmark_holds"."settlement_credit_transaction_id" IS NOT NULL AND ("auto_routing_benchmark_holds"."charged_microdollars" = 0 OR "auto_routing_benchmark_holds"."run_id" IS NOT NULL)))
);
--> statement-breakpoint
ALTER TABLE "auto_routing_benchmark_holds" ADD CONSTRAINT "auto_routing_benchmark_holds_hold_credit_transaction_id_credit_transactions_id_fk" FOREIGN KEY ("hold_credit_transaction_id") REFERENCES "public"."credit_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_routing_benchmark_holds" ADD CONSTRAINT "auto_routing_benchmark_holds_settlement_credit_transaction_id_credit_transactions_id_fk" FOREIGN KEY ("settlement_credit_transaction_id") REFERENCES "public"."credit_transactions"("id") ON DELETE no action ON UPDATE no action;