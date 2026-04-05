import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { db } from '@/lib/drizzle';
import { sql } from 'drizzle-orm';
import type { GroupByDimension, GroupedData, HeuristicAnalysisResponse } from '../types';
import { ABUSE_CLASSIFICATION } from '@/types/AbuseClassification';

const DIMENSION_MAPPINGS = {
  day: { sql: 'DATE(created_at)', select: (i: number) => `DATE(created_at) as group_${i}` },
  week: {
    sql: "DATE_TRUNC('week', created_at)",
    select: (i: number) => `DATE_TRUNC('week', created_at) as group_${i}`,
  },
  month: {
    sql: "DATE_TRUNC('month', created_at)",
    select: (i: number) => `DATE_TRUNC('month', created_at) as group_${i}`,
  },
  userAgent: { sql: 'http_user_agent', select: (i: number) => `http_user_agent as group_${i}` },
  model: { sql: 'model', select: (i: number) => `model as group_${i}` },
} as const;

export async function GET(request: NextRequest): Promise<NextResponse<HeuristicAnalysisResponse>> {
  try {
    const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
    if (authFailedResponse) return authFailedResponse;

    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('userId');
    const groupByParam = searchParams.get('groupBy');

    if (!userId) {
      return NextResponse.json({ error: 'userId parameter is required' }, { status: 400 });
    }

    if (!groupByParam) {
      return NextResponse.json({ error: 'groupBy is required' }, { status: 400 });
    }

    const groupByDimensions = groupByParam.split(',').map(dim => dim.trim()) as GroupByDimension[];

    const validDimensions: GroupByDimension[] = ['day', 'week', 'month', 'userAgent', 'model'];
    const invalidDimensions = groupByDimensions.filter(dim => !validDimensions.includes(dim));
    if (invalidDimensions.length > 0) {
      return NextResponse.json(
        {
          error: `Invalid groupBy dimensions: ${invalidDimensions.join(', ')}`,
        },
        { status: 400 }
      );
    }

    const selectClause = groupByDimensions
      .map((dimension, index) => DIMENSION_MAPPINGS[dimension].select(index))
      .join(', ');

    const groupByClause = groupByDimensions
      .map(dimension => DIMENSION_MAPPINGS[dimension].sql)
      .join(', ');

    const orderByClause = groupByDimensions
      .map(
        dimension =>
          DIMENSION_MAPPINGS[dimension].sql +
          (dimension === 'day' || dimension === 'week' || dimension === 'month' ? ' desc' : ' asc')
      )
      .join(', ');

    const query = sql`
      SELECT
        ${sql.raw(selectClause)},
        computed.likely_abuse,
        COUNT(*) as count,
        SUM(cost) / 1000000.0 as cost_dollars,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens
      FROM microdollar_usage_view
      CROSS JOIN LATERAL (
        SELECT
          CASE
            WHEN abuse_classification > ${ABUSE_CLASSIFICATION.NOT_CLASSIFIED} THEN true
            WHEN abuse_classification < ${ABUSE_CLASSIFICATION.CLASSIFICATION_ERROR} THEN false
            ELSE null
          END as likely_abuse
      ) computed
      WHERE kilo_user_id = ${userId}
      GROUP BY ${sql.raw(groupByClause)}, computed.likely_abuse
      order by ${sql.raw(orderByClause)}
    `;

    const groupedResults = await db.execute(query);

    const transformedData: GroupedData[] = groupedResults.rows.map(row => {
      const rowData = row as Record<string, string | number | boolean | null>;

      const keyParts: string[] = [];
      for (let i = 0; i < groupByDimensions.length; i++) {
        const dimension = groupByDimensions[i];
        const value = rowData[`group_${i}`];
        keyParts.push(`${dimension}:${String(value ?? 'null')}`);
      }
      keyParts.push(`likelyAbuse:${String(rowData.likely_abuse)}`);

      return {
        groupKey: keyParts.join('|'),
        count: Number(rowData.count),
        costDollars: Number(rowData.cost_dollars),
        inputTokens: Number(rowData.input_tokens),
        outputTokens: Number(rowData.output_tokens),
        likelyAbuse: rowData.likely_abuse as boolean | null,
      };
    });

    return NextResponse.json({ data: transformedData });
  } catch (error) {
    console.error('Error in grouped heuristic analysis:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
