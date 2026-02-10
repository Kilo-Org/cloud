DROP VIEW "public"."microdollar_usage_view";--> statement-breakpoint
ALTER TABLE "microdollar_usage_metadata" ADD COLUMN "machine_id" text;--> statement-breakpoint
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
    meta.user_prompt_prefix,
    spp.system_prompt_prefix,
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
    meta.has_tools,
    meta.machine_id
  FROM "microdollar_usage" mu
  LEFT JOIN "microdollar_usage_metadata" meta ON mu.id = meta.id
  LEFT JOIN "http_ip" ip ON meta.http_ip_id = ip.http_ip_id
  LEFT JOIN "vercel_ip_city" city ON meta.vercel_ip_city_id = city.vercel_ip_city_id
  LEFT JOIN "vercel_ip_country" country ON meta.vercel_ip_country_id = country.vercel_ip_country_id
  LEFT JOIN "ja4_digest" ja4 ON meta.ja4_digest_id = ja4.ja4_digest_id
  LEFT JOIN "system_prompt_prefix" spp ON meta.system_prompt_prefix_id = spp.system_prompt_prefix_id
  LEFT JOIN "http_user_agent" ua ON meta.http_user_agent_id = ua.http_user_agent_id
  LEFT JOIN "finish_reason" frfr ON meta.finish_reason_id = frfr.finish_reason_id
  LEFT JOIN "editor_name" edit ON meta.editor_name_id = edit.editor_name_id
);