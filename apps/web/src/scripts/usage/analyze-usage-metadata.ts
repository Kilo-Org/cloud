import { closeAllDrizzleConnections, db } from '@/lib/drizzle';
import { shutdownPosthog } from '@/lib/posthog';
import { sql } from 'drizzle-orm';

export async function run() {
  console.log('Analyzing usage metadata distribution...\n');

  // microdollar_usage analysis
  const usageStats = await db.execute(sql`
    SELECT
      COUNT(*)::float as total_rows,
      COUNT(DISTINCT kilo_user_id)::float as unique_user_count,
      -- String columns: provider, model, requested_model, inference_provider, project_id
      AVG(LENGTH(provider))::float as provider_avg_len,
      MIN(LENGTH(provider))::float as provider_min_len,
      MAX(LENGTH(provider))::float as provider_max_len,
      (COUNT(*) FILTER (WHERE provider IS NULL) * 100.0 / COUNT(*))::float as provider_null_pct,
      
      AVG(LENGTH(model))::float as model_avg_len,
      MIN(LENGTH(model))::float as model_min_len,
      MAX(LENGTH(model))::float as model_max_len,
      (COUNT(*) FILTER (WHERE model IS NULL) * 100.0 / COUNT(*))::float as model_null_pct,
      
      AVG(LENGTH(requested_model))::float as requested_model_avg_len,
      MIN(LENGTH(requested_model))::float as requested_model_min_len,
      MAX(LENGTH(requested_model))::float as requested_model_max_len,
      (COUNT(*) FILTER (WHERE requested_model IS NULL) * 100.0 / COUNT(*))::float as requested_model_null_pct,
      
      AVG(LENGTH(inference_provider))::float as inference_provider_avg_len,
      MIN(LENGTH(inference_provider))::float as inference_provider_min_len,
      MAX(LENGTH(inference_provider))::float as inference_provider_max_len,
      (COUNT(*) FILTER (WHERE inference_provider IS NULL) * 100.0 / COUNT(*))::float as inference_provider_null_pct,
      
      AVG(LENGTH(project_id))::float as project_id_avg_len,
      MIN(LENGTH(project_id))::float as project_id_min_len,
      MAX(LENGTH(project_id))::float as project_id_max_len,
      (COUNT(*) FILTER (WHERE project_id IS NULL) * 100.0 / COUNT(*))::float as project_id_null_pct,
      
      -- Numeric columns null percentages
      (COUNT(*) FILTER (WHERE cache_discount IS NULL) * 100.0 / COUNT(*))::float as cache_discount_null_pct,
      (COUNT(*) FILTER (WHERE organization_id IS NULL) * 100.0 / COUNT(*))::float as organization_id_null_pct,
      
      -- Numeric stats
      AVG(cost)::float as cost_avg,
      MIN(cost)::float as cost_min,
      MAX(cost)::float as cost_max,
      AVG(input_tokens)::float as input_tokens_avg,
      AVG(output_tokens)::float as output_tokens_avg,
      AVG(cache_write_tokens)::float as cache_write_tokens_avg,
      AVG(cache_hit_tokens)::float as cache_hit_tokens_avg
    FROM microdollar_usage
  `);

  // microdollar_usage_metadata analysis
  const metadataStats = await db.execute(sql`
    SELECT
      COUNT(*)::float as total_rows,
      -- String columns
      AVG(LENGTH(message_id))::float as message_id_avg_len,
      MIN(LENGTH(message_id))::float as message_id_min_len,
      MAX(LENGTH(message_id))::float as message_id_max_len,
      
      AVG(LENGTH(user_prompt_prefix))::float as user_prompt_prefix_avg_len,
      MIN(LENGTH(user_prompt_prefix))::float as user_prompt_prefix_min_len,
      MAX(LENGTH(user_prompt_prefix))::float as user_prompt_prefix_max_len,
      (COUNT(*) FILTER (WHERE user_prompt_prefix IS NULL) * 100.0 / COUNT(*))::float as user_prompt_prefix_null_pct,
      
      -- FK null percentages
      (COUNT(*) FILTER (WHERE http_user_agent_id IS NULL) * 100.0 / COUNT(*))::float as http_user_agent_id_null_pct,
      (COUNT(*) FILTER (WHERE http_ip_id IS NULL) * 100.0 / COUNT(*))::float as http_ip_id_null_pct,
      (COUNT(*) FILTER (WHERE vercel_ip_city_id IS NULL) * 100.0 / COUNT(*))::float as vercel_ip_city_id_null_pct,
      (COUNT(*) FILTER (WHERE vercel_ip_country_id IS NULL) * 100.0 / COUNT(*))::float as vercel_ip_country_id_null_pct,
      (COUNT(*) FILTER (WHERE ja4_digest_id IS NULL) * 100.0 / COUNT(*))::float as ja4_digest_id_null_pct,
      (COUNT(*) FILTER (WHERE system_prompt_prefix_id IS NULL) * 100.0 / COUNT(*))::float as system_prompt_prefix_id_null_pct,
      
      -- Other nullable columns
      (COUNT(*) FILTER (WHERE vercel_ip_latitude IS NULL) * 100.0 / COUNT(*))::float as vercel_ip_latitude_null_pct,
      (COUNT(*) FILTER (WHERE vercel_ip_longitude IS NULL) * 100.0 / COUNT(*))::float as vercel_ip_longitude_null_pct,
      (COUNT(*) FILTER (WHERE system_prompt_length IS NULL) * 100.0 / COUNT(*))::float as system_prompt_length_null_pct,
      (COUNT(*) FILTER (WHERE max_tokens IS NULL) * 100.0 / COUNT(*))::float as max_tokens_null_pct,
      (COUNT(*) FILTER (WHERE has_middle_out_transform IS NULL) * 100.0 / COUNT(*))::float as has_middle_out_transform_null_pct,
      
      -- Numeric stats
      AVG(system_prompt_length)::float as system_prompt_length_avg,
      MIN(system_prompt_length)::float as system_prompt_length_min,
      MAX(system_prompt_length)::float as system_prompt_length_max,
      AVG(max_tokens)::float as max_tokens_avg
    FROM microdollar_usage_metadata
  `);

  // Deduplication tables analysis
  const dedupStats = await db.execute(sql`
    SELECT
      (SELECT COUNT(*)::float FROM http_user_agent) as http_user_agent_count,
      (SELECT AVG(LENGTH(http_user_agent))::float FROM http_user_agent) as http_user_agent_avg_len,
      (SELECT MIN(LENGTH(http_user_agent))::float FROM http_user_agent) as http_user_agent_min_len,
      (SELECT MAX(LENGTH(http_user_agent))::float FROM http_user_agent) as http_user_agent_max_len,
      
      (SELECT COUNT(*)::float FROM http_ip) as http_ip_count,
      (SELECT AVG(LENGTH(http_ip))::float FROM http_ip) as http_ip_avg_len,
      (SELECT MIN(LENGTH(http_ip))::float FROM http_ip) as http_ip_min_len,
      (SELECT MAX(LENGTH(http_ip))::float FROM http_ip) as http_ip_max_len,
      
      (SELECT COUNT(*)::float FROM vercel_ip_country) as vercel_ip_country_count,
      (SELECT AVG(LENGTH(vercel_ip_country))::float FROM vercel_ip_country) as vercel_ip_country_avg_len,
      (SELECT MIN(LENGTH(vercel_ip_country))::float FROM vercel_ip_country) as vercel_ip_country_min_len,
      (SELECT MAX(LENGTH(vercel_ip_country))::float FROM vercel_ip_country) as vercel_ip_country_max_len,
      
      (SELECT COUNT(*)::float FROM vercel_ip_city) as vercel_ip_city_count,
      (SELECT AVG(LENGTH(vercel_ip_city))::float FROM vercel_ip_city) as vercel_ip_city_avg_len,
      (SELECT MIN(LENGTH(vercel_ip_city))::float FROM vercel_ip_city) as vercel_ip_city_min_len,
      (SELECT MAX(LENGTH(vercel_ip_city))::float FROM vercel_ip_city) as vercel_ip_city_max_len,
      
      (SELECT COUNT(*)::float FROM ja4_digest) as ja4_digest_count,
      (SELECT AVG(LENGTH(ja4_digest))::float FROM ja4_digest) as ja4_digest_avg_len,
      (SELECT MIN(LENGTH(ja4_digest))::float FROM ja4_digest) as ja4_digest_min_len,
      (SELECT MAX(LENGTH(ja4_digest))::float FROM ja4_digest) as ja4_digest_max_len,
      
      (SELECT COUNT(*)::float FROM system_prompt_prefix) as system_prompt_prefix_count,
      (SELECT AVG(LENGTH(system_prompt_prefix))::float FROM system_prompt_prefix) as system_prompt_prefix_avg_len,
      (SELECT MIN(LENGTH(system_prompt_prefix))::float FROM system_prompt_prefix) as system_prompt_prefix_min_len,
      (SELECT MAX(LENGTH(system_prompt_prefix))::float FROM system_prompt_prefix) as system_prompt_prefix_max_len
  `);

  const report = {
    generated_at: new Date().toISOString(),
    microdollar_usage: usageStats.rows[0],
    microdollar_usage_metadata: metadataStats.rows[0],
    deduplication_tables: dedupStats.rows[0],
  };

  console.log(JSON.stringify(report, null, 2));
}

run()
  .catch(err => {
    console.error('Fatal error:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await closeAllDrizzleConnections();
      await shutdownPosthog();
    } catch (err) {
      console.error('Error during cleanup:', err);
    }
  });
