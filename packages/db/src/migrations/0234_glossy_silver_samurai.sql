ALTER TABLE "organization_alert_deliveries" DROP CONSTRAINT "organization_alert_deliveries_spend_check";--> statement-breakpoint
ALTER TABLE "organization_alerts" DROP CONSTRAINT "organization_alerts_type_check";--> statement-breakpoint
ALTER TABLE "organization_alert_deliveries" ALTER COLUMN "measured_spend_microdollars" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "organization_alert_deliveries" ADD COLUMN "measured_value_microdollars" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_alert_deliveries" ADD CONSTRAINT "organization_alert_deliveries_measured_value_check" CHECK ("organization_alert_deliveries"."threshold_microdollars" > 0 AND "organization_alert_deliveries"."measured_value_microdollars" >= 0);--> statement-breakpoint
ALTER TABLE "organization_alerts" ADD CONSTRAINT "organization_alerts_type_check" CHECK ("organization_alerts"."type" IN ('monthly_spending', 'low_balance'));