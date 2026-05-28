import {
  ArrowDownRight,
  ArrowUpRight,
  GitPullRequest,
  CircleDot,
  type LucideIcon,
} from 'lucide-react';

export type BeadLike = {
  bead_id: string;
  type: string;
  status: string;
  title: string;
  parent_bead_id: string | null;
  rig_id?: string | null;
  metadata: Record<string, unknown>;
};

export type RelatedBead = {
  relation: string;
  label: string;
  icon: LucideIcon;
  bead: BeadLike;
};

type ConvoyLike = {
  id: string;
  title: string;
  feature_branch?: string | null;
  beads: Array<{ bead_id: string; title: string; status: string; rig_id: string | null }>;
  dependency_edges?: Array<{ bead_id: string; depends_on_bead_id: string }>;
};

/**
 * Compute the DAG neighborhood of a bead from the flat list and convoy data.
 * Includes: children, source/review links, blockers, and dependents from convoy DAG.
 */
export function buildRelatedBeads(
  bead: BeadLike,
  allBeads: BeadLike[],
  convoys: ConvoyLike[]
): RelatedBead[] {
  const related: RelatedBead[] = [];

  const convoyId = typeof bead.metadata?.convoy_id === 'string' ? bead.metadata.convoy_id : null;
  const parentConvoy = convoys.find(
    c => c.id === convoyId || c.beads.some(b => b.bead_id === bead.bead_id)
  );

  if (parentConvoy) {
    const edges = parentConvoy.dependency_edges ?? [];
    const blockerIds = new Set(
      edges.filter(e => e.bead_id === bead.bead_id).map(e => e.depends_on_bead_id)
    );
    for (const blockerId of blockerIds) {
      const blockerBead = allBeads.find(b => b.bead_id === blockerId);
      const convoyBead = parentConvoy.beads.find(b => b.bead_id === blockerId);
      if (blockerBead) {
        related.push({
          relation: 'blocker',
          label: 'Blocked by',
          icon: ArrowUpRight,
          bead: blockerBead,
        });
      } else if (convoyBead) {
        related.push({
          relation: 'blocker',
          label: 'Blocked by',
          icon: ArrowUpRight,
          bead: {
            bead_id: convoyBead.bead_id,
            type: 'issue',
            status: convoyBead.status,
            title: convoyBead.title,
            parent_bead_id: null,
            rig_id: convoyBead.rig_id,
            metadata: {},
          },
        });
      }
    }

    const dependentIds = new Set(
      edges.filter(e => e.depends_on_bead_id === bead.bead_id).map(e => e.bead_id)
    );
    for (const depId of dependentIds) {
      const depBead = allBeads.find(b => b.bead_id === depId);
      const convoyBead = parentConvoy.beads.find(b => b.bead_id === depId);
      if (depBead) {
        related.push({
          relation: 'dependent',
          label: 'Blocks',
          icon: ArrowDownRight,
          bead: depBead,
        });
      } else if (convoyBead) {
        related.push({
          relation: 'dependent',
          label: 'Blocks',
          icon: ArrowDownRight,
          bead: {
            bead_id: convoyBead.bead_id,
            type: 'issue',
            status: convoyBead.status,
            title: convoyBead.title,
            parent_bead_id: null,
            rig_id: convoyBead.rig_id,
            metadata: {},
          },
        });
      }
    }
  }

  for (const b of allBeads) {
    if (b.parent_bead_id === bead.bead_id) {
      related.push({ relation: 'child', label: 'Child', icon: ArrowDownRight, bead: b });
    }
  }

  if (bead.type === 'merge_request' && typeof bead.metadata?.source_bead_id === 'string') {
    const source = allBeads.find(b => b.bead_id === bead.metadata.source_bead_id);
    if (source) {
      related.push({ relation: 'source', label: 'Source Work', icon: CircleDot, bead: source });
    }
  }

  if (bead.type !== 'merge_request') {
    for (const b of allBeads) {
      if (b.type === 'merge_request' && b.metadata?.source_bead_id === bead.bead_id) {
        related.push({ relation: 'review', label: 'Review', icon: GitPullRequest, bead: b });
      }
    }
  }

  return related;
}
