CREATE TABLE "apple_iap_notifications" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"notification_uuid" text NOT NULL,
	"notification_type" text NOT NULL,
	"subtype" text,
	"environment" text NOT NULL,
	"apple_transaction_id" text,
	"apple_original_transaction_id" text,
	"signed_payload_jws" text NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apple_iap_notifications_environment_check" CHECK ("apple_iap_notifications"."environment" IN ('Sandbox', 'Production'))
);
--> statement-breakpoint
CREATE TABLE "apple_iap_purchases" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_user_id" text NOT NULL,
	"apple_transaction_id" text NOT NULL,
	"apple_original_transaction_id" text NOT NULL,
	"apple_web_order_line_item_id" text,
	"product_id" text NOT NULL,
	"environment" text NOT NULL,
	"bundle_id" text NOT NULL,
	"purchase_date" timestamp with time zone NOT NULL,
	"gross_price_cents" integer NOT NULL,
	"credited_cents" integer NOT NULL,
	"credited_microdollars" bigint NOT NULL,
	"signed_transaction_jws" text NOT NULL,
	"status" text NOT NULL,
	"credit_transaction_id" uuid NOT NULL,
	"refunded_at" timestamp with time zone,
	"refund_credit_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apple_iap_purchases_status_check" CHECK ("apple_iap_purchases"."status" IN ('granted', 'refunded', 'revoked')),
	CONSTRAINT "apple_iap_purchases_environment_check" CHECK ("apple_iap_purchases"."environment" IN ('Sandbox', 'Production')),
	CONSTRAINT "apple_iap_purchases_credited_positive_check" CHECK ("apple_iap_purchases"."credited_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "apple_iap_purchases" ADD CONSTRAINT "apple_iap_purchases_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apple_iap_purchases" ADD CONSTRAINT "apple_iap_purchases_credit_transaction_id_credit_transactions_id_fk" FOREIGN KEY ("credit_transaction_id") REFERENCES "public"."credit_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apple_iap_purchases" ADD CONSTRAINT "apple_iap_purchases_refund_credit_transaction_id_credit_transactions_id_fk" FOREIGN KEY ("refund_credit_transaction_id") REFERENCES "public"."credit_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_apple_iap_notifications_uuid" ON "apple_iap_notifications" USING btree ("notification_uuid");--> statement-breakpoint
CREATE INDEX "IDX_apple_iap_notifications_transaction_id" ON "apple_iap_notifications" USING btree ("apple_transaction_id");--> statement-breakpoint
CREATE INDEX "IDX_apple_iap_notifications_original_transaction_id" ON "apple_iap_notifications" USING btree ("apple_original_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_apple_iap_purchases_transaction_id" ON "apple_iap_purchases" USING btree ("apple_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_apple_iap_purchases_credit_transaction_id" ON "apple_iap_purchases" USING btree ("credit_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "UQ_apple_iap_purchases_refund_credit_transaction_id" ON "apple_iap_purchases" USING btree ("refund_credit_transaction_id") WHERE "apple_iap_purchases"."refund_credit_transaction_id" is not null;--> statement-breakpoint
CREATE INDEX "IDX_apple_iap_purchases_user_id" ON "apple_iap_purchases" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_apple_iap_purchases_original_transaction_id" ON "apple_iap_purchases" USING btree ("apple_original_transaction_id");