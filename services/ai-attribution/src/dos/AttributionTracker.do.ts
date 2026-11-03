import { DurableObject } from 'cloudflare:workers';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { eq, and, sql, desc } from 'drizzle-orm';
import { logger } from '../util/logger';
import {
  attributionsMetadata,
  linesAdded,
  linesRemoved,
  type AttributionsMetadataInsert,
  type AttributionsMetadataSelect,
  type LinesAddedInsert,
  type LinesAddedSelect,
  type LinesRemovedInsert,
  type LinesRemovedSelect,
} from '../db/sqlite-schema';
import migrations from '../../drizzle/migrations';
import type { AttributionsTrackRequestBody } from '../schemas';

/**
 * The logical target a request asks about. Rows store these labels, so every read
 * and delete names the target it answers for.
 */
export type AttributionTarget = {
  organization_id: string;
  project_id: string;
  file_path: string;
};

/** Totals over a set of stored attributions. */
export type AttributionSummary = {
  total_attributions: number;
  total_lines_added: number;
  total_lines_removed: number;
  by_status: Record<string, number>;
  by_branch: Record<string, number>;
};

/** One stored attribution with its line records, as the debug listing serves it. */
export type AttributionDebugRow = AttributionsMetadataSelect & {
  lines_added: LinesAddedSelect[];
  lines_removed: LinesRemovedSelect[];
};

type SummaryCounts = {
  attributions: number;
  linesAdded: number;
  linesRemoved: number;
  byStatus: Map<string, number>;
  byBranch: Map<string, number>;
};

function emptyCounts(): SummaryCounts {
  return {
    attributions: 0,
    linesAdded: 0,
    linesRemoved: 0,
    byStatus: new Map(),
    byBranch: new Map(),
  };
}

function countRow(
  counts: SummaryCounts,
  metadata: AttributionsMetadataSelect,
  linesAddedCount: number,
  linesRemovedCount: number
): void {
  counts.attributions += 1;
  counts.linesAdded += linesAddedCount;
  counts.linesRemoved += linesRemovedCount;
  counts.byStatus.set(metadata.status, (counts.byStatus.get(metadata.status) ?? 0) + 1);
  counts.byBranch.set(metadata.branch, (counts.byBranch.get(metadata.branch) ?? 0) + 1);
}

function summarize(counts: SummaryCounts): AttributionSummary {
  return {
    total_attributions: counts.attributions,
    total_lines_added: counts.linesAdded,
    total_lines_removed: counts.linesRemoved,
    by_status: Object.fromEntries(counts.byStatus),
    by_branch: Object.fromEntries(counts.byBranch),
  };
}

/** True when a stored row carries exactly this target's labels. */
function matchesTarget(
  row: {
    organization_id: string | null;
    project_id: string;
    file_path: string;
  },
  target: AttributionTarget
): boolean {
  return (
    row.organization_id === target.organization_id &&
    row.project_id === target.project_id &&
    row.file_path === target.file_path
  );
}

export class AttributionTrackerDO extends DurableObject<Env> {
  private db: DrizzleSqliteDODatabase;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });
    void this.ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
      logger.info('Database migrated');
    });
  }

  clearAllData() {
    this.db.delete(linesAdded).run();
    this.db.delete(linesRemoved).run();
    this.db.delete(attributionsMetadata).run();
  }

  deleteAttribution(target: AttributionTarget, id: number): boolean {
    const existing = this.db
      .select({ id: attributionsMetadata.id })
      .from(attributionsMetadata)
      .where(
        and(
          eq(attributionsMetadata.id, id),
          eq(attributionsMetadata.organization_id, target.organization_id),
          eq(attributionsMetadata.project_id, target.project_id),
          eq(attributionsMetadata.file_path, target.file_path)
        )
      )
      .all();

    if (existing.length === 0) {
      return false;
    }

    this.db.delete(linesAdded).where(eq(linesAdded.attributions_metadata_id, id)).run();
    this.db.delete(linesRemoved).where(eq(linesRemoved.attributions_metadata_id, id)).run();
    this.db.delete(attributionsMetadata).where(eq(attributionsMetadata.id, id)).run();

    logger.info('Attribution deleted', { id });
    return true;
  }

  insertAttributionMetadata(data: AttributionsMetadataInsert): AttributionsMetadataSelect {
    return this.db.insert(attributionsMetadata).values(data).returning().get();
  }

  insertLinesAdded(data: LinesAddedInsert): LinesAddedSelect {
    return this.db.insert(linesAdded).values(data).returning().get();
  }

  insertLinesRemoved(data: LinesRemovedInsert): LinesRemovedSelect {
    return this.db.insert(linesRemoved).values(data).returning().get();
  }

  trackAttribution(
    params: AttributionsTrackRequestBody & { user_id: string; organization_id: string }
  ): AttributionsMetadataSelect & { linesAdded: number; linesRemoved: number } {
    const metadata = this.insertAttributionMetadata(params);
    const attributionId = metadata.id;

    for (const line of params.lines_added) {
      this.insertLinesAdded({
        attributions_metadata_id: attributionId,
        line_number: line.line_number,
        line_hash: line.line_hash,
      });
    }

    for (const line of params.lines_removed) {
      this.insertLinesRemoved({
        attributions_metadata_id: attributionId,
        line_number: line.line_number,
        line_hash: line.line_hash,
      });
    }

    logger.info('Attribution tracked', {
      ...metadata,
      linesAdded: params.lines_added.length,
      linesRemoved: params.lines_removed.length,
    });

    return {
      ...metadata,
      linesAdded: params.lines_added.length,
      linesRemoved: params.lines_removed.length,
    };
  }

  /**
   * @deprecated Use getAttributionEvents() for flexible retention calculation
   */
  getLinesAddedByHash(target: AttributionTarget, branch?: string): Record<string, number[]> {
    const branchPattern = branch ?? '*';

    const rows = this.db
      .select({
        line_hash: linesAdded.line_hash,
        line_number: linesAdded.line_number,
      })
      .from(linesAdded)
      .innerJoin(
        attributionsMetadata,
        eq(linesAdded.attributions_metadata_id, attributionsMetadata.id)
      )
      .where(
        and(
          eq(attributionsMetadata.status, 'accepted'),
          eq(attributionsMetadata.organization_id, target.organization_id),
          eq(attributionsMetadata.project_id, target.project_id),
          eq(attributionsMetadata.file_path, target.file_path),
          sql`${attributionsMetadata.branch} GLOB ${branchPattern}`
        )
      )
      .orderBy(linesAdded.line_hash, linesAdded.line_number)
      .all();

    const lineNumbersByHash = new Map<string, number[]>();
    for (const row of rows) {
      const lineNumbers = lineNumbersByHash.get(row.line_hash);
      if (lineNumbers) {
        lineNumbers.push(row.line_number);
      } else {
        lineNumbersByHash.set(row.line_hash, [row.line_number]);
      }
    }

    return Object.fromEntries(lineNumbersByHash);
  }

  getAttributionEvents(
    target: AttributionTarget,
    branch?: string
  ): Array<{ id: number; taskId: string | null; lineHashes: string[] }> {
    const branchPattern = branch ?? '*';

    const metadataRows = this.db
      .select({
        id: attributionsMetadata.id,
        task_id: attributionsMetadata.task_id,
      })
      .from(attributionsMetadata)
      .where(
        and(
          eq(attributionsMetadata.status, 'accepted'),
          eq(attributionsMetadata.organization_id, target.organization_id),
          eq(attributionsMetadata.project_id, target.project_id),
          eq(attributionsMetadata.file_path, target.file_path),
          sql`${attributionsMetadata.branch} GLOB ${branchPattern}`
        )
      )
      .orderBy(attributionsMetadata.created_at)
      .all();

    const result: Array<{ id: number; taskId: string | null; lineHashes: string[] }> = [];

    for (const metadata of metadataRows) {
      const lineRows = this.db
        .select({ line_hash: linesAdded.line_hash })
        .from(linesAdded)
        .where(eq(linesAdded.attributions_metadata_id, metadata.id))
        .orderBy(linesAdded.line_number)
        .all();

      result.push({
        id: metadata.id,
        taskId: metadata.task_id,
        lineHashes: lineRows.map(r => r.line_hash),
      });
    }

    return result;
  }

  /**
   * The listed attributions belong to `target`, and so does `summary`, so the
   * admin panel's totals describe the rows it shows. `instance_summary` keeps the
   * totals of the whole object, which another target sharing this instance
   * contributes to.
   */
  getDebugData(target: AttributionTarget): {
    attributions: AttributionDebugRow[];
    summary: AttributionSummary;
    instance_summary: AttributionSummary;
  } {
    const metadataRows = this.db
      .select()
      .from(attributionsMetadata)
      .orderBy(desc(attributionsMetadata.created_at))
      .all();

    const attributions: AttributionDebugRow[] = [];
    const targetCounts = emptyCounts();
    const instanceCounts = emptyCounts();

    for (const metadata of metadataRows) {
      const linesAddedRows = this.db
        .select()
        .from(linesAdded)
        .where(eq(linesAdded.attributions_metadata_id, metadata.id))
        .orderBy(linesAdded.line_number)
        .all();

      const linesRemovedRows = this.db
        .select()
        .from(linesRemoved)
        .where(eq(linesRemoved.attributions_metadata_id, metadata.id))
        .orderBy(linesRemoved.line_number)
        .all();

      countRow(instanceCounts, metadata, linesAddedRows.length, linesRemovedRows.length);

      if (!matchesTarget(metadata, target)) {
        continue;
      }

      countRow(targetCounts, metadata, linesAddedRows.length, linesRemovedRows.length);

      attributions.push({
        ...metadata,
        lines_added: linesAddedRows,
        lines_removed: linesRemovedRows,
      });
    }

    return {
      attributions,
      summary: summarize(targetCounts),
      instance_summary: summarize(instanceCounts),
    };
  }
}

/**
 * The instance name for a target. It joins the labels, so two different targets
 * can land on one instance; every operation therefore carries its own target and
 * acts only on the rows that match it.
 */
export function attributionTrackerKey(target: AttributionTarget): string {
  return `${target.organization_id}/${target.project_id}/${target.file_path}`;
}

export function getAttributionTrackerDO(
  env: Env,
  target: AttributionTarget
): DurableObjectStub<AttributionTrackerDO> {
  const id = env.ATTRIBUTION_TRACKER.idFromName(attributionTrackerKey(target));
  return env.ATTRIBUTION_TRACKER.get(id);
}
