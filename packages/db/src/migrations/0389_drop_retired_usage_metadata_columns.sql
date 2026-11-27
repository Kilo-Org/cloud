-- Hand-written per the drop exception in packages/db/AGENTS.md: the generated order drops
-- "system_prompt_prefix" with CASCADE, which locks the busy "microdollar_usage_metadata" for the
-- foreign key, and then fails on the already-dropped constraint.
--
-- Each transaction below locks at most one busy table. Locks are taken with a short wait and
-- retried inside the block: a failed attempt rolls back its subtransaction and releases its
-- locks, so traffic never waits behind the migration for longer than the timeout. Each block is
-- skipped once its columns are gone, so a retried deploy does not take the lock again.
--
-- The usage view depends on the dropped usage columns, so it is dropped and recreated in the same
-- transaction. Dropping "system_prompt_prefix_id" also drops its foreign key, which locks the
-- unused "system_prompt_prefix".
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
DO $$
DECLARE
	attempt int := 0;
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_attribute
		WHERE attrelid = to_regclass('public.microdollar_usage_metadata')
			AND attname IN ('user_prompt_prefix', 'system_prompt_prefix_id', 'abuse_delay', 'abuse_downgraded_from')
			AND NOT attisdropped
	) THEN
		RETURN;
	END IF;
	LOOP
		BEGIN
			DROP VIEW IF EXISTS "public"."microdollar_usage_view";
			ALTER TABLE "microdollar_usage_metadata" DROP COLUMN IF EXISTS "user_prompt_prefix";
			ALTER TABLE "microdollar_usage_metadata" DROP COLUMN IF EXISTS "system_prompt_prefix_id";
			ALTER TABLE "microdollar_usage_metadata" DROP COLUMN IF EXISTS "abuse_delay";
			ALTER TABLE "microdollar_usage_metadata" DROP COLUMN IF EXISTS "abuse_downgraded_from";
			CREATE VIEW "public"."microdollar_usage_view" AS (
			  SELECT
			    mu.id,
			    mu.kilo_user_id,
			    meta.message_id,
			    mu.cost,
			    mu.input_tokens,
			    mu.output_tokens,
			    mu.cache_write_tokens,
			    mu.cache_hit_tokens,
			    mu.created_at,
			    ip.http_ip AS http_x_forwarded_for,
			    city.vercel_ip_city AS http_x_vercel_ip_city,
			    country.vercel_ip_country AS http_x_vercel_ip_country,
			    meta.vercel_ip_latitude AS http_x_vercel_ip_latitude,
			    meta.vercel_ip_longitude AS http_x_vercel_ip_longitude,
			    ja4.ja4_digest AS http_x_vercel_ja4_digest,
			    mu.provider,
			    mu.model,
			    mu.requested_model,
			    meta.system_prompt_length,
			    ua.http_user_agent,
			    mu.cache_discount,
			    meta.max_tokens,
			    meta.has_middle_out_transform,
			    mu.has_error,
			    mu.abuse_classification,
			    mu.organization_id,
			    mu.inference_provider,
			    mu.project_id,
			    meta.status_code,
			    meta.upstream_id,
			    frfr.finish_reason,
			    meta.latency,
			    meta.moderation_latency,
			    meta.generation_time,
			    meta.is_byok,
			    meta.is_user_byok,
			    meta.streamed,
			    meta.cancelled,
			    edit.editor_name,
			    ak.api_kind,
			    meta.has_tools,
			    meta.machine_id,
			    feat.feature,
			    meta.session_id,
			    md.mode,
			    am.auto_model,
			    rs.reasoning_setting,
			    meta.market_cost,
			    meta.non_inference_cost,
			    meta.is_free,
			    spk.system_prompt_kind
			  FROM "microdollar_usage" mu
			  LEFT JOIN "microdollar_usage_metadata" meta ON mu.id = meta.id
			  LEFT JOIN "http_ip" ip ON meta.http_ip_id = ip.http_ip_id
			  LEFT JOIN "vercel_ip_city" city ON meta.vercel_ip_city_id = city.vercel_ip_city_id
			  LEFT JOIN "vercel_ip_country" country ON meta.vercel_ip_country_id = country.vercel_ip_country_id
			  LEFT JOIN "ja4_digest" ja4 ON meta.ja4_digest_id = ja4.ja4_digest_id
			  LEFT JOIN "http_user_agent" ua ON meta.http_user_agent_id = ua.http_user_agent_id
			  LEFT JOIN "finish_reason" frfr ON meta.finish_reason_id = frfr.finish_reason_id
			  LEFT JOIN "editor_name" edit ON meta.editor_name_id = edit.editor_name_id
			  LEFT JOIN "api_kind" ak ON meta.api_kind_id = ak.api_kind_id
			  LEFT JOIN "feature" feat ON meta.feature_id = feat.feature_id
			  LEFT JOIN "mode" md ON meta.mode_id = md.mode_id
			  LEFT JOIN "auto_model" am ON meta.auto_model_id = am.auto_model_id
			  LEFT JOIN "reasoning_setting" rs ON meta.reasoning_setting_id = rs.reasoning_setting_id
			  LEFT JOIN "system_prompt_kind" spk ON meta.system_prompt_kind_id = spk.system_prompt_kind_id
			);
			RETURN;
		EXCEPTION WHEN lock_not_available THEN
			attempt := attempt + 1;
			IF attempt >= 10 THEN
				RAISE;
			END IF;
			PERFORM pg_sleep(least(attempt, 5));
		END;
	END LOOP;
END $$;--> statement-breakpoint
COMMIT;--> statement-breakpoint
BEGIN;--> statement-breakpoint
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
DROP TABLE IF EXISTS "system_prompt_prefix";--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
