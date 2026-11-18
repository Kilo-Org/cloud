import type { DeciderCase } from '../decider-cases';

const FRONTIER_SYSTEM =
  'You are a precise software engineer. Solve the supplied finite refactoring or design problem completely. Reply with only the requested JSON; no markdown, explanation, or extra keys. Respect the specified key and array order.';

export const PLANNING_DESIGN_FRONTIER_CASES: readonly DeciderCase[] = [
  {
    id: 'frontier-planning_design-architecture-design-stateful-api-zonal-failover',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Design the stateful-api-zonal-failover replicated deployment. The exact optimum is required; all numbers are integer costs, not estimates. Services, hosts and pair choices are indexed from zero in their manifest order.

Normative design constraints, taking priority over the team's obsolete "place everything cheapest, then add failover" heuristic:
* Every service gets exactly one pair from pairs, selected by its pair INDEX from allowed[service]. Both replicas consume size[service] on their hosts for the entire deployment. Host total load <= capacity. The pair contains hosts from different zone values; primary is the numerically lower host, regardless of price or distance.
* A separate [a,b] pair must have DISJOINT replica-host sets. A together pair must select the SAME pair index. pinned [service,host] fixes that service's primary host, not just one replica. All constraints apply simultaneously.
* Each communication edge [source,target,weight] contributes weight*distance[primary(source)][primary(target)] to nominal traffic. Count every edge.
* Consider each SINGLE host failure independently, hosts 0 through 3, including a host with no load. Affected services activate their lowest-numbered surviving replica; unaffected services keep their existing primary. Recompute total weighted communication traffic under that failure. worstFailure is the maximum of these four totals and MUST be <= failoverLimit. Do not substitute a zone outage, minimize each edge independently, or choose alternate primaries opportunistically.
* cost = sum over hosts(load*price). imbalance = maximum host load minus minimum host load, including empty hosts. All listed metrics in priority are minimized lexicographically in their given order, THEN minimize the pair-index vector lexicographically in services order. An unlisted metric must never precede this last tie-break.

Service/resource manifest, placement constraints and traffic graph:
{"services":["gateway","auth","ledger","cache","worker","audit","index","observer"],"hosts":["west-a","west-b","east-a","east-b"],"zone":[0,0,1,1],"size":[3,3,2,1,2,1,2,1],"capacity":[12,13,13,12],"pairs":[[0,2],[0,3],[1,2],[1,3]],"allowed":[[0,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,1,3]],"separate":[[0,2],[1,4]],"together":[[3,5]],"pinned":[[0,0]],"edges":[[0,2,3],[1,4,2],[3,1,2],[6,3,1],[7,6,3],[1,2,1],[0,1,2],[2,1,5],[1,5,2]],"distance":[[0,1,5,7],[1,0,6,4],[5,6,0,1],[7,4,1,0]],"price":[3,3,4,2],"failoverLimit":170,"priority":["cost","traffic"]}

Return ONLY JSON with exactly keys "pairs","loads","cost","traffic","imbalance","worstFailure" in that order. pairs is the chosen pair-INDEX vector, NOT an array of host pairs. loads is in hosts order. Supply the unique globally optimal design under the tie-break above.`,
    check: {
      kind: 'json_equal',
      value: {
        pairs: [0, 3, 3, 3, 0, 3, 3, 3],
        loads: [5, 10, 5, 10],
        cost: 85,
        traffic: 7,
        imbalance: 5,
        worstFailure: 49,
      },
    },
  },
  {
    id: 'frontier-planning_design-architecture-design-cold-start-model-serving',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Design the cold-start-model-serving replicated deployment. The exact optimum is required; all numbers are integer costs, not estimates. Services, hosts and pair choices are indexed from zero in their manifest order.

Normative design constraints, taking priority over the team's obsolete "place everything cheapest, then add failover" heuristic:
* Every service gets exactly one pair from pairs, selected by its pair INDEX from allowed[service]. Both replicas consume size[service] on their hosts for the entire deployment. Host total load <= capacity. The pair contains hosts from different zone values; primary is the numerically lower host, regardless of price or distance.
* A separate [a,b] pair must have DISJOINT replica-host sets. A together pair must select the SAME pair index. pinned [service,host] fixes that service's primary host, not just one replica. All constraints apply simultaneously.
* Each communication edge [source,target,weight] contributes weight*distance[primary(source)][primary(target)] to nominal traffic. Count every edge.
* Consider each SINGLE host failure independently, hosts 0 through 3, including a host with no load. Affected services activate their lowest-numbered surviving replica; unaffected services keep their existing primary. Recompute total weighted communication traffic under that failure. worstFailure is the maximum of these four totals and MUST be <= failoverLimit. Do not substitute a zone outage, minimize each edge independently, or choose alternate primaries opportunistically.
* cost = sum over hosts(load*price). imbalance = maximum host load minus minimum host load, including empty hosts. All listed metrics in priority are minimized lexicographically in their given order, THEN minimize the pair-index vector lexicographically in services order. An unlisted metric must never precede this last tie-break.

Service/resource manifest, placement constraints and traffic graph:
{"services":["gateway","auth","ledger","cache","worker","audit","index","observer"],"hosts":["west-a","west-b","east-a","east-b"],"zone":[0,0,1,1],"size":[2,4,2,1,2,1,3,1],"capacity":[12,13,13,12],"pairs":[[0,2],[0,3],[1,2],[1,3]],"allowed":[[0,1,2,3],[0,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,2,3]],"separate":[[0,2],[1,4]],"together":[],"pinned":[[0,0]],"edges":[[0,2,4],[1,4,3],[3,2,1],[2,0,2],[6,1,3],[7,5,6],[4,7,4],[4,3,6],[0,5,4],[3,1,3]],"distance":[[0,1,5,7],[1,0,6,4],[5,6,0,1],[7,4,1,0]],"price":[4,2,5,1],"failoverLimit":185,"priority":["traffic","cost"]}

Return ONLY JSON with exactly keys "pairs","loads","cost","traffic","imbalance","worstFailure" in that order. pairs is the chosen pair-INDEX vector, NOT an array of host pairs. loads is in hosts order. Supply the unique globally optimal design under the tie-break above.`,
    check: {
      kind: 'json_equal',
      value: {
        pairs: [0, 3, 3, 1, 0, 1, 3, 0],
        loads: [7, 9, 5, 11],
        cost: 82,
        traffic: 13,
        imbalance: 6,
        worstFailure: 91,
      },
    },
  },
  {
    id: 'frontier-planning_design-architecture-design-token-vault-primary-fencing',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Design the token-vault-primary-fencing replicated deployment. The exact optimum is required; all numbers are integer costs, not estimates. Services, hosts and pair choices are indexed from zero in their manifest order.

Normative design constraints, taking priority over the team's obsolete "place everything cheapest, then add failover" heuristic:
* Every service gets exactly one pair from pairs, selected by its pair INDEX from allowed[service]. Both replicas consume size[service] on their hosts for the entire deployment. Host total load <= capacity. The pair contains hosts from different zone values; primary is the numerically lower host, regardless of price or distance.
* A separate [a,b] pair must have DISJOINT replica-host sets. A together pair must select the SAME pair index. pinned [service,host] fixes that service's primary host, not just one replica. All constraints apply simultaneously.
* Each communication edge [source,target,weight] contributes weight*distance[primary(source)][primary(target)] to nominal traffic. Count every edge.
* Consider each SINGLE host failure independently, hosts 0 through 3, including a host with no load. Affected services activate their lowest-numbered surviving replica; unaffected services keep their existing primary. Recompute total weighted communication traffic under that failure. worstFailure is the maximum of these four totals and MUST be <= failoverLimit. Do not substitute a zone outage, minimize each edge independently, or choose alternate primaries opportunistically.
* cost = sum over hosts(load*price). imbalance = maximum host load minus minimum host load, including empty hosts. All listed metrics in priority are minimized lexicographically in their given order, THEN minimize the pair-index vector lexicographically in services order. An unlisted metric must never precede this last tie-break.

Service/resource manifest, placement constraints and traffic graph:
{"services":["gateway","auth","ledger","cache","worker","audit","index","observer"],"hosts":["west-a","west-b","east-a","east-b"],"zone":[0,0,1,1],"size":[2,3,3,1,2,1,2,1],"capacity":[12,13,13,12],"pairs":[[0,2],[0,3],[1,2],[1,3]],"allowed":[[0,1,2,3],[0,1,2,3],[0,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,1,3]],"separate":[[0,2],[1,4]],"together":[],"pinned":[[0,0]],"edges":[[0,2,5],[1,4,4],[0,6,5],[2,5,4],[4,6,1],[6,7,5],[5,6,1],[1,2,3],[3,4,3],[2,1,3],[7,4,1]],"distance":[[0,1,5,7],[1,0,6,4],[5,6,0,1],[7,4,1,0]],"price":[3,3,4,2],"failoverLimit":200,"priority":["imbalance","cost","traffic"]}

Return ONLY JSON with exactly keys "pairs","loads","cost","traffic","imbalance","worstFailure" in that order. pairs is the chosen pair-INDEX vector, NOT an array of host pairs. loads is in hosts order. Supply the unique globally optimal design under the tie-break above.`,
    check: {
      kind: 'json_equal',
      value: {
        pairs: [0, 2, 3, 0, 1, 2, 1, 1],
        loads: [8, 7, 7, 8],
        cost: 89,
        traffic: 10,
        imbalance: 1,
        worstFailure: 70,
      },
    },
  },
  {
    id: 'frontier-planning_design-architecture-design-journal-writer-rack-loss',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Design the journal-writer-rack-loss replicated deployment. The exact optimum is required; all numbers are integer costs, not estimates. Services, hosts and pair choices are indexed from zero in their manifest order.

Normative design constraints, taking priority over the team's obsolete "place everything cheapest, then add failover" heuristic:
* Every service gets exactly one pair from pairs, selected by its pair INDEX from allowed[service]. Both replicas consume size[service] on their hosts for the entire deployment. Host total load <= capacity. The pair contains hosts from different zone values; primary is the numerically lower host, regardless of price or distance.
* A separate [a,b] pair must have DISJOINT replica-host sets. A together pair must select the SAME pair index. pinned [service,host] fixes that service's primary host, not just one replica. All constraints apply simultaneously.
* Each communication edge [source,target,weight] contributes weight*distance[primary(source)][primary(target)] to nominal traffic. Count every edge.
* Consider each SINGLE host failure independently, hosts 0 through 3, including a host with no load. Affected services activate their lowest-numbered surviving replica; unaffected services keep their existing primary. Recompute total weighted communication traffic under that failure. worstFailure is the maximum of these four totals and MUST be <= failoverLimit. Do not substitute a zone outage, minimize each edge independently, or choose alternate primaries opportunistically.
* cost = sum over hosts(load*price). imbalance = maximum host load minus minimum host load, including empty hosts. All listed metrics in priority are minimized lexicographically in their given order, THEN minimize the pair-index vector lexicographically in services order. An unlisted metric must never precede this last tie-break.

Service/resource manifest, placement constraints and traffic graph:
{"services":["gateway","auth","ledger","cache","worker","audit","index","observer"],"hosts":["west-a","west-b","east-a","east-b"],"zone":[0,0,1,1],"size":[2,3,2,2,2,1,3,1],"capacity":[12,13,13,12],"pairs":[[0,2],[0,3],[1,2],[1,3]],"allowed":[[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,2,3]],"separate":[[0,2],[1,4]],"together":[[3,5]],"pinned":[[0,0]],"edges":[[0,2,6],[1,4,5],[7,2,3],[3,4,6],[3,5,3],[4,0,6],[7,6,1],[4,1,5],[7,0,2],[7,4,6],[5,4,4],[6,3,2]],"distance":[[0,1,5,7],[1,0,6,4],[5,6,0,1],[7,4,1,0]],"price":[4,2,5,1],"failoverLimit":215,"priority":["cost","traffic"]}

Return ONLY JSON with exactly keys "pairs","loads","cost","traffic","imbalance","worstFailure" in that order. pairs is the chosen pair-INDEX vector, NOT an array of host pairs. loads is in hosts order. Supply the unique globally optimal design under the tie-break above.`,
    check: {
      kind: 'json_equal',
      value: {
        pairs: [0, 1, 3, 3, 2, 3, 3, 3],
        loads: [5, 11, 4, 12],
        cost: 74,
        traffic: 24,
        imbalance: 8,
        worstFailure: 152,
      },
    },
  },
  {
    id: 'frontier-planning_design-architecture-design-search-shard-residency',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Design the search-shard-residency replicated deployment. The exact optimum is required; all numbers are integer costs, not estimates. Services, hosts and pair choices are indexed from zero in their manifest order.

Normative design constraints, taking priority over the team's obsolete "place everything cheapest, then add failover" heuristic:
* Every service gets exactly one pair from pairs, selected by its pair INDEX from allowed[service]. Both replicas consume size[service] on their hosts for the entire deployment. Host total load <= capacity. The pair contains hosts from different zone values; primary is the numerically lower host, regardless of price or distance.
* A separate [a,b] pair must have DISJOINT replica-host sets. A together pair must select the SAME pair index. pinned [service,host] fixes that service's primary host, not just one replica. All constraints apply simultaneously.
* Each communication edge [source,target,weight] contributes weight*distance[primary(source)][primary(target)] to nominal traffic. Count every edge.
* Consider each SINGLE host failure independently, hosts 0 through 3, including a host with no load. Affected services activate their lowest-numbered surviving replica; unaffected services keep their existing primary. Recompute total weighted communication traffic under that failure. worstFailure is the maximum of these four totals and MUST be <= failoverLimit. Do not substitute a zone outage, minimize each edge independently, or choose alternate primaries opportunistically.
* cost = sum over hosts(load*price). imbalance = maximum host load minus minimum host load, including empty hosts. All listed metrics in priority are minimized lexicographically in their given order, THEN minimize the pair-index vector lexicographically in services order. An unlisted metric must never precede this last tie-break.

Service/resource manifest, placement constraints and traffic graph:
{"services":["gateway","auth","ledger","cache","worker","audit","index","observer"],"hosts":["west-a","west-b","east-a","east-b"],"zone":[0,0,1,1],"size":[2,3,2,1,3,1,2,1],"capacity":[12,13,13,12],"pairs":[[0,2],[0,3],[1,2],[1,3]],"allowed":[[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,3],[0,1,2,3],[0,1,2,3],[0,1,3]],"separate":[[0,2],[1,4]],"together":[],"pinned":[[0,0]],"edges":[[0,2,7],[1,4,2],[0,4,3],[3,5,4],[6,4,6],[2,3,2],[1,7,1],[7,3,4],[7,6,1],[4,5,2],[7,1,1],[6,3,1],[0,6,5]],"distance":[[0,1,5,7],[1,0,6,4],[5,6,0,1],[7,4,1,0]],"price":[3,3,4,2],"failoverLimit":230,"priority":["traffic","cost"]}

Return ONLY JSON with exactly keys "pairs","loads","cost","traffic","imbalance","worstFailure" in that order. pairs is the chosen pair-INDEX vector, NOT an array of host pairs. loads is in hosts order. Supply the unique globally optimal design under the tie-break above.`,
    check: {
      kind: 'json_equal',
      value: {
        pairs: [0, 3, 3, 1, 0, 1, 1, 1],
        loads: [10, 5, 5, 10],
        cost: 85,
        traffic: 13,
        imbalance: 5,
        worstFailure: 91,
      },
    },
  },
  {
    id: 'frontier-planning_design-architecture-design-policy-engine-trust-boundary',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Design the policy-engine-trust-boundary replicated deployment. The exact optimum is required; all numbers are integer costs, not estimates. Services, hosts and pair choices are indexed from zero in their manifest order.

Normative design constraints, taking priority over the team's obsolete "place everything cheapest, then add failover" heuristic:
* Every service gets exactly one pair from pairs, selected by its pair INDEX from allowed[service]. Both replicas consume size[service] on their hosts for the entire deployment. Host total load <= capacity. The pair contains hosts from different zone values; primary is the numerically lower host, regardless of price or distance.
* A separate [a,b] pair must have DISJOINT replica-host sets. A together pair must select the SAME pair index. pinned [service,host] fixes that service's primary host, not just one replica. All constraints apply simultaneously.
* Each communication edge [source,target,weight] contributes weight*distance[primary(source)][primary(target)] to nominal traffic. Count every edge.
* Consider each SINGLE host failure independently, hosts 0 through 3, including a host with no load. Affected services activate their lowest-numbered surviving replica; unaffected services keep their existing primary. Recompute total weighted communication traffic under that failure. worstFailure is the maximum of these four totals and MUST be <= failoverLimit. Do not substitute a zone outage, minimize each edge independently, or choose alternate primaries opportunistically.
* cost = sum over hosts(load*price). imbalance = maximum host load minus minimum host load, including empty hosts. All listed metrics in priority are minimized lexicographically in their given order, THEN minimize the pair-index vector lexicographically in services order. An unlisted metric must never precede this last tie-break.

Service/resource manifest, placement constraints and traffic graph:
{"services":["gateway","auth","ledger","cache","worker","audit","index","observer"],"hosts":["west-a","west-b","east-a","east-b"],"zone":[0,0,1,1],"size":[2,3,2,1,2,2,3,1],"capacity":[12,13,13,12],"pairs":[[0,2],[0,3],[1,2],[1,3]],"allowed":[[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,3],[0,1,2,3],[0,2,3]],"separate":[[0,2],[1,4]],"together":[],"pinned":[[0,0]],"edges":[[0,2,3],[1,4,3],[5,2,5],[4,2,5],[6,3,2],[3,2,1],[5,3,4],[7,0,3],[5,1,5]],"distance":[[0,1,5,7],[1,0,6,4],[5,6,0,1],[7,4,1,0]],"price":[4,2,5,1],"failoverLimit":170,"priority":["imbalance","cost","traffic"]}

Return ONLY JSON with exactly keys "pairs","loads","cost","traffic","imbalance","worstFailure" in that order. pairs is the chosen pair-INDEX vector, NOT an array of host pairs. loads is in hosts order. Supply the unique globally optimal design under the tie-break above.`,
    check: {
      kind: 'json_equal',
      value: {
        pairs: [0, 3, 3, 3, 0, 3, 0, 0],
        loads: [8, 8, 8, 8],
        cost: 96,
        traffic: 13,
        imbalance: 0,
        worstFailure: 91,
      },
    },
  },
  {
    id: 'frontier-planning_design-architecture-design-queue-consumer-anti-affinity',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Design the queue-consumer-anti-affinity replicated deployment. The exact optimum is required; all numbers are integer costs, not estimates. Services, hosts and pair choices are indexed from zero in their manifest order.

Normative design constraints, taking priority over the team's obsolete "place everything cheapest, then add failover" heuristic:
* Every service gets exactly one pair from pairs, selected by its pair INDEX from allowed[service]. Both replicas consume size[service] on their hosts for the entire deployment. Host total load <= capacity. The pair contains hosts from different zone values; primary is the numerically lower host, regardless of price or distance.
* A separate [a,b] pair must have DISJOINT replica-host sets. A together pair must select the SAME pair index. pinned [service,host] fixes that service's primary host, not just one replica. All constraints apply simultaneously.
* Each communication edge [source,target,weight] contributes weight*distance[primary(source)][primary(target)] to nominal traffic. Count every edge.
* Consider each SINGLE host failure independently, hosts 0 through 3, including a host with no load. Affected services activate their lowest-numbered surviving replica; unaffected services keep their existing primary. Recompute total weighted communication traffic under that failure. worstFailure is the maximum of these four totals and MUST be <= failoverLimit. Do not substitute a zone outage, minimize each edge independently, or choose alternate primaries opportunistically.
* cost = sum over hosts(load*price). imbalance = maximum host load minus minimum host load, including empty hosts. All listed metrics in priority are minimized lexicographically in their given order, THEN minimize the pair-index vector lexicographically in services order. An unlisted metric must never precede this last tie-break.

Service/resource manifest, placement constraints and traffic graph:
{"services":["gateway","auth","ledger","cache","worker","audit","index","observer"],"hosts":["west-a","west-b","east-a","east-b"],"zone":[0,0,1,1],"size":[3,3,2,1,2,1,2,1],"capacity":[12,13,13,12],"pairs":[[0,2],[0,3],[1,2],[1,3]],"allowed":[[0,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,1,3]],"separate":[[0,2],[1,4]],"together":[[3,5]],"pinned":[[0,0]],"edges":[[0,2,4],[1,4,4],[4,5,4],[5,2,5],[7,1,4],[2,6,6],[0,5,5],[7,0,5],[0,7,5],[3,6,5]],"distance":[[0,1,5,7],[1,0,6,4],[5,6,0,1],[7,4,1,0]],"price":[3,3,4,2],"failoverLimit":185,"priority":["cost","traffic"]}

Return ONLY JSON with exactly keys "pairs","loads","cost","traffic","imbalance","worstFailure" in that order. pairs is the chosen pair-INDEX vector, NOT an array of host pairs. loads is in hosts order. Supply the unique globally optimal design under the tie-break above.`,
    check: {
      kind: 'json_equal',
      value: {
        pairs: [0, 1, 3, 3, 2, 3, 3, 1],
        loads: [7, 8, 5, 10],
        cost: 85,
        traffic: 13,
        imbalance: 5,
        worstFailure: 87,
      },
    },
  },
  {
    id: 'frontier-planning_design-architecture-design-compiler-cache-coherence',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Design the compiler-cache-coherence replicated deployment. The exact optimum is required; all numbers are integer costs, not estimates. Services, hosts and pair choices are indexed from zero in their manifest order.

Normative design constraints, taking priority over the team's obsolete "place everything cheapest, then add failover" heuristic:
* Every service gets exactly one pair from pairs, selected by its pair INDEX from allowed[service]. Both replicas consume size[service] on their hosts for the entire deployment. Host total load <= capacity. The pair contains hosts from different zone values; primary is the numerically lower host, regardless of price or distance.
* A separate [a,b] pair must have DISJOINT replica-host sets. A together pair must select the SAME pair index. pinned [service,host] fixes that service's primary host, not just one replica. All constraints apply simultaneously.
* Each communication edge [source,target,weight] contributes weight*distance[primary(source)][primary(target)] to nominal traffic. Count every edge.
* Consider each SINGLE host failure independently, hosts 0 through 3, including a host with no load. Affected services activate their lowest-numbered surviving replica; unaffected services keep their existing primary. Recompute total weighted communication traffic under that failure. worstFailure is the maximum of these four totals and MUST be <= failoverLimit. Do not substitute a zone outage, minimize each edge independently, or choose alternate primaries opportunistically.
* cost = sum over hosts(load*price). imbalance = maximum host load minus minimum host load, including empty hosts. All listed metrics in priority are minimized lexicographically in their given order, THEN minimize the pair-index vector lexicographically in services order. An unlisted metric must never precede this last tie-break.

Service/resource manifest, placement constraints and traffic graph:
{"services":["gateway","auth","ledger","cache","worker","audit","index","observer"],"hosts":["west-a","west-b","east-a","east-b"],"zone":[0,0,1,1],"size":[2,4,2,1,2,1,3,1],"capacity":[12,13,13,12],"pairs":[[0,2],[0,3],[1,2],[1,3]],"allowed":[[0,1,2,3],[0,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,2,3]],"separate":[[0,2],[1,4]],"together":[],"pinned":[[0,0]],"edges":[[0,2,5],[1,4,5],[4,6,3],[1,7,5],[0,4,6],[5,2,6],[0,7,1],[1,2,4],[4,2,5],[2,1,3],[6,0,6]],"distance":[[0,1,5,7],[1,0,6,4],[5,6,0,1],[7,4,1,0]],"price":[4,2,5,1],"failoverLimit":200,"priority":["traffic","cost"]}

Return ONLY JSON with exactly keys "pairs","loads","cost","traffic","imbalance","worstFailure" in that order. pairs is the chosen pair-INDEX vector, NOT an array of host pairs. loads is in hosts order. Supply the unique globally optimal design under the tie-break above.`,
    check: {
      kind: 'json_equal',
      value: {
        pairs: [0, 3, 3, 3, 0, 3, 1, 3],
        loads: [7, 9, 4, 12],
        cost: 78,
        traffic: 16,
        imbalance: 8,
        worstFailure: 112,
      },
    },
  },
  {
    id: 'frontier-planning_design-architecture-design-vector-index-hot-standby',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Design the vector-index-hot-standby replicated deployment. The exact optimum is required; all numbers are integer costs, not estimates. Services, hosts and pair choices are indexed from zero in their manifest order.

Normative design constraints, taking priority over the team's obsolete "place everything cheapest, then add failover" heuristic:
* Every service gets exactly one pair from pairs, selected by its pair INDEX from allowed[service]. Both replicas consume size[service] on their hosts for the entire deployment. Host total load <= capacity. The pair contains hosts from different zone values; primary is the numerically lower host, regardless of price or distance.
* A separate [a,b] pair must have DISJOINT replica-host sets. A together pair must select the SAME pair index. pinned [service,host] fixes that service's primary host, not just one replica. All constraints apply simultaneously.
* Each communication edge [source,target,weight] contributes weight*distance[primary(source)][primary(target)] to nominal traffic. Count every edge.
* Consider each SINGLE host failure independently, hosts 0 through 3, including a host with no load. Affected services activate their lowest-numbered surviving replica; unaffected services keep their existing primary. Recompute total weighted communication traffic under that failure. worstFailure is the maximum of these four totals and MUST be <= failoverLimit. Do not substitute a zone outage, minimize each edge independently, or choose alternate primaries opportunistically.
* cost = sum over hosts(load*price). imbalance = maximum host load minus minimum host load, including empty hosts. All listed metrics in priority are minimized lexicographically in their given order, THEN minimize the pair-index vector lexicographically in services order. An unlisted metric must never precede this last tie-break.

Service/resource manifest, placement constraints and traffic graph:
{"services":["gateway","auth","ledger","cache","worker","audit","index","observer"],"hosts":["west-a","west-b","east-a","east-b"],"zone":[0,0,1,1],"size":[2,3,3,1,2,1,2,1],"capacity":[12,13,13,12],"pairs":[[0,2],[0,3],[1,2],[1,3]],"allowed":[[0,1,2,3],[0,1,2,3],[0,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,1,3]],"separate":[[0,2],[1,4]],"together":[],"pinned":[[0,0]],"edges":[[0,2,6],[1,4,2],[4,6,2],[7,0,6],[0,7,3],[0,5,3],[4,1,2],[7,1,4],[5,2,4],[0,4,6],[2,7,1],[3,2,5]],"distance":[[0,1,5,7],[1,0,6,4],[5,6,0,1],[7,4,1,0]],"price":[3,3,4,2],"failoverLimit":215,"priority":["imbalance","cost","traffic"]}

Return ONLY JSON with exactly keys "pairs","loads","cost","traffic","imbalance","worstFailure" in that order. pairs is the chosen pair-INDEX vector, NOT an array of host pairs. loads is in hosts order. Supply the unique globally optimal design under the tie-break above.`,
    check: {
      kind: 'json_equal',
      value: {
        pairs: [0, 2, 3, 2, 1, 2, 1, 1],
        loads: [7, 8, 7, 8],
        cost: 89,
        traffic: 18,
        imbalance: 1,
        worstFailure: 113,
      },
    },
  },
  {
    id: 'frontier-planning_design-architecture-design-edge-session-pinned-primary',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Design the edge-session-pinned-primary replicated deployment. The exact optimum is required; all numbers are integer costs, not estimates. Services, hosts and pair choices are indexed from zero in their manifest order.

Normative design constraints, taking priority over the team's obsolete "place everything cheapest, then add failover" heuristic:
* Every service gets exactly one pair from pairs, selected by its pair INDEX from allowed[service]. Both replicas consume size[service] on their hosts for the entire deployment. Host total load <= capacity. The pair contains hosts from different zone values; primary is the numerically lower host, regardless of price or distance.
* A separate [a,b] pair must have DISJOINT replica-host sets. A together pair must select the SAME pair index. pinned [service,host] fixes that service's primary host, not just one replica. All constraints apply simultaneously.
* Each communication edge [source,target,weight] contributes weight*distance[primary(source)][primary(target)] to nominal traffic. Count every edge.
* Consider each SINGLE host failure independently, hosts 0 through 3, including a host with no load. Affected services activate their lowest-numbered surviving replica; unaffected services keep their existing primary. Recompute total weighted communication traffic under that failure. worstFailure is the maximum of these four totals and MUST be <= failoverLimit. Do not substitute a zone outage, minimize each edge independently, or choose alternate primaries opportunistically.
* cost = sum over hosts(load*price). imbalance = maximum host load minus minimum host load, including empty hosts. All listed metrics in priority are minimized lexicographically in their given order, THEN minimize the pair-index vector lexicographically in services order. An unlisted metric must never precede this last tie-break.

Service/resource manifest, placement constraints and traffic graph:
{"services":["gateway","auth","ledger","cache","worker","audit","index","observer"],"hosts":["west-a","west-b","east-a","east-b"],"zone":[0,0,1,1],"size":[2,3,2,2,2,1,3,1],"capacity":[12,13,13,12],"pairs":[[0,2],[0,3],[1,2],[1,3]],"allowed":[[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,2,3]],"separate":[[0,2],[1,4]],"together":[[3,5]],"pinned":[[0,0]],"edges":[[0,2,7],[1,4,3],[5,7,1],[1,2,6],[7,2,1],[7,1,2],[4,7,1],[0,3,6],[3,4,3],[6,5,2],[3,2,2],[6,7,1],[6,3,4]],"distance":[[0,1,5,7],[1,0,6,4],[5,6,0,1],[7,4,1,0]],"price":[4,2,5,1],"failoverLimit":230,"priority":["cost","traffic"]}

Return ONLY JSON with exactly keys "pairs","loads","cost","traffic","imbalance","worstFailure" in that order. pairs is the chosen pair-INDEX vector, NOT an array of host pairs. loads is in hosts order. Supply the unique globally optimal design under the tie-break above.`,
    check: {
      kind: 'json_equal',
      value: {
        pairs: [0, 3, 3, 3, 0, 3, 3, 3],
        loads: [4, 12, 4, 12],
        cost: 72,
        traffic: 20,
        imbalance: 8,
        worstFailure: 140,
      },
    },
  },
  {
    id: 'frontier-planning_design-architecture-design-billing-replica-encryption',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Design the billing-replica-encryption replicated deployment. The exact optimum is required; all numbers are integer costs, not estimates. Services, hosts and pair choices are indexed from zero in their manifest order.

Normative design constraints, taking priority over the team's obsolete "place everything cheapest, then add failover" heuristic:
* Every service gets exactly one pair from pairs, selected by its pair INDEX from allowed[service]. Both replicas consume size[service] on their hosts for the entire deployment. Host total load <= capacity. The pair contains hosts from different zone values; primary is the numerically lower host, regardless of price or distance.
* A separate [a,b] pair must have DISJOINT replica-host sets. A together pair must select the SAME pair index. pinned [service,host] fixes that service's primary host, not just one replica. All constraints apply simultaneously.
* Each communication edge [source,target,weight] contributes weight*distance[primary(source)][primary(target)] to nominal traffic. Count every edge.
* Consider each SINGLE host failure independently, hosts 0 through 3, including a host with no load. Affected services activate their lowest-numbered surviving replica; unaffected services keep their existing primary. Recompute total weighted communication traffic under that failure. worstFailure is the maximum of these four totals and MUST be <= failoverLimit. Do not substitute a zone outage, minimize each edge independently, or choose alternate primaries opportunistically.
* cost = sum over hosts(load*price). imbalance = maximum host load minus minimum host load, including empty hosts. All listed metrics in priority are minimized lexicographically in their given order, THEN minimize the pair-index vector lexicographically in services order. An unlisted metric must never precede this last tie-break.

Service/resource manifest, placement constraints and traffic graph:
{"services":["gateway","auth","ledger","cache","worker","audit","index","observer"],"hosts":["west-a","west-b","east-a","east-b"],"zone":[0,0,1,1],"size":[2,3,2,1,3,1,2,1],"capacity":[12,13,13,12],"pairs":[[0,2],[0,3],[1,2],[1,3]],"allowed":[[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,3],[0,1,2,3],[0,1,2,3],[0,1,3]],"separate":[[0,2],[1,4]],"together":[],"pinned":[[0,0]],"edges":[[0,2,3],[1,4,4],[5,0,1],[5,7,1],[6,5,2],[5,2,6],[4,7,2],[4,6,1],[1,3,2]],"distance":[[0,1,5,7],[1,0,6,4],[5,6,0,1],[7,4,1,0]],"price":[3,3,4,2],"failoverLimit":170,"priority":["traffic","cost"]}

Return ONLY JSON with exactly keys "pairs","loads","cost","traffic","imbalance","worstFailure" in that order. pairs is the chosen pair-INDEX vector, NOT an array of host pairs. loads is in hosts order. Supply the unique globally optimal design under the tie-break above.`,
    check: {
      kind: 'json_equal',
      value: {
        pairs: [0, 0, 3, 1, 3, 3, 3, 3],
        loads: [6, 9, 5, 10],
        cost: 85,
        traffic: 8,
        imbalance: 5,
        worstFailure: 56,
      },
    },
  },
  {
    id: 'frontier-planning_design-architecture-design-durable-timer-locality',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Design the durable-timer-locality replicated deployment. The exact optimum is required; all numbers are integer costs, not estimates. Services, hosts and pair choices are indexed from zero in their manifest order.

Normative design constraints, taking priority over the team's obsolete "place everything cheapest, then add failover" heuristic:
* Every service gets exactly one pair from pairs, selected by its pair INDEX from allowed[service]. Both replicas consume size[service] on their hosts for the entire deployment. Host total load <= capacity. The pair contains hosts from different zone values; primary is the numerically lower host, regardless of price or distance.
* A separate [a,b] pair must have DISJOINT replica-host sets. A together pair must select the SAME pair index. pinned [service,host] fixes that service's primary host, not just one replica. All constraints apply simultaneously.
* Each communication edge [source,target,weight] contributes weight*distance[primary(source)][primary(target)] to nominal traffic. Count every edge.
* Consider each SINGLE host failure independently, hosts 0 through 3, including a host with no load. Affected services activate their lowest-numbered surviving replica; unaffected services keep their existing primary. Recompute total weighted communication traffic under that failure. worstFailure is the maximum of these four totals and MUST be <= failoverLimit. Do not substitute a zone outage, minimize each edge independently, or choose alternate primaries opportunistically.
* cost = sum over hosts(load*price). imbalance = maximum host load minus minimum host load, including empty hosts. All listed metrics in priority are minimized lexicographically in their given order, THEN minimize the pair-index vector lexicographically in services order. An unlisted metric must never precede this last tie-break.

Service/resource manifest, placement constraints and traffic graph:
{"services":["gateway","auth","ledger","cache","worker","audit","index","observer"],"hosts":["west-a","west-b","east-a","east-b"],"zone":[0,0,1,1],"size":[2,3,2,1,2,2,3,1],"capacity":[12,13,13,12],"pairs":[[0,2],[0,3],[1,2],[1,3]],"allowed":[[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,3],[0,1,2,3],[0,2,3]],"separate":[[0,2],[1,4]],"together":[],"pinned":[[0,0]],"edges":[[0,2,4],[1,4,5],[5,0,6],[1,5,1],[2,3,4],[5,4,5],[1,6,4],[3,1,3],[6,0,5],[7,6,2]],"distance":[[0,1,5,7],[1,0,6,4],[5,6,0,1],[7,4,1,0]],"price":[4,2,5,1],"failoverLimit":185,"priority":["imbalance","cost","traffic"]}

Return ONLY JSON with exactly keys "pairs","loads","cost","traffic","imbalance","worstFailure" in that order. pairs is the chosen pair-INDEX vector, NOT an array of host pairs. loads is in hosts order. Supply the unique globally optimal design under the tie-break above.`,
    check: {
      kind: 'json_equal',
      value: {
        pairs: [0, 0, 3, 3, 3, 3, 0, 3],
        loads: [8, 8, 8, 8],
        cost: 96,
        traffic: 21,
        imbalance: 0,
        worstFailure: 147,
      },
    },
  },
  {
    id: 'frontier-planning_design-architecture-design-media-transcoder-bandwidth',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Design the media-transcoder-bandwidth replicated deployment. The exact optimum is required; all numbers are integer costs, not estimates. Services, hosts and pair choices are indexed from zero in their manifest order.

Normative design constraints, taking priority over the team's obsolete "place everything cheapest, then add failover" heuristic:
* Every service gets exactly one pair from pairs, selected by its pair INDEX from allowed[service]. Both replicas consume size[service] on their hosts for the entire deployment. Host total load <= capacity. The pair contains hosts from different zone values; primary is the numerically lower host, regardless of price or distance.
* A separate [a,b] pair must have DISJOINT replica-host sets. A together pair must select the SAME pair index. pinned [service,host] fixes that service's primary host, not just one replica. All constraints apply simultaneously.
* Each communication edge [source,target,weight] contributes weight*distance[primary(source)][primary(target)] to nominal traffic. Count every edge.
* Consider each SINGLE host failure independently, hosts 0 through 3, including a host with no load. Affected services activate their lowest-numbered surviving replica; unaffected services keep their existing primary. Recompute total weighted communication traffic under that failure. worstFailure is the maximum of these four totals and MUST be <= failoverLimit. Do not substitute a zone outage, minimize each edge independently, or choose alternate primaries opportunistically.
* cost = sum over hosts(load*price). imbalance = maximum host load minus minimum host load, including empty hosts. All listed metrics in priority are minimized lexicographically in their given order, THEN minimize the pair-index vector lexicographically in services order. An unlisted metric must never precede this last tie-break.

Service/resource manifest, placement constraints and traffic graph:
{"services":["gateway","auth","ledger","cache","worker","audit","index","observer"],"hosts":["west-a","west-b","east-a","east-b"],"zone":[0,0,1,1],"size":[3,3,2,1,2,1,2,1],"capacity":[12,13,13,12],"pairs":[[0,2],[0,3],[1,2],[1,3]],"allowed":[[0,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,1,3]],"separate":[[0,2],[1,4]],"together":[[3,5]],"pinned":[[0,0]],"edges":[[0,2,5],[1,4,2],[5,1,5],[2,4,3],[3,2,1],[4,3,3],[6,0,2],[0,1,2],[6,1,1],[2,0,3],[7,3,1]],"distance":[[0,1,5,7],[1,0,6,4],[5,6,0,1],[7,4,1,0]],"price":[3,3,4,2],"failoverLimit":200,"priority":["cost","traffic"]}

Return ONLY JSON with exactly keys "pairs","loads","cost","traffic","imbalance","worstFailure" in that order. pairs is the chosen pair-INDEX vector, NOT an array of host pairs. loads is in hosts order. Supply the unique globally optimal design under the tie-break above.`,
    check: {
      kind: 'json_equal',
      value: {
        pairs: [0, 1, 3, 1, 2, 1, 1, 1],
        loads: [11, 4, 5, 10],
        cost: 85,
        traffic: 14,
        imbalance: 7,
        worstFailure: 91,
      },
    },
  },
  {
    id: 'frontier-planning_design-architecture-design-audit-log-cross-zone',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Design the audit-log-cross-zone replicated deployment. The exact optimum is required; all numbers are integer costs, not estimates. Services, hosts and pair choices are indexed from zero in their manifest order.

Normative design constraints, taking priority over the team's obsolete "place everything cheapest, then add failover" heuristic:
* Every service gets exactly one pair from pairs, selected by its pair INDEX from allowed[service]. Both replicas consume size[service] on their hosts for the entire deployment. Host total load <= capacity. The pair contains hosts from different zone values; primary is the numerically lower host, regardless of price or distance.
* A separate [a,b] pair must have DISJOINT replica-host sets. A together pair must select the SAME pair index. pinned [service,host] fixes that service's primary host, not just one replica. All constraints apply simultaneously.
* Each communication edge [source,target,weight] contributes weight*distance[primary(source)][primary(target)] to nominal traffic. Count every edge.
* Consider each SINGLE host failure independently, hosts 0 through 3, including a host with no load. Affected services activate their lowest-numbered surviving replica; unaffected services keep their existing primary. Recompute total weighted communication traffic under that failure. worstFailure is the maximum of these four totals and MUST be <= failoverLimit. Do not substitute a zone outage, minimize each edge independently, or choose alternate primaries opportunistically.
* cost = sum over hosts(load*price). imbalance = maximum host load minus minimum host load, including empty hosts. All listed metrics in priority are minimized lexicographically in their given order, THEN minimize the pair-index vector lexicographically in services order. An unlisted metric must never precede this last tie-break.

Service/resource manifest, placement constraints and traffic graph:
{"services":["gateway","auth","ledger","cache","worker","audit","index","observer"],"hosts":["west-a","west-b","east-a","east-b"],"zone":[0,0,1,1],"size":[2,4,2,1,2,1,3,1],"capacity":[12,13,13,12],"pairs":[[0,2],[0,3],[1,2],[1,3]],"allowed":[[0,1,2,3],[0,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,2,3]],"separate":[[0,2],[1,4]],"together":[],"pinned":[[0,0]],"edges":[[0,2,6],[1,4,3],[5,1,4],[0,7,3],[3,6,3],[1,3,4],[7,2,1],[2,4,1],[1,5,1],[7,0,1],[6,7,1],[6,2,2]],"distance":[[0,1,5,7],[1,0,6,4],[5,6,0,1],[7,4,1,0]],"price":[4,2,5,1],"failoverLimit":215,"priority":["traffic","cost"]}

Return ONLY JSON with exactly keys "pairs","loads","cost","traffic","imbalance","worstFailure" in that order. pairs is the chosen pair-INDEX vector, NOT an array of host pairs. loads is in hosts order. Supply the unique globally optimal design under the tie-break above.`,
    check: {
      kind: 'json_equal',
      value: {
        pairs: [0, 3, 3, 3, 0, 3, 3, 0],
        loads: [5, 11, 5, 11],
        cost: 78,
        traffic: 12,
        imbalance: 6,
        worstFailure: 84,
      },
    },
  },
  {
    id: 'frontier-planning_design-architecture-design-tenant-router-noisy-neighbor',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'architecture_design',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Design the tenant-router-noisy-neighbor replicated deployment. The exact optimum is required; all numbers are integer costs, not estimates. Services, hosts and pair choices are indexed from zero in their manifest order.

Normative design constraints, taking priority over the team's obsolete "place everything cheapest, then add failover" heuristic:
* Every service gets exactly one pair from pairs, selected by its pair INDEX from allowed[service]. Both replicas consume size[service] on their hosts for the entire deployment. Host total load <= capacity. The pair contains hosts from different zone values; primary is the numerically lower host, regardless of price or distance.
* A separate [a,b] pair must have DISJOINT replica-host sets. A together pair must select the SAME pair index. pinned [service,host] fixes that service's primary host, not just one replica. All constraints apply simultaneously.
* Each communication edge [source,target,weight] contributes weight*distance[primary(source)][primary(target)] to nominal traffic. Count every edge.
* Consider each SINGLE host failure independently, hosts 0 through 3, including a host with no load. Affected services activate their lowest-numbered surviving replica; unaffected services keep their existing primary. Recompute total weighted communication traffic under that failure. worstFailure is the maximum of these four totals and MUST be <= failoverLimit. Do not substitute a zone outage, minimize each edge independently, or choose alternate primaries opportunistically.
* cost = sum over hosts(load*price). imbalance = maximum host load minus minimum host load, including empty hosts. All listed metrics in priority are minimized lexicographically in their given order, THEN minimize the pair-index vector lexicographically in services order. An unlisted metric must never precede this last tie-break.

Service/resource manifest, placement constraints and traffic graph:
{"services":["gateway","auth","ledger","cache","worker","audit","index","observer"],"hosts":["west-a","west-b","east-a","east-b"],"zone":[0,0,1,1],"size":[2,3,3,1,2,1,2,1],"capacity":[12,13,13,12],"pairs":[[0,2],[0,3],[1,2],[1,3]],"allowed":[[0,1,2,3],[0,1,2,3],[0,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,1,2,3],[0,1,3]],"separate":[[0,2],[1,4]],"together":[],"pinned":[[0,0]],"edges":[[0,2,7],[1,4,4],[6,2,4],[3,2,2],[4,0,6],[0,3,3],[6,0,1],[4,7,6],[5,4,2],[1,3,1],[4,3,2],[1,7,1],[0,5,3]],"distance":[[0,1,5,7],[1,0,6,4],[5,6,0,1],[7,4,1,0]],"price":[3,3,4,2],"failoverLimit":230,"priority":["imbalance","cost","traffic"]}

Return ONLY JSON with exactly keys "pairs","loads","cost","traffic","imbalance","worstFailure" in that order. pairs is the chosen pair-INDEX vector, NOT an array of host pairs. loads is in hosts order. Supply the unique globally optimal design under the tie-break above.`,
    check: {
      kind: 'json_equal',
      value: {
        pairs: [0, 2, 3, 0, 1, 0, 3, 1],
        loads: [7, 8, 7, 8],
        cost: 89,
        traffic: 16,
        imbalance: 1,
        worstFailure: 100,
      },
    },
  },
  {
    id: 'frontier-planning_design-technical-planning-online-ledger-index-cutover',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Produce the exact optimal non-preemptive deployment schedule for online-ledger-index-cutover. These are tasks across distinct source modules, operations and compatibility probes; the listed dependencies are normative even if the task names suggest another order. Task indices follow tasks order.

Hard constraints:
* Start times are nonnegative integers and each task runs once for duration[i] consecutive units. It occupies the half-open interval [start,finish), so resources are released at finish and another task may start at that same instant. No preemption or partial execution.
* Each executing task needs ONE worker, memory[i] units of memory, and io[i] units of IO capacity simultaneously for its ENTIRE interval. Totals must fit workerCapacity, memoryCapacity and ioCapacity at every integer time.
* Each outage [begin,end,resource,reducedCapacity] changes that resource's capacity throughout [begin,end). If outages overlap, use the minimum applicable capacity, including the normal capacity. A task that spans an outage must satisfy the reduced capacity too; checking only at task start is wrong. resource is "worker", "memory", or "io".
* start[i]>=release[i] and start[i]>=finish[parent] for every parent in deps[i]. Each exclusive [a,b] pair must have non-overlapping execution intervals even if aggregate capacities would permit overlap.

Specification priorities:
* Deadlines are SOFT; no schedule is rejected merely for missing one. tardiness = sum weight[i]*max(0,finish[i]-deadline[i]). weightedCompletion = sum weight[i]*finish[i]. makespan = max finish.
* Minimize these metrics lexicographically in exactly the given priority order, then minimize the entire start-time vector lexicographically in tasks order. Do not let the old runbook's "earliest released task first" rule override this objective. Intentional idle time is permitted.

Task, dependency, resource and calendar manifests:
{"tasks":["snapshot","reader","shadow","backfill","verify","writer","drain","cutover"],"duration":[1,3,2,1,3,2,1,3],"deps":[[],[],[0,1],[1],[],[2,4],[3,4],[5,6]],"release":[0,1,0,0,0,0,0,0],"memory":[1,2,3,1,2,3,1,2],"io":[1,0,0,1,0,0,1,0],"workerCapacity":2,"memoryCapacity":5,"ioCapacity":1,"outages":[[3,5,"io",0],[7,9,"worker",1]],"exclusive":[[3,4]],"deadline":[3,5,7,9,11,13,15,17],"weight":[1,4,2,5,3,1,4,2],"priority":["makespan","tardiness","weightedCompletion"]}

Return ONLY JSON with exactly keys "start","finish","makespan","tardiness","weightedCompletion" in that order. start and finish are arrays in tasks order, not chronological order. A legal greedy schedule is not sufficient: return the global optimum.`,
    check: {
      kind: 'json_equal',
      value: {
        start: [0, 1, 4, 5, 0, 6, 6, 8],
        finish: [1, 4, 6, 6, 3, 8, 7, 11],
        makespan: 11,
        tardiness: 0,
        weightedCompletion: 126,
      },
    },
  },
  {
    id: 'frontier-planning_design-technical-planning-cancel-safe-worker-rollout',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Produce the exact optimal non-preemptive deployment schedule for cancel-safe-worker-rollout. These are tasks across distinct source modules, operations and compatibility probes; the listed dependencies are normative even if the task names suggest another order. Task indices follow tasks order.

Hard constraints:
* Start times are nonnegative integers and each task runs once for duration[i] consecutive units. It occupies the half-open interval [start,finish), so resources are released at finish and another task may start at that same instant. No preemption or partial execution.
* Each executing task needs ONE worker, memory[i] units of memory, and io[i] units of IO capacity simultaneously for its ENTIRE interval. Totals must fit workerCapacity, memoryCapacity and ioCapacity at every integer time.
* Each outage [begin,end,resource,reducedCapacity] changes that resource's capacity throughout [begin,end). If outages overlap, use the minimum applicable capacity, including the normal capacity. A task that spans an outage must satisfy the reduced capacity too; checking only at task start is wrong. resource is "worker", "memory", or "io".
* start[i]>=release[i] and start[i]>=finish[parent] for every parent in deps[i]. Each exclusive [a,b] pair must have non-overlapping execution intervals even if aggregate capacities would permit overlap.

Specification priorities:
* Deadlines are SOFT; no schedule is rejected merely for missing one. tardiness = sum weight[i]*max(0,finish[i]-deadline[i]). weightedCompletion = sum weight[i]*finish[i]. makespan = max finish.
* Minimize these metrics lexicographically in exactly the given priority order, then minimize the entire start-time vector lexicographically in tasks order. Do not let the old runbook's "earliest released task first" rule override this objective. Intentional idle time is permitted.

Task, dependency, resource and calendar manifests:
{"tasks":["lease","worker","cancel","dual","probe","fence","drain","switch"],"duration":[2,1,3,2,1,3,2,1],"deps":[[],[],[],[0],[1],[2],[3,4],[5,6]],"release":[0,0,2,0,0,0,0,0],"memory":[2,3,1,2,3,1,2,3],"io":[0,0,1,0,0,1,0,0],"workerCapacity":2,"memoryCapacity":5,"ioCapacity":1,"outages":[[4,6,"memory",3]],"exclusive":[[2,5],[1,4]],"deadline":[4,6,8,10,12,14,16,18],"weight":[2,5,3,1,4,2,5,3],"priority":["tardiness","makespan","weightedCompletion"]}

Return ONLY JSON with exactly keys "start","finish","makespan","tardiness","weightedCompletion" in that order. start and finish are arrays in tasks order, not chronological order. A legal greedy schedule is not sufficient: return the global optimum.`,
    check: {
      kind: 'json_equal',
      value: {
        start: [0, 0, 2, 2, 1, 5, 4, 8],
        finish: [2, 1, 5, 4, 2, 8, 6, 9],
        makespan: 9,
        tardiness: 0,
        weightedCompletion: 109,
      },
    },
  },
  {
    id: 'frontier-planning_design-technical-planning-encrypted-token-backfill',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Produce the exact optimal non-preemptive deployment schedule for encrypted-token-backfill. These are tasks across distinct source modules, operations and compatibility probes; the listed dependencies are normative even if the task names suggest another order. Task indices follow tasks order.

Hard constraints:
* Start times are nonnegative integers and each task runs once for duration[i] consecutive units. It occupies the half-open interval [start,finish), so resources are released at finish and another task may start at that same instant. No preemption or partial execution.
* Each executing task needs ONE worker, memory[i] units of memory, and io[i] units of IO capacity simultaneously for its ENTIRE interval. Totals must fit workerCapacity, memoryCapacity and ioCapacity at every integer time.
* Each outage [begin,end,resource,reducedCapacity] changes that resource's capacity throughout [begin,end). If outages overlap, use the minimum applicable capacity, including the normal capacity. A task that spans an outage must satisfy the reduced capacity too; checking only at task start is wrong. resource is "worker", "memory", or "io".
* start[i]>=release[i] and start[i]>=finish[parent] for every parent in deps[i]. Each exclusive [a,b] pair must have non-overlapping execution intervals even if aggregate capacities would permit overlap.

Specification priorities:
* Deadlines are SOFT; no schedule is rejected merely for missing one. tardiness = sum weight[i]*max(0,finish[i]-deadline[i]). weightedCompletion = sum weight[i]*finish[i]. makespan = max finish.
* Minimize these metrics lexicographically in exactly the given priority order, then minimize the entire start-time vector lexicographically in tasks order. Do not let the old runbook's "earliest released task first" rule override this objective. Intentional idle time is permitted.

Task, dependency, resource and calendar manifests:
{"tasks":["keys","schema","export","encrypt","verify","reader","writer","seal"],"duration":[3,2,1,3,2,1,3,2],"deps":[[],[],[0],[],[0,1],[2,3],[3,4],[5,6]],"release":[3,0,0,0,0,0,0,0],"memory":[3,1,2,3,1,2,3,1],"io":[0,1,0,0,1,0,0,1],"workerCapacity":2,"memoryCapacity":5,"ioCapacity":1,"outages":[[2,4,"worker",1],[8,10,"io",0]],"exclusive":[[3,4]],"deadline":[5,7,9,11,13,15,17,19],"weight":[3,1,4,2,5,3,1,4],"priority":["weightedCompletion","makespan","tardiness"]}

Return ONLY JSON with exactly keys "start","finish","makespan","tardiness","weightedCompletion" in that order. start and finish are arrays in tasks order, not chronological order. A legal greedy schedule is not sufficient: return the global optimum.`,
    check: {
      kind: 'json_equal',
      value: {
        start: [3, 0, 6, 0, 6, 7, 8, 11],
        finish: [6, 2, 7, 3, 8, 8, 11, 13],
        makespan: 13,
        tardiness: 3,
        weightedCompletion: 181,
      },
    },
  },
  {
    id: 'frontier-planning_design-technical-planning-regional-cache-repartition',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Produce the exact optimal non-preemptive deployment schedule for regional-cache-repartition. These are tasks across distinct source modules, operations and compatibility probes; the listed dependencies are normative even if the task names suggest another order. Task indices follow tasks order.

Hard constraints:
* Start times are nonnegative integers and each task runs once for duration[i] consecutive units. It occupies the half-open interval [start,finish), so resources are released at finish and another task may start at that same instant. No preemption or partial execution.
* Each executing task needs ONE worker, memory[i] units of memory, and io[i] units of IO capacity simultaneously for its ENTIRE interval. Totals must fit workerCapacity, memoryCapacity and ioCapacity at every integer time.
* Each outage [begin,end,resource,reducedCapacity] changes that resource's capacity throughout [begin,end). If outages overlap, use the minimum applicable capacity, including the normal capacity. A task that spans an outage must satisfy the reduced capacity too; checking only at task start is wrong. resource is "worker", "memory", or "io".
* start[i]>=release[i] and start[i]>=finish[parent] for every parent in deps[i]. Each exclusive [a,b] pair must have non-overlapping execution intervals even if aggregate capacities would permit overlap.

Specification priorities:
* Deadlines are SOFT; no schedule is rejected merely for missing one. tardiness = sum weight[i]*max(0,finish[i]-deadline[i]). weightedCompletion = sum weight[i]*finish[i]. makespan = max finish.
* Minimize these metrics lexicographically in exactly the given priority order, then minimize the entire start-time vector lexicographically in tasks order. Do not let the old runbook's "earliest released task first" rule override this objective. Intentional idle time is permitted.

Task, dependency, resource and calendar manifests:
{"tasks":["map","replica","warm","copy","check","drain","route","retire"],"duration":[1,3,2,1,3,2,1,3],"deps":[[],[0],[],[],[1,2],[2],[3,4],[5,6]],"release":[0,1,0,0,0,0,0,0],"memory":[1,2,3,1,2,3,1,2],"io":[1,0,0,1,0,0,1,0],"workerCapacity":2,"memoryCapacity":5,"ioCapacity":1,"outages":[[3,5,"io",0],[7,9,"worker",1]],"exclusive":[[2,5],[1,4]],"deadline":[3,5,7,9,11,13,15,17],"weight":[4,2,5,3,1,4,2,5],"priority":["makespan","tardiness","weightedCompletion"]}

Return ONLY JSON with exactly keys "start","finish","makespan","tardiness","weightedCompletion" in that order. start and finish are arrays in tasks order, not chronological order. A legal greedy schedule is not sufficient: return the global optimum.`,
    check: {
      kind: 'json_equal',
      value: {
        start: [0, 1, 0, 2, 4, 3, 7, 8],
        finish: [1, 4, 2, 3, 7, 5, 8, 11],
        makespan: 11,
        tardiness: 0,
        weightedCompletion: 129,
      },
    },
  },
  {
    id: 'frontier-planning_design-technical-planning-journal-checkpoint-upgrade',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Produce the exact optimal non-preemptive deployment schedule for journal-checkpoint-upgrade. These are tasks across distinct source modules, operations and compatibility probes; the listed dependencies are normative even if the task names suggest another order. Task indices follow tasks order.

Hard constraints:
* Start times are nonnegative integers and each task runs once for duration[i] consecutive units. It occupies the half-open interval [start,finish), so resources are released at finish and another task may start at that same instant. No preemption or partial execution.
* Each executing task needs ONE worker, memory[i] units of memory, and io[i] units of IO capacity simultaneously for its ENTIRE interval. Totals must fit workerCapacity, memoryCapacity and ioCapacity at every integer time.
* Each outage [begin,end,resource,reducedCapacity] changes that resource's capacity throughout [begin,end). If outages overlap, use the minimum applicable capacity, including the normal capacity. A task that spans an outage must satisfy the reduced capacity too; checking only at task start is wrong. resource is "worker", "memory", or "io".
* start[i]>=release[i] and start[i]>=finish[parent] for every parent in deps[i]. Each exclusive [a,b] pair must have non-overlapping execution intervals even if aggregate capacities would permit overlap.

Specification priorities:
* Deadlines are SOFT; no schedule is rejected merely for missing one. tardiness = sum weight[i]*max(0,finish[i]-deadline[i]). weightedCompletion = sum weight[i]*finish[i]. makespan = max finish.
* Minimize these metrics lexicographically in exactly the given priority order, then minimize the entire start-time vector lexicographically in tasks order. Do not let the old runbook's "earliest released task first" rule override this objective. Intentional idle time is permitted.

Task, dependency, resource and calendar manifests:
{"tasks":["reader","codec","snapshot","replay","compare","writer","fence","seal"],"duration":[2,1,3,2,1,3,2,1],"deps":[[],[],[],[0,1],[1],[1,2],[3,5],[4,6]],"release":[0,0,2,0,0,0,0,0],"memory":[2,3,1,2,3,1,2,3],"io":[0,0,1,0,0,1,0,0],"workerCapacity":2,"memoryCapacity":5,"ioCapacity":1,"outages":[[4,6,"memory",3]],"exclusive":[[3,4]],"deadline":[4,6,8,10,12,14,16,18],"weight":[5,3,1,4,2,5,3,1],"priority":["tardiness","makespan","weightedCompletion"]}

Return ONLY JSON with exactly keys "start","finish","makespan","tardiness","weightedCompletion" in that order. start and finish are arrays in tasks order, not chronological order. A legal greedy schedule is not sufficient: return the global optimum.`,
    check: {
      kind: 'json_equal',
      value: {
        start: [0, 0, 2, 2, 1, 5, 8, 10],
        finish: [2, 1, 5, 4, 2, 8, 10, 11],
        makespan: 11,
        tardiness: 0,
        weightedCompletion: 119,
      },
    },
  },
  {
    id: 'frontier-planning_design-technical-planning-tensor-layout-live-migration',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Produce the exact optimal non-preemptive deployment schedule for tensor-layout-live-migration. These are tasks across distinct source modules, operations and compatibility probes; the listed dependencies are normative even if the task names suggest another order. Task indices follow tasks order.

Hard constraints:
* Start times are nonnegative integers and each task runs once for duration[i] consecutive units. It occupies the half-open interval [start,finish), so resources are released at finish and another task may start at that same instant. No preemption or partial execution.
* Each executing task needs ONE worker, memory[i] units of memory, and io[i] units of IO capacity simultaneously for its ENTIRE interval. Totals must fit workerCapacity, memoryCapacity and ioCapacity at every integer time.
* Each outage [begin,end,resource,reducedCapacity] changes that resource's capacity throughout [begin,end). If outages overlap, use the minimum applicable capacity, including the normal capacity. A task that spans an outage must satisfy the reduced capacity too; checking only at task start is wrong. resource is "worker", "memory", or "io".
* start[i]>=release[i] and start[i]>=finish[parent] for every parent in deps[i]. Each exclusive [a,b] pair must have non-overlapping execution intervals even if aggregate capacities would permit overlap.

Specification priorities:
* Deadlines are SOFT; no schedule is rejected merely for missing one. tardiness = sum weight[i]*max(0,finish[i]-deadline[i]). weightedCompletion = sum weight[i]*finish[i]. makespan = max finish.
* Minimize these metrics lexicographically in exactly the given priority order, then minimize the entire start-time vector lexicographically in tasks order. Do not let the old runbook's "earliest released task first" rule override this objective. Intentional idle time is permitted.

Task, dependency, resource and calendar manifests:
{"tasks":["layout","alloc","export","pack","check","kernel","drain","flip"],"duration":[3,2,1,3,2,1,3,2],"deps":[[],[],[0],[1],[],[2,3,4],[3,4],[5,6]],"release":[3,0,0,0,0,0,0,0],"memory":[3,1,2,3,1,2,3,1],"io":[0,1,0,0,1,0,0,1],"workerCapacity":2,"memoryCapacity":5,"ioCapacity":1,"outages":[[2,4,"worker",1],[8,10,"io",0]],"exclusive":[[2,5],[1,4]],"deadline":[5,7,9,11,13,15,17,19],"weight":[1,4,2,5,3,1,4,2],"priority":["weightedCompletion","makespan","tardiness"]}

Return ONLY JSON with exactly keys "start","finish","makespan","tardiness","weightedCompletion" in that order. start and finish are arrays in tasks order, not chronological order. A legal greedy schedule is not sufficient: return the global optimum.`,
    check: {
      kind: 'json_equal',
      value: {
        start: [5, 0, 8, 2, 4, 9, 8, 11],
        finish: [8, 2, 9, 5, 6, 10, 11, 13],
        makespan: 13,
        tardiness: 3,
        weightedCompletion: 157,
      },
    },
  },
  {
    id: 'frontier-planning_design-technical-planning-plugin-permission-split',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Produce the exact optimal non-preemptive deployment schedule for plugin-permission-split. These are tasks across distinct source modules, operations and compatibility probes; the listed dependencies are normative even if the task names suggest another order. Task indices follow tasks order.

Hard constraints:
* Start times are nonnegative integers and each task runs once for duration[i] consecutive units. It occupies the half-open interval [start,finish), so resources are released at finish and another task may start at that same instant. No preemption or partial execution.
* Each executing task needs ONE worker, memory[i] units of memory, and io[i] units of IO capacity simultaneously for its ENTIRE interval. Totals must fit workerCapacity, memoryCapacity and ioCapacity at every integer time.
* Each outage [begin,end,resource,reducedCapacity] changes that resource's capacity throughout [begin,end). If outages overlap, use the minimum applicable capacity, including the normal capacity. A task that spans an outage must satisfy the reduced capacity too; checking only at task start is wrong. resource is "worker", "memory", or "io".
* start[i]>=release[i] and start[i]>=finish[parent] for every parent in deps[i]. Each exclusive [a,b] pair must have non-overlapping execution intervals even if aggregate capacities would permit overlap.

Specification priorities:
* Deadlines are SOFT; no schedule is rejected merely for missing one. tardiness = sum weight[i]*max(0,finish[i]-deadline[i]). weightedCompletion = sum weight[i]*finish[i]. makespan = max finish.
* Minimize these metrics lexicographically in exactly the given priority order, then minimize the entire start-time vector lexicographically in tasks order. Do not let the old runbook's "earliest released task first" rule override this objective. Intentional idle time is permitted.

Task, dependency, resource and calendar manifests:
{"tasks":["policy","host","scan","grant","audit","bridge","drain","seal"],"duration":[1,3,2,1,3,2,1,3],"deps":[[],[],[],[0],[1],[2],[0,3,4],[5,6]],"release":[0,1,0,0,0,0,0,0],"memory":[1,2,3,1,2,3,1,2],"io":[1,0,0,1,0,0,1,0],"workerCapacity":2,"memoryCapacity":5,"ioCapacity":1,"outages":[[3,5,"io",0],[7,9,"worker",1]],"exclusive":[[3,4]],"deadline":[3,5,7,9,11,13,15,17],"weight":[2,5,3,1,4,2,5,3],"priority":["makespan","tardiness","weightedCompletion"]}

Return ONLY JSON with exactly keys "start","finish","makespan","tardiness","weightedCompletion" in that order. start and finish are arrays in tasks order, not chronological order. A legal greedy schedule is not sufficient: return the global optimum.`,
    check: {
      kind: 'json_equal',
      value: {
        start: [0, 1, 0, 2, 4, 3, 7, 8],
        finish: [1, 4, 2, 3, 7, 5, 8, 11],
        makespan: 11,
        tardiness: 0,
        weightedCompletion: 142,
      },
    },
  },
  {
    id: 'frontier-planning_design-technical-planning-compiler-abi-transition',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Produce the exact optimal non-preemptive deployment schedule for compiler-abi-transition. These are tasks across distinct source modules, operations and compatibility probes; the listed dependencies are normative even if the task names suggest another order. Task indices follow tasks order.

Hard constraints:
* Start times are nonnegative integers and each task runs once for duration[i] consecutive units. It occupies the half-open interval [start,finish), so resources are released at finish and another task may start at that same instant. No preemption or partial execution.
* Each executing task needs ONE worker, memory[i] units of memory, and io[i] units of IO capacity simultaneously for its ENTIRE interval. Totals must fit workerCapacity, memoryCapacity and ioCapacity at every integer time.
* Each outage [begin,end,resource,reducedCapacity] changes that resource's capacity throughout [begin,end). If outages overlap, use the minimum applicable capacity, including the normal capacity. A task that spans an outage must satisfy the reduced capacity too; checking only at task start is wrong. resource is "worker", "memory", or "io".
* start[i]>=release[i] and start[i]>=finish[parent] for every parent in deps[i]. Each exclusive [a,b] pair must have non-overlapping execution intervals even if aggregate capacities would permit overlap.

Specification priorities:
* Deadlines are SOFT; no schedule is rejected merely for missing one. tardiness = sum weight[i]*max(0,finish[i]-deadline[i]). weightedCompletion = sum weight[i]*finish[i]. makespan = max finish.
* Minimize these metrics lexicographically in exactly the given priority order, then minimize the entire start-time vector lexicographically in tasks order. Do not let the old runbook's "earliest released task first" rule override this objective. Intentional idle time is permitted.

Task, dependency, resource and calendar manifests:
{"tasks":["abi","parser","symbols","emit","link","plugin","drain","publish"],"duration":[2,1,3,2,1,3,2,1],"deps":[[],[],[0],[],[1],[2,3],[2,3,4],[5,6]],"release":[0,0,2,0,0,0,0,0],"memory":[2,3,1,2,3,1,2,3],"io":[0,0,1,0,0,1,0,0],"workerCapacity":2,"memoryCapacity":5,"ioCapacity":1,"outages":[[4,6,"memory",3]],"exclusive":[[2,5],[1,4]],"deadline":[4,6,8,10,12,14,16,18],"weight":[3,1,4,2,5,3,1,4],"priority":["tardiness","makespan","weightedCompletion"]}

Return ONLY JSON with exactly keys "start","finish","makespan","tardiness","weightedCompletion" in that order. start and finish are arrays in tasks order, not chronological order. A legal greedy schedule is not sufficient: return the global optimum.`,
    check: {
      kind: 'json_equal',
      value: {
        start: [0, 0, 2, 2, 1, 5, 5, 8],
        finish: [2, 1, 5, 4, 2, 8, 7, 9],
        makespan: 9,
        tardiness: 0,
        weightedCompletion: 112,
      },
    },
  },
  {
    id: 'frontier-planning_design-technical-planning-tenant-quota-reconciliation',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Produce the exact optimal non-preemptive deployment schedule for tenant-quota-reconciliation. These are tasks across distinct source modules, operations and compatibility probes; the listed dependencies are normative even if the task names suggest another order. Task indices follow tasks order.

Hard constraints:
* Start times are nonnegative integers and each task runs once for duration[i] consecutive units. It occupies the half-open interval [start,finish), so resources are released at finish and another task may start at that same instant. No preemption or partial execution.
* Each executing task needs ONE worker, memory[i] units of memory, and io[i] units of IO capacity simultaneously for its ENTIRE interval. Totals must fit workerCapacity, memoryCapacity and ioCapacity at every integer time.
* Each outage [begin,end,resource,reducedCapacity] changes that resource's capacity throughout [begin,end). If outages overlap, use the minimum applicable capacity, including the normal capacity. A task that spans an outage must satisfy the reduced capacity too; checking only at task start is wrong. resource is "worker", "memory", or "io".
* start[i]>=release[i] and start[i]>=finish[parent] for every parent in deps[i]. Each exclusive [a,b] pair must have non-overlapping execution intervals even if aggregate capacities would permit overlap.

Specification priorities:
* Deadlines are SOFT; no schedule is rejected merely for missing one. tardiness = sum weight[i]*max(0,finish[i]-deadline[i]). weightedCompletion = sum weight[i]*finish[i]. makespan = max finish.
* Minimize these metrics lexicographically in exactly the given priority order, then minimize the entire start-time vector lexicographically in tasks order. Do not let the old runbook's "earliest released task first" rule override this objective. Intentional idle time is permitted.

Task, dependency, resource and calendar manifests:
{"tasks":["schema","cap","snapshot","ledger","reconcile","guard","drain","enforce"],"duration":[3,2,1,3,2,1,3,2],"deps":[[],[0],[],[],[1],[2],[3,4],[5,6]],"release":[3,0,0,0,0,0,0,0],"memory":[3,1,2,3,1,2,3,1],"io":[0,1,0,0,1,0,0,1],"workerCapacity":2,"memoryCapacity":5,"ioCapacity":1,"outages":[[2,4,"worker",1],[8,10,"io",0]],"exclusive":[[3,4]],"deadline":[5,7,9,11,13,15,17,19],"weight":[4,2,5,3,1,4,2,5],"priority":["weightedCompletion","makespan","tardiness"]}

Return ONLY JSON with exactly keys "start","finish","makespan","tardiness","weightedCompletion" in that order. start and finish are arrays in tasks order, not chronological order. A legal greedy schedule is not sufficient: return the global optimum.`,
    check: {
      kind: 'json_equal',
      value: {
        start: [3, 6, 0, 0, 10, 1, 12, 15],
        finish: [6, 8, 1, 3, 12, 2, 15, 17],
        makespan: 17,
        tardiness: 6,
        weightedCompletion: 189,
      },
    },
  },
  {
    id: 'frontier-planning_design-technical-planning-exactly-once-queue-upgrade',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Produce the exact optimal non-preemptive deployment schedule for exactly-once-queue-upgrade. These are tasks across distinct source modules, operations and compatibility probes; the listed dependencies are normative even if the task names suggest another order. Task indices follow tasks order.

Hard constraints:
* Start times are nonnegative integers and each task runs once for duration[i] consecutive units. It occupies the half-open interval [start,finish), so resources are released at finish and another task may start at that same instant. No preemption or partial execution.
* Each executing task needs ONE worker, memory[i] units of memory, and io[i] units of IO capacity simultaneously for its ENTIRE interval. Totals must fit workerCapacity, memoryCapacity and ioCapacity at every integer time.
* Each outage [begin,end,resource,reducedCapacity] changes that resource's capacity throughout [begin,end). If outages overlap, use the minimum applicable capacity, including the normal capacity. A task that spans an outage must satisfy the reduced capacity too; checking only at task start is wrong. resource is "worker", "memory", or "io".
* start[i]>=release[i] and start[i]>=finish[parent] for every parent in deps[i]. Each exclusive [a,b] pair must have non-overlapping execution intervals even if aggregate capacities would permit overlap.

Specification priorities:
* Deadlines are SOFT; no schedule is rejected merely for missing one. tardiness = sum weight[i]*max(0,finish[i]-deadline[i]). weightedCompletion = sum weight[i]*finish[i]. makespan = max finish.
* Minimize these metrics lexicographically in exactly the given priority order, then minimize the entire start-time vector lexicographically in tasks order. Do not let the old runbook's "earliest released task first" rule override this objective. Intentional idle time is permitted.

Task, dependency, resource and calendar manifests:
{"tasks":["producer","reader","offset","replay","dedup","consumer","drain","commit"],"duration":[1,3,2,1,3,2,1,3],"deps":[[],[],[],[0,1,2],[1],[2],[3,5],[4,6]],"release":[0,1,0,0,0,0,0,0],"memory":[1,2,3,1,2,3,1,2],"io":[1,0,0,1,0,0,1,0],"workerCapacity":2,"memoryCapacity":5,"ioCapacity":1,"outages":[[3,5,"io",0],[7,9,"worker",1]],"exclusive":[[2,5],[1,4]],"deadline":[3,5,7,9,11,13,15,17],"weight":[5,3,1,4,2,5,3,1],"priority":["makespan","tardiness","weightedCompletion"]}

Return ONLY JSON with exactly keys "start","finish","makespan","tardiness","weightedCompletion" in that order. start and finish are arrays in tasks order, not chronological order. A legal greedy schedule is not sufficient: return the global optimum.`,
    check: {
      kind: 'json_equal',
      value: {
        start: [0, 1, 0, 5, 4, 2, 6, 7],
        finish: [1, 4, 2, 6, 7, 4, 7, 10],
        makespan: 10,
        tardiness: 0,
        weightedCompletion: 108,
      },
    },
  },
  {
    id: 'frontier-planning_design-technical-planning-webhook-key-rotation',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Produce the exact optimal non-preemptive deployment schedule for webhook-key-rotation. These are tasks across distinct source modules, operations and compatibility probes; the listed dependencies are normative even if the task names suggest another order. Task indices follow tasks order.

Hard constraints:
* Start times are nonnegative integers and each task runs once for duration[i] consecutive units. It occupies the half-open interval [start,finish), so resources are released at finish and another task may start at that same instant. No preemption or partial execution.
* Each executing task needs ONE worker, memory[i] units of memory, and io[i] units of IO capacity simultaneously for its ENTIRE interval. Totals must fit workerCapacity, memoryCapacity and ioCapacity at every integer time.
* Each outage [begin,end,resource,reducedCapacity] changes that resource's capacity throughout [begin,end). If outages overlap, use the minimum applicable capacity, including the normal capacity. A task that spans an outage must satisfy the reduced capacity too; checking only at task start is wrong. resource is "worker", "memory", or "io".
* start[i]>=release[i] and start[i]>=finish[parent] for every parent in deps[i]. Each exclusive [a,b] pair must have non-overlapping execution intervals even if aggregate capacities would permit overlap.

Specification priorities:
* Deadlines are SOFT; no schedule is rejected merely for missing one. tardiness = sum weight[i]*max(0,finish[i]-deadline[i]). weightedCompletion = sum weight[i]*finish[i]. makespan = max finish.
* Minimize these metrics lexicographically in exactly the given priority order, then minimize the entire start-time vector lexicographically in tasks order. Do not let the old runbook's "earliest released task first" rule override this objective. Intentional idle time is permitted.

Task, dependency, resource and calendar manifests:
{"tasks":["newkey","reader","fetch","resign","verify","writer","drain","revoke"],"duration":[2,1,3,2,1,3,2,1],"deps":[[],[],[0],[1],[3],[2,4],[3,4],[5,6]],"release":[0,0,2,0,0,0,0,0],"memory":[2,3,1,2,3,1,2,3],"io":[0,0,1,0,0,1,0,0],"workerCapacity":2,"memoryCapacity":5,"ioCapacity":1,"outages":[[4,6,"memory",3]],"exclusive":[[3,4]],"deadline":[4,6,8,10,12,14,16,18],"weight":[1,4,2,5,3,1,4,2],"priority":["tardiness","makespan","weightedCompletion"]}

Return ONLY JSON with exactly keys "start","finish","makespan","tardiness","weightedCompletion" in that order. start and finish are arrays in tasks order, not chronological order. A legal greedy schedule is not sufficient: return the global optimum.`,
    check: {
      kind: 'json_equal',
      value: {
        start: [0, 0, 2, 1, 3, 5, 4, 8],
        finish: [2, 1, 5, 3, 4, 8, 6, 9],
        makespan: 9,
        tardiness: 0,
        weightedCompletion: 93,
      },
    },
  },
  {
    id: 'frontier-planning_design-technical-planning-audit-schema-expansion',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Produce the exact optimal non-preemptive deployment schedule for audit-schema-expansion. These are tasks across distinct source modules, operations and compatibility probes; the listed dependencies are normative even if the task names suggest another order. Task indices follow tasks order.

Hard constraints:
* Start times are nonnegative integers and each task runs once for duration[i] consecutive units. It occupies the half-open interval [start,finish), so resources are released at finish and another task may start at that same instant. No preemption or partial execution.
* Each executing task needs ONE worker, memory[i] units of memory, and io[i] units of IO capacity simultaneously for its ENTIRE interval. Totals must fit workerCapacity, memoryCapacity and ioCapacity at every integer time.
* Each outage [begin,end,resource,reducedCapacity] changes that resource's capacity throughout [begin,end). If outages overlap, use the minimum applicable capacity, including the normal capacity. A task that spans an outage must satisfy the reduced capacity too; checking only at task start is wrong. resource is "worker", "memory", or "io".
* start[i]>=release[i] and start[i]>=finish[parent] for every parent in deps[i]. Each exclusive [a,b] pair must have non-overlapping execution intervals even if aggregate capacities would permit overlap.

Specification priorities:
* Deadlines are SOFT; no schedule is rejected merely for missing one. tardiness = sum weight[i]*max(0,finish[i]-deadline[i]). weightedCompletion = sum weight[i]*finish[i]. makespan = max finish.
* Minimize these metrics lexicographically in exactly the given priority order, then minimize the entire start-time vector lexicographically in tasks order. Do not let the old runbook's "earliest released task first" rule override this objective. Intentional idle time is permitted.

Task, dependency, resource and calendar manifests:
{"tasks":["schema","reader","archive","copy","verify","writer","replay","seal"],"duration":[3,2,1,3,2,1,3,2],"deps":[[],[],[],[0],[1],[0,2],[3,4],[5,6]],"release":[3,0,0,0,0,0,0,0],"memory":[3,1,2,3,1,2,3,1],"io":[0,1,0,0,1,0,0,1],"workerCapacity":2,"memoryCapacity":5,"ioCapacity":1,"outages":[[2,4,"worker",1],[8,10,"io",0]],"exclusive":[[2,5],[1,4]],"deadline":[5,7,9,11,13,15,17,19],"weight":[2,5,3,1,4,2,5,3],"priority":["weightedCompletion","makespan","tardiness"]}

Return ONLY JSON with exactly keys "start","finish","makespan","tardiness","weightedCompletion" in that order. start and finish are arrays in tasks order, not chronological order. A legal greedy schedule is not sufficient: return the global optimum.`,
    check: {
      kind: 'json_equal',
      value: {
        start: [3, 0, 0, 6, 4, 6, 9, 12],
        finish: [6, 2, 1, 9, 6, 7, 12, 14],
        makespan: 14,
        tardiness: 2,
        weightedCompletion: 174,
      },
    },
  },
  {
    id: 'frontier-planning_design-technical-planning-search-tombstone-rebuild',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Produce the exact optimal non-preemptive deployment schedule for search-tombstone-rebuild. These are tasks across distinct source modules, operations and compatibility probes; the listed dependencies are normative even if the task names suggest another order. Task indices follow tasks order.

Hard constraints:
* Start times are nonnegative integers and each task runs once for duration[i] consecutive units. It occupies the half-open interval [start,finish), so resources are released at finish and another task may start at that same instant. No preemption or partial execution.
* Each executing task needs ONE worker, memory[i] units of memory, and io[i] units of IO capacity simultaneously for its ENTIRE interval. Totals must fit workerCapacity, memoryCapacity and ioCapacity at every integer time.
* Each outage [begin,end,resource,reducedCapacity] changes that resource's capacity throughout [begin,end). If outages overlap, use the minimum applicable capacity, including the normal capacity. A task that spans an outage must satisfy the reduced capacity too; checking only at task start is wrong. resource is "worker", "memory", or "io".
* start[i]>=release[i] and start[i]>=finish[parent] for every parent in deps[i]. Each exclusive [a,b] pair must have non-overlapping execution intervals even if aggregate capacities would permit overlap.

Specification priorities:
* Deadlines are SOFT; no schedule is rejected merely for missing one. tardiness = sum weight[i]*max(0,finish[i]-deadline[i]). weightedCompletion = sum weight[i]*finish[i]. makespan = max finish.
* Minimize these metrics lexicographically in exactly the given priority order, then minimize the entire start-time vector lexicographically in tasks order. Do not let the old runbook's "earliest released task first" rule override this objective. Intentional idle time is permitted.

Task, dependency, resource and calendar manifests:
{"tasks":["codec","reader","scan","index","compare","writer","drain","flip"],"duration":[1,3,2,1,3,2,1,3],"deps":[[],[],[0],[],[1],[2,3],[1,3,4],[5,6]],"release":[0,1,0,0,0,0,0,0],"memory":[1,2,3,1,2,3,1,2],"io":[1,0,0,1,0,0,1,0],"workerCapacity":2,"memoryCapacity":5,"ioCapacity":1,"outages":[[3,5,"io",0],[7,9,"worker",1]],"exclusive":[[3,4]],"deadline":[3,5,7,9,11,13,15,17],"weight":[3,1,4,2,5,3,1,4],"priority":["makespan","tardiness","weightedCompletion"]}

Return ONLY JSON with exactly keys "start","finish","makespan","tardiness","weightedCompletion" in that order. start and finish are arrays in tasks order, not chronological order. A legal greedy schedule is not sufficient: return the global optimum.`,
    check: {
      kind: 'json_equal',
      value: {
        start: [0, 1, 2, 1, 4, 4, 7, 8],
        finish: [1, 4, 4, 2, 7, 6, 8, 11],
        makespan: 11,
        tardiness: 0,
        weightedCompletion: 132,
      },
    },
  },
  {
    id: 'frontier-planning_design-technical-planning-model-capacity-transfer',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Produce the exact optimal non-preemptive deployment schedule for model-capacity-transfer. These are tasks across distinct source modules, operations and compatibility probes; the listed dependencies are normative even if the task names suggest another order. Task indices follow tasks order.

Hard constraints:
* Start times are nonnegative integers and each task runs once for duration[i] consecutive units. It occupies the half-open interval [start,finish), so resources are released at finish and another task may start at that same instant. No preemption or partial execution.
* Each executing task needs ONE worker, memory[i] units of memory, and io[i] units of IO capacity simultaneously for its ENTIRE interval. Totals must fit workerCapacity, memoryCapacity and ioCapacity at every integer time.
* Each outage [begin,end,resource,reducedCapacity] changes that resource's capacity throughout [begin,end). If outages overlap, use the minimum applicable capacity, including the normal capacity. A task that spans an outage must satisfy the reduced capacity too; checking only at task start is wrong. resource is "worker", "memory", or "io".
* start[i]>=release[i] and start[i]>=finish[parent] for every parent in deps[i]. Each exclusive [a,b] pair must have non-overlapping execution intervals even if aggregate capacities would permit overlap.

Specification priorities:
* Deadlines are SOFT; no schedule is rejected merely for missing one. tardiness = sum weight[i]*max(0,finish[i]-deadline[i]). weightedCompletion = sum weight[i]*finish[i]. makespan = max finish.
* Minimize these metrics lexicographically in exactly the given priority order, then minimize the entire start-time vector lexicographically in tasks order. Do not let the old runbook's "earliest released task first" rule override this objective. Intentional idle time is permitted.

Task, dependency, resource and calendar manifests:
{"tasks":["reserve","router","load","warm","probe","weights","drain","release"],"duration":[2,1,3,2,1,3,2,1],"deps":[[],[0],[],[],[1],[2,4],[3,4],[5,6]],"release":[0,0,2,0,0,0,0,0],"memory":[2,3,1,2,3,1,2,3],"io":[0,0,1,0,0,1,0,0],"workerCapacity":2,"memoryCapacity":5,"ioCapacity":1,"outages":[[4,6,"memory",3]],"exclusive":[[2,5],[1,4]],"deadline":[4,6,8,10,12,14,16,18],"weight":[4,2,5,3,1,4,2,5],"priority":["tardiness","makespan","weightedCompletion"]}

Return ONLY JSON with exactly keys "start","finish","makespan","tardiness","weightedCompletion" in that order. start and finish are arrays in tasks order, not chronological order. A legal greedy schedule is not sufficient: return the global optimum.`,
    check: {
      kind: 'json_equal',
      value: {
        start: [0, 2, 2, 0, 3, 5, 4, 8],
        finish: [2, 3, 5, 2, 4, 8, 6, 9],
        makespan: 9,
        tardiness: 0,
        weightedCompletion: 138,
      },
    },
  },
  {
    id: 'frontier-planning_design-technical-planning-session-fencing-deployment',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'technical_planning',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Produce the exact optimal non-preemptive deployment schedule for session-fencing-deployment. These are tasks across distinct source modules, operations and compatibility probes; the listed dependencies are normative even if the task names suggest another order. Task indices follow tasks order.

Hard constraints:
* Start times are nonnegative integers and each task runs once for duration[i] consecutive units. It occupies the half-open interval [start,finish), so resources are released at finish and another task may start at that same instant. No preemption or partial execution.
* Each executing task needs ONE worker, memory[i] units of memory, and io[i] units of IO capacity simultaneously for its ENTIRE interval. Totals must fit workerCapacity, memoryCapacity and ioCapacity at every integer time.
* Each outage [begin,end,resource,reducedCapacity] changes that resource's capacity throughout [begin,end). If outages overlap, use the minimum applicable capacity, including the normal capacity. A task that spans an outage must satisfy the reduced capacity too; checking only at task start is wrong. resource is "worker", "memory", or "io".
* start[i]>=release[i] and start[i]>=finish[parent] for every parent in deps[i]. Each exclusive [a,b] pair must have non-overlapping execution intervals even if aggregate capacities would permit overlap.

Specification priorities:
* Deadlines are SOFT; no schedule is rejected merely for missing one. tardiness = sum weight[i]*max(0,finish[i]-deadline[i]). weightedCompletion = sum weight[i]*finish[i]. makespan = max finish.
* Minimize these metrics lexicographically in exactly the given priority order, then minimize the entire start-time vector lexicographically in tasks order. Do not let the old runbook's "earliest released task first" rule override this objective. Intentional idle time is permitted.

Task, dependency, resource and calendar manifests:
{"tasks":["epoch","reader","snapshot","sessions","verify","writer","drain","fence"],"duration":[3,2,1,3,2,1,3,2],"deps":[[],[],[],[0,1],[1],[2],[3,5],[4,6]],"release":[3,0,0,0,0,0,0,0],"memory":[3,1,2,3,1,2,3,1],"io":[0,1,0,0,1,0,0,1],"workerCapacity":2,"memoryCapacity":5,"ioCapacity":1,"outages":[[2,4,"worker",1],[8,10,"io",0]],"exclusive":[[3,4]],"deadline":[5,7,9,11,13,15,17,19],"weight":[5,3,1,4,2,5,3,1],"priority":["weightedCompletion","makespan","tardiness"]}

Return ONLY JSON with exactly keys "start","finish","makespan","tardiness","weightedCompletion" in that order. start and finish are arrays in tasks order, not chronological order. A legal greedy schedule is not sufficient: return the global optimum.`,
    check: {
      kind: 'json_equal',
      value: {
        start: [3, 0, 0, 6, 4, 1, 9, 12],
        finish: [6, 2, 1, 9, 6, 2, 12, 14],
        makespan: 14,
        tardiness: 5,
        weightedCompletion: 145,
      },
    },
  },
  {
    id: 'frontier-planning_design-system-design-gpu-queue-deadline-admission',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Design the exact capacity-admission and routing plan for gpu-queue-deadline-admission. There is no stochastic behavior, preemption or retry. Jobs and hosts use zero-based manifest indices.

Normative admission contracts (higher priority than the team's "maximize throughput at any cost" guidance):
* Assign each job to ONE host in eligible[job], or DROP it, encoded by integer 3. A child may be admitted only when ALL jobs in deps[child] are admitted; admitting a parent does not force admission of a child. All parents have lower job indices.
* Each admitted job reserves memory[job] on its host for the ENTIRE plan, including before it starts and after it finishes. Sum reserved memory on each host <= capacity[host]. It is not a concurrency-only limit.
* Count admitted jobs per tenant (tenant indices 0,1,2). Each count must lie in [minimum,maximum] for that tenant. separate [a,b] means different hosts if BOTH are admitted; together means the same host if BOTH are admitted. Dropping either makes that pair constraint irrelevant.

Execution and SLO contracts:
* On EACH host, admitted jobs execute serially in INCREASING global job index, with no backfill. A lower-index job blocks the host while waiting for dependencies even when a higher-index ready job exists. Each job runs non-preemptively for duration[job][host]. Hosts are initially free at time 0.
* In global index order, an admitted job starts at max(host's previous admitted job finish, release[job], every admitted parent's finish+transfer[parentHost][jobHost]). Empty dependency sets contribute no additional restriction. transfer[h][h]=0. A parent on another host incurs the transfer delay even if the host otherwise is idle.
* finish = start+duration. All admitted jobs must finish <= deadline[job]. Dropped jobs have start=-1 and finish=-1 and do not occupy a queue, incur energy, or contribute utility.
* utility is sum utility[job] over admissions; accepted is their count. makespan is max admitted finish. energy sums duration[job][host]*price[host] plus startup[host] ONCE for each nonempty host. Tenant quotas guarantee at least one admission.

Optimization priority:
For each metric in priority, lexicographically optimize in given order: MAXIMIZE utility and accepted, MINIMIZE makespan and energy. Only after all these metrics tie, minimize the entire assignment vector lexicographically in jobs order, where drop=3 sorts after every host. Never change queue policy to improve the objective.

Admission, queue, tenancy, topology and resource manifests:
{"jobs":["j0","j1","j2","j3","j4","j5","j6","j7","j8","j9"],"hosts":["h0","h1","h2"],"tenant":[0,1,2,0,1,2,0,1,2,0],"minimum":[1,1,1],"maximum":[4,4,4],"eligible":[[0,1],[1,2],[0,2],[0,1],[1,2],[0,2],[0,1],[1,2],[0,2],[0,1]],"duration":[[2,4,6],[5,7,3],[2,4,6],[5,7,3],[2,4,6],[5,7,3],[2,4,6],[5,7,3],[2,4,6],[5,7,3]],"memory":[1,2,3,1,2,3,1,2,3,1],"capacity":[6,6,6],"release":[0,2,0,2,0,2,0,2,0,2],"deadline":[7,9,11,13,15,17,19,21,23,25],"utility":[3,10,4,11,5,12,6,13,7,14],"deps":[[],[],[],[],[0],[0,3],[0],[3],[3,5],[3,4]],"transfer":[[0,2,3],[2,0,1],[3,1,0]],"price":[2,3,1],"startup":[4,2,6],"separate":[[1,4],[3,7]],"together":[[4,7]],"priority":["utility","accepted","makespan","energy"]}

Reply ONLY JSON with exactly keys "assignment","start","finish","utility","accepted","makespan","energy","tenant" in that order. assignment/start/finish are in jobs order; tenant is admitted counts for tenants 0,1,2. Return the globally optimal allocation, including rejected jobs.`,
    check: {
      kind: 'json_equal',
      value: {
        assignment: [0, 2, 3, 0, 1, 0, 1, 1, 2, 0],
        start: [0, 2, -1, 2, 4, 7, 8, 12, 15, 12],
        finish: [2, 5, -1, 7, 8, 12, 12, 19, 21, 17],
        utility: 81,
        accepted: 9,
        makespan: 21,
        energy: 100,
        tenant: [4, 3, 2],
      },
    },
  },
  {
    id: 'frontier-planning_design-system-design-regional-write-fanout-allocation',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Design the exact capacity-admission and routing plan for regional-write-fanout-allocation. There is no stochastic behavior, preemption or retry. Jobs and hosts use zero-based manifest indices.

Normative admission contracts (higher priority than the team's "maximize throughput at any cost" guidance):
* Assign each job to ONE host in eligible[job], or DROP it, encoded by integer 3. A child may be admitted only when ALL jobs in deps[child] are admitted; admitting a parent does not force admission of a child. All parents have lower job indices.
* Each admitted job reserves memory[job] on its host for the ENTIRE plan, including before it starts and after it finishes. Sum reserved memory on each host <= capacity[host]. It is not a concurrency-only limit.
* Count admitted jobs per tenant (tenant indices 0,1,2). Each count must lie in [minimum,maximum] for that tenant. separate [a,b] means different hosts if BOTH are admitted; together means the same host if BOTH are admitted. Dropping either makes that pair constraint irrelevant.

Execution and SLO contracts:
* On EACH host, admitted jobs execute serially in INCREASING global job index, with no backfill. A lower-index job blocks the host while waiting for dependencies even when a higher-index ready job exists. Each job runs non-preemptively for duration[job][host]. Hosts are initially free at time 0.
* In global index order, an admitted job starts at max(host's previous admitted job finish, release[job], every admitted parent's finish+transfer[parentHost][jobHost]). Empty dependency sets contribute no additional restriction. transfer[h][h]=0. A parent on another host incurs the transfer delay even if the host otherwise is idle.
* finish = start+duration. All admitted jobs must finish <= deadline[job]. Dropped jobs have start=-1 and finish=-1 and do not occupy a queue, incur energy, or contribute utility.
* utility is sum utility[job] over admissions; accepted is their count. makespan is max admitted finish. energy sums duration[job][host]*price[host] plus startup[host] ONCE for each nonempty host. Tenant quotas guarantee at least one admission.

Optimization priority:
For each metric in priority, lexicographically optimize in given order: MAXIMIZE utility and accepted, MINIMIZE makespan and energy. Only after all these metrics tie, minimize the entire assignment vector lexicographically in jobs order, where drop=3 sorts after every host. Never change queue policy to improve the objective.

Admission, queue, tenancy, topology and resource manifests:
{"jobs":["j0","j1","j2","j3","j4","j5","j6","j7","j8","j9"],"hosts":["h0","h1","h2"],"tenant":[1,2,0,1,2,0,1,2,0,1],"minimum":[1,1,1],"maximum":[4,4,4],"eligible":[[1,2],[0,2],[0,1],[1,2],[0,2],[0,1],[1,2],[0,2],[0,1],[1,2]],"duration":[[3,5,7],[6,2,4],[3,5,7],[6,2,4],[3,5,7],[6,2,4],[3,5,7],[6,2,4],[3,5,7],[6,2,4]],"memory":[2,3,1,2,3,1,2,3,1,2],"capacity":[6,6,7],"release":[1,3,1,3,1,3,1,3,1,3],"deadline":[8,10,12,14,16,18,20,22,24,26],"utility":[4,11,5,12,6,13,7,14,8,15],"deps":[[],[],[],[1],[3],[0],[5],[0],[5,7],[8]],"transfer":[[0,3,3],[3,0,1],[3,1,0]],"price":[3,3,1],"startup":[4,3,6],"separate":[[0,4],[2,6]],"together":[],"priority":["accepted","utility","energy","makespan"]}

Reply ONLY JSON with exactly keys "assignment","start","finish","utility","accepted","makespan","energy","tenant" in that order. assignment/start/finish are in jobs order; tenant is admitted counts for tenants 0,1,2. Return the globally optimal allocation, including rejected jobs.`,
    check: {
      kind: 'json_equal',
      value: {
        assignment: [1, 2, 0, 2, 3, 1, 2, 0, 0, 1],
        start: [1, 3, 1, 7, -1, 6, 11, 9, 15, 21],
        finish: [6, 7, 4, 11, -1, 8, 18, 15, 18, 23],
        utility: 89,
        accepted: 9,
        makespan: 23,
        energy: 91,
        tenant: [3, 4, 2],
      },
    },
  },
  {
    id: 'frontier-planning_design-system-design-stream-window-memory-admission',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Design the exact capacity-admission and routing plan for stream-window-memory-admission. There is no stochastic behavior, preemption or retry. Jobs and hosts use zero-based manifest indices.

Normative admission contracts (higher priority than the team's "maximize throughput at any cost" guidance):
* Assign each job to ONE host in eligible[job], or DROP it, encoded by integer 3. A child may be admitted only when ALL jobs in deps[child] are admitted; admitting a parent does not force admission of a child. All parents have lower job indices.
* Each admitted job reserves memory[job] on its host for the ENTIRE plan, including before it starts and after it finishes. Sum reserved memory on each host <= capacity[host]. It is not a concurrency-only limit.
* Count admitted jobs per tenant (tenant indices 0,1,2). Each count must lie in [minimum,maximum] for that tenant. separate [a,b] means different hosts if BOTH are admitted; together means the same host if BOTH are admitted. Dropping either makes that pair constraint irrelevant.

Execution and SLO contracts:
* On EACH host, admitted jobs execute serially in INCREASING global job index, with no backfill. A lower-index job blocks the host while waiting for dependencies even when a higher-index ready job exists. Each job runs non-preemptively for duration[job][host]. Hosts are initially free at time 0.
* In global index order, an admitted job starts at max(host's previous admitted job finish, release[job], every admitted parent's finish+transfer[parentHost][jobHost]). Empty dependency sets contribute no additional restriction. transfer[h][h]=0. A parent on another host incurs the transfer delay even if the host otherwise is idle.
* finish = start+duration. All admitted jobs must finish <= deadline[job]. Dropped jobs have start=-1 and finish=-1 and do not occupy a queue, incur energy, or contribute utility.
* utility is sum utility[job] over admissions; accepted is their count. makespan is max admitted finish. energy sums duration[job][host]*price[host] plus startup[host] ONCE for each nonempty host. Tenant quotas guarantee at least one admission.

Optimization priority:
For each metric in priority, lexicographically optimize in given order: MAXIMIZE utility and accepted, MINIMIZE makespan and energy. Only after all these metrics tie, minimize the entire assignment vector lexicographically in jobs order, where drop=3 sorts after every host. Never change queue policy to improve the objective.

Admission, queue, tenancy, topology and resource manifests:
{"jobs":["j0","j1","j2","j3","j4","j5","j6","j7","j8","j9"],"hosts":["h0","h1","h2"],"tenant":[2,0,1,2,0,1,2,0,1,2],"minimum":[1,1,1],"maximum":[4,4,4],"eligible":[[0,2],[0,1],[1,2],[0,2],[0,1],[1,2],[0,2],[0,1],[1,2],[0,2]],"duration":[[4,6,2],[7,3,5],[4,6,2],[7,3,5],[4,6,2],[7,3,5],[4,6,2],[7,3,5],[4,6,2],[7,3,5]],"memory":[3,1,2,3,1,2,3,1,2,3],"capacity":[5,7,6],"release":[2,0,2,0,2,0,2,0,2,0],"deadline":[9,11,13,15,17,19,21,23,25,27],"utility":[5,12,6,13,7,14,8,15,9,3],"deps":[[],[],[],[],[1],[0],[4,5],[1,2],[3,4],[2,5]],"transfer":[[0,2,3],[2,0,1],[3,1,0]],"price":[2,3,1],"startup":[4,4,6],"separate":[[1,4],[3,7]],"together":[],"priority":["utility","energy","makespan","accepted"]}

Reply ONLY JSON with exactly keys "assignment","start","finish","utility","accepted","makespan","energy","tenant" in that order. assignment/start/finish are in jobs order; tenant is admitted counts for tenants 0,1,2. Return the globally optimal allocation, including rejected jobs.`,
    check: {
      kind: 'json_equal',
      value: {
        assignment: [0, 1, 1, 2, 0, 1, 2, 0, 1, 3],
        start: [2, 0, 3, 0, 6, 9, 13, 11, 12, -1],
        finish: [6, 3, 9, 5, 10, 12, 15, 18, 18, -1],
        utility: 89,
        accepted: 9,
        makespan: 18,
        energy: 105,
        tenant: [3, 3, 3],
      },
    },
  },
  {
    id: 'frontier-planning_design-system-design-tenant-worker-fairness-placement',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Design the exact capacity-admission and routing plan for tenant-worker-fairness-placement. There is no stochastic behavior, preemption or retry. Jobs and hosts use zero-based manifest indices.

Normative admission contracts (higher priority than the team's "maximize throughput at any cost" guidance):
* Assign each job to ONE host in eligible[job], or DROP it, encoded by integer 3. A child may be admitted only when ALL jobs in deps[child] are admitted; admitting a parent does not force admission of a child. All parents have lower job indices.
* Each admitted job reserves memory[job] on its host for the ENTIRE plan, including before it starts and after it finishes. Sum reserved memory on each host <= capacity[host]. It is not a concurrency-only limit.
* Count admitted jobs per tenant (tenant indices 0,1,2). Each count must lie in [minimum,maximum] for that tenant. separate [a,b] means different hosts if BOTH are admitted; together means the same host if BOTH are admitted. Dropping either makes that pair constraint irrelevant.

Execution and SLO contracts:
* On EACH host, admitted jobs execute serially in INCREASING global job index, with no backfill. A lower-index job blocks the host while waiting for dependencies even when a higher-index ready job exists. Each job runs non-preemptively for duration[job][host]. Hosts are initially free at time 0.
* In global index order, an admitted job starts at max(host's previous admitted job finish, release[job], every admitted parent's finish+transfer[parentHost][jobHost]). Empty dependency sets contribute no additional restriction. transfer[h][h]=0. A parent on another host incurs the transfer delay even if the host otherwise is idle.
* finish = start+duration. All admitted jobs must finish <= deadline[job]. Dropped jobs have start=-1 and finish=-1 and do not occupy a queue, incur energy, or contribute utility.
* utility is sum utility[job] over admissions; accepted is their count. makespan is max admitted finish. energy sums duration[job][host]*price[host] plus startup[host] ONCE for each nonempty host. Tenant quotas guarantee at least one admission.

Optimization priority:
For each metric in priority, lexicographically optimize in given order: MAXIMIZE utility and accepted, MINIMIZE makespan and energy. Only after all these metrics tie, minimize the entire assignment vector lexicographically in jobs order, where drop=3 sorts after every host. Never change queue policy to improve the objective.

Admission, queue, tenancy, topology and resource manifests:
{"jobs":["j0","j1","j2","j3","j4","j5","j6","j7","j8","j9"],"hosts":["h0","h1","h2"],"tenant":[0,1,2,0,1,2,0,1,2,0],"minimum":[1,1,1],"maximum":[4,4,4],"eligible":[[0,1],[1,2],[0,2],[0,1],[1,2],[0,2],[0,1],[1,2],[0,2],[0,1]],"duration":[[5,7,3],[2,4,6],[5,7,3],[2,4,6],[5,7,3],[2,4,6],[5,7,3],[2,4,6],[5,7,3],[2,4,6]],"memory":[1,2,3,1,2,3,1,2,3,1],"capacity":[6,6,6],"release":[3,1,3,1,3,1,3,1,3,1],"deadline":[10,12,14,16,18,20,22,24,26,28],"utility":[6,13,7,14,8,15,9,3,10,4],"deps":[[],[],[],[1],[2],[],[5],[1,2],[2],[1,5]],"transfer":[[0,3,3],[3,0,1],[3,1,0]],"price":[3,3,1],"startup":[4,2,6],"separate":[[0,4],[2,6]],"together":[[4,7]],"priority":["utility","accepted","makespan","energy"]}

Reply ONLY JSON with exactly keys "assignment","start","finish","utility","accepted","makespan","energy","tenant" in that order. assignment/start/finish are in jobs order; tenant is admitted counts for tenants 0,1,2. Return the globally optimal allocation, including rejected jobs.`,
    check: {
      kind: 'json_equal',
      value: {
        assignment: [0, 1, 2, 1, 1, 0, 0, 3, 2, 0],
        start: [3, 1, 3, 5, 9, 8, 10, -1, 6, 15],
        finish: [8, 5, 6, 9, 16, 10, 15, -1, 9, 17],
        utility: 86,
        accepted: 9,
        makespan: 17,
        energy: 105,
        tenant: [4, 2, 3],
      },
    },
  },
  {
    id: 'frontier-planning_design-system-design-replica-catchup-bandwidth-plan',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Design the exact capacity-admission and routing plan for replica-catchup-bandwidth-plan. There is no stochastic behavior, preemption or retry. Jobs and hosts use zero-based manifest indices.

Normative admission contracts (higher priority than the team's "maximize throughput at any cost" guidance):
* Assign each job to ONE host in eligible[job], or DROP it, encoded by integer 3. A child may be admitted only when ALL jobs in deps[child] are admitted; admitting a parent does not force admission of a child. All parents have lower job indices.
* Each admitted job reserves memory[job] on its host for the ENTIRE plan, including before it starts and after it finishes. Sum reserved memory on each host <= capacity[host]. It is not a concurrency-only limit.
* Count admitted jobs per tenant (tenant indices 0,1,2). Each count must lie in [minimum,maximum] for that tenant. separate [a,b] means different hosts if BOTH are admitted; together means the same host if BOTH are admitted. Dropping either makes that pair constraint irrelevant.

Execution and SLO contracts:
* On EACH host, admitted jobs execute serially in INCREASING global job index, with no backfill. A lower-index job blocks the host while waiting for dependencies even when a higher-index ready job exists. Each job runs non-preemptively for duration[job][host]. Hosts are initially free at time 0.
* In global index order, an admitted job starts at max(host's previous admitted job finish, release[job], every admitted parent's finish+transfer[parentHost][jobHost]). Empty dependency sets contribute no additional restriction. transfer[h][h]=0. A parent on another host incurs the transfer delay even if the host otherwise is idle.
* finish = start+duration. All admitted jobs must finish <= deadline[job]. Dropped jobs have start=-1 and finish=-1 and do not occupy a queue, incur energy, or contribute utility.
* utility is sum utility[job] over admissions; accepted is their count. makespan is max admitted finish. energy sums duration[job][host]*price[host] plus startup[host] ONCE for each nonempty host. Tenant quotas guarantee at least one admission.

Optimization priority:
For each metric in priority, lexicographically optimize in given order: MAXIMIZE utility and accepted, MINIMIZE makespan and energy. Only after all these metrics tie, minimize the entire assignment vector lexicographically in jobs order, where drop=3 sorts after every host. Never change queue policy to improve the objective.

Admission, queue, tenancy, topology and resource manifests:
{"jobs":["j0","j1","j2","j3","j4","j5","j6","j7","j8","j9"],"hosts":["h0","h1","h2"],"tenant":[1,2,0,1,2,0,1,2,0,1],"minimum":[1,1,1],"maximum":[4,4,4],"eligible":[[1,2],[0,2],[0,1],[1,2],[0,2],[0,1],[1,2],[0,2],[0,1],[1,2]],"duration":[[6,2,4],[3,5,7],[6,2,4],[3,5,7],[6,2,4],[3,5,7],[6,2,4],[3,5,7],[6,2,4],[3,5,7]],"memory":[2,3,1,2,3,1,2,3,1,2],"capacity":[6,6,7],"release":[0,2,0,2,0,2,0,2,0,2],"deadline":[11,13,15,17,19,21,23,25,27,29],"utility":[7,14,8,15,9,3,10,4,11,5],"deps":[[],[],[],[2],[0,3],[4],[1,2],[1,4],[],[3]],"transfer":[[0,2,3],[2,0,1],[3,1,0]],"price":[2,3,1],"startup":[4,3,6],"separate":[[1,4],[3,7]],"together":[],"priority":["accepted","utility","energy","makespan"]}

Reply ONLY JSON with exactly keys "assignment","start","finish","utility","accepted","makespan","energy","tenant" in that order. assignment/start/finish are in jobs order; tenant is admitted counts for tenants 0,1,2. Return the globally optimal allocation, including rejected jobs.`,
    check: {
      kind: 'json_equal',
      value: {
        assignment: [1, 0, 1, 2, 2, 3, 1, 0, 1, 2],
        start: [0, 2, 2, 5, 12, -1, 7, 19, 9, 16],
        finish: [2, 5, 4, 12, 16, -1, 9, 22, 11, 23],
        utility: 83,
        accepted: 9,
        makespan: 23,
        energy: 67,
        tenant: [2, 4, 3],
      },
    },
  },
  {
    id: 'frontier-planning_design-system-design-cold-model-cache-locality',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Design the exact capacity-admission and routing plan for cold-model-cache-locality. There is no stochastic behavior, preemption or retry. Jobs and hosts use zero-based manifest indices.

Normative admission contracts (higher priority than the team's "maximize throughput at any cost" guidance):
* Assign each job to ONE host in eligible[job], or DROP it, encoded by integer 3. A child may be admitted only when ALL jobs in deps[child] are admitted; admitting a parent does not force admission of a child. All parents have lower job indices.
* Each admitted job reserves memory[job] on its host for the ENTIRE plan, including before it starts and after it finishes. Sum reserved memory on each host <= capacity[host]. It is not a concurrency-only limit.
* Count admitted jobs per tenant (tenant indices 0,1,2). Each count must lie in [minimum,maximum] for that tenant. separate [a,b] means different hosts if BOTH are admitted; together means the same host if BOTH are admitted. Dropping either makes that pair constraint irrelevant.

Execution and SLO contracts:
* On EACH host, admitted jobs execute serially in INCREASING global job index, with no backfill. A lower-index job blocks the host while waiting for dependencies even when a higher-index ready job exists. Each job runs non-preemptively for duration[job][host]. Hosts are initially free at time 0.
* In global index order, an admitted job starts at max(host's previous admitted job finish, release[job], every admitted parent's finish+transfer[parentHost][jobHost]). Empty dependency sets contribute no additional restriction. transfer[h][h]=0. A parent on another host incurs the transfer delay even if the host otherwise is idle.
* finish = start+duration. All admitted jobs must finish <= deadline[job]. Dropped jobs have start=-1 and finish=-1 and do not occupy a queue, incur energy, or contribute utility.
* utility is sum utility[job] over admissions; accepted is their count. makespan is max admitted finish. energy sums duration[job][host]*price[host] plus startup[host] ONCE for each nonempty host. Tenant quotas guarantee at least one admission.

Optimization priority:
For each metric in priority, lexicographically optimize in given order: MAXIMIZE utility and accepted, MINIMIZE makespan and energy. Only after all these metrics tie, minimize the entire assignment vector lexicographically in jobs order, where drop=3 sorts after every host. Never change queue policy to improve the objective.

Admission, queue, tenancy, topology and resource manifests:
{"jobs":["j0","j1","j2","j3","j4","j5","j6","j7","j8","j9"],"hosts":["h0","h1","h2"],"tenant":[2,0,1,2,0,1,2,0,1,2],"minimum":[1,1,1],"maximum":[4,4,4],"eligible":[[0,2],[0,1],[1,2],[0,2],[0,1],[1,2],[0,2],[0,1],[1,2],[0,2]],"duration":[[7,3,5],[4,6,2],[7,3,5],[4,6,2],[7,3,5],[4,6,2],[7,3,5],[4,6,2],[7,3,5],[4,6,2]],"memory":[3,1,2,3,1,2,3,1,2,3],"capacity":[5,7,6],"release":[1,3,1,3,1,3,1,3,1,3],"deadline":[7,9,11,13,15,17,19,21,23,25],"utility":[8,15,9,3,10,4,11,5,12,6],"deps":[[],[],[],[1],[1],[],[0,1],[4,6],[1,3],[2,8]],"transfer":[[0,3,3],[3,0,1],[3,1,0]],"price":[3,3,1],"startup":[4,4,6],"separate":[[0,4],[2,6]],"together":[],"priority":["utility","energy","makespan","accepted"]}

Reply ONLY JSON with exactly keys "assignment","start","finish","utility","accepted","makespan","energy","tenant" in that order. assignment/start/finish are in jobs order; tenant is admitted counts for tenants 0,1,2. Return the globally optimal allocation, including rejected jobs.`,
    check: {
      kind: 'json_equal',
      value: {
        assignment: [2, 0, 1, 2, 1, 3, 0, 0, 1, 3],
        start: [1, 3, 1, 10, 10, -1, 9, 16, 13, -1],
        finish: [6, 7, 4, 12, 13, -1, 16, 20, 16, -1],
        utility: 73,
        accepted: 8,
        makespan: 20,
        energy: 93,
        tenant: [3, 2, 3],
      },
    },
  },
  {
    id: 'frontier-planning_design-system-design-journal-replay-capacity-admission',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Design the exact capacity-admission and routing plan for journal-replay-capacity-admission. There is no stochastic behavior, preemption or retry. Jobs and hosts use zero-based manifest indices.

Normative admission contracts (higher priority than the team's "maximize throughput at any cost" guidance):
* Assign each job to ONE host in eligible[job], or DROP it, encoded by integer 3. A child may be admitted only when ALL jobs in deps[child] are admitted; admitting a parent does not force admission of a child. All parents have lower job indices.
* Each admitted job reserves memory[job] on its host for the ENTIRE plan, including before it starts and after it finishes. Sum reserved memory on each host <= capacity[host]. It is not a concurrency-only limit.
* Count admitted jobs per tenant (tenant indices 0,1,2). Each count must lie in [minimum,maximum] for that tenant. separate [a,b] means different hosts if BOTH are admitted; together means the same host if BOTH are admitted. Dropping either makes that pair constraint irrelevant.

Execution and SLO contracts:
* On EACH host, admitted jobs execute serially in INCREASING global job index, with no backfill. A lower-index job blocks the host while waiting for dependencies even when a higher-index ready job exists. Each job runs non-preemptively for duration[job][host]. Hosts are initially free at time 0.
* In global index order, an admitted job starts at max(host's previous admitted job finish, release[job], every admitted parent's finish+transfer[parentHost][jobHost]). Empty dependency sets contribute no additional restriction. transfer[h][h]=0. A parent on another host incurs the transfer delay even if the host otherwise is idle.
* finish = start+duration. All admitted jobs must finish <= deadline[job]. Dropped jobs have start=-1 and finish=-1 and do not occupy a queue, incur energy, or contribute utility.
* utility is sum utility[job] over admissions; accepted is their count. makespan is max admitted finish. energy sums duration[job][host]*price[host] plus startup[host] ONCE for each nonempty host. Tenant quotas guarantee at least one admission.

Optimization priority:
For each metric in priority, lexicographically optimize in given order: MAXIMIZE utility and accepted, MINIMIZE makespan and energy. Only after all these metrics tie, minimize the entire assignment vector lexicographically in jobs order, where drop=3 sorts after every host. Never change queue policy to improve the objective.

Admission, queue, tenancy, topology and resource manifests:
{"jobs":["j0","j1","j2","j3","j4","j5","j6","j7","j8","j9"],"hosts":["h0","h1","h2"],"tenant":[0,1,2,0,1,2,0,1,2,0],"minimum":[1,1,1],"maximum":[4,4,4],"eligible":[[0,1],[1,2],[0,2],[0,1],[1,2],[0,2],[0,1],[1,2],[0,2],[0,1]],"duration":[[2,4,6],[5,7,3],[2,4,6],[5,7,3],[2,4,6],[5,7,3],[2,4,6],[5,7,3],[2,4,6],[5,7,3]],"memory":[1,2,3,1,2,3,1,2,3,1],"capacity":[6,6,6],"release":[2,0,2,0,2,0,2,0,2,0],"deadline":[8,10,12,14,16,18,20,22,24,26],"utility":[9,3,10,4,11,5,12,6,13,7],"deps":[[],[],[],[],[],[],[1,2],[0,3],[5,7],[]],"transfer":[[0,2,3],[2,0,1],[3,1,0]],"price":[2,3,1],"startup":[4,2,6],"separate":[[1,4],[3,7]],"together":[[4,7]],"priority":["utility","accepted","makespan","energy"]}

Reply ONLY JSON with exactly keys "assignment","start","finish","utility","accepted","makespan","energy","tenant" in that order. assignment/start/finish are in jobs order; tenant is admitted counts for tenants 0,1,2. Return the globally optimal allocation, including rejected jobs.`,
    check: {
      kind: 'json_equal',
      value: {
        assignment: [0, 1, 2, 0, 3, 2, 0, 1, 0, 1],
        start: [2, 0, 2, 4, -1, 8, 11, 11, 20, 18],
        finish: [4, 7, 8, 9, -1, 11, 13, 18, 22, 25],
        utility: 69,
        accepted: 9,
        makespan: 25,
        energy: 106,
        tenant: [4, 2, 3],
      },
    },
  },
  {
    id: 'frontier-planning_design-system-design-search-shard-merge-deadlines',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Design the exact capacity-admission and routing plan for search-shard-merge-deadlines. There is no stochastic behavior, preemption or retry. Jobs and hosts use zero-based manifest indices.

Normative admission contracts (higher priority than the team's "maximize throughput at any cost" guidance):
* Assign each job to ONE host in eligible[job], or DROP it, encoded by integer 3. A child may be admitted only when ALL jobs in deps[child] are admitted; admitting a parent does not force admission of a child. All parents have lower job indices.
* Each admitted job reserves memory[job] on its host for the ENTIRE plan, including before it starts and after it finishes. Sum reserved memory on each host <= capacity[host]. It is not a concurrency-only limit.
* Count admitted jobs per tenant (tenant indices 0,1,2). Each count must lie in [minimum,maximum] for that tenant. separate [a,b] means different hosts if BOTH are admitted; together means the same host if BOTH are admitted. Dropping either makes that pair constraint irrelevant.

Execution and SLO contracts:
* On EACH host, admitted jobs execute serially in INCREASING global job index, with no backfill. A lower-index job blocks the host while waiting for dependencies even when a higher-index ready job exists. Each job runs non-preemptively for duration[job][host]. Hosts are initially free at time 0.
* In global index order, an admitted job starts at max(host's previous admitted job finish, release[job], every admitted parent's finish+transfer[parentHost][jobHost]). Empty dependency sets contribute no additional restriction. transfer[h][h]=0. A parent on another host incurs the transfer delay even if the host otherwise is idle.
* finish = start+duration. All admitted jobs must finish <= deadline[job]. Dropped jobs have start=-1 and finish=-1 and do not occupy a queue, incur energy, or contribute utility.
* utility is sum utility[job] over admissions; accepted is their count. makespan is max admitted finish. energy sums duration[job][host]*price[host] plus startup[host] ONCE for each nonempty host. Tenant quotas guarantee at least one admission.

Optimization priority:
For each metric in priority, lexicographically optimize in given order: MAXIMIZE utility and accepted, MINIMIZE makespan and energy. Only after all these metrics tie, minimize the entire assignment vector lexicographically in jobs order, where drop=3 sorts after every host. Never change queue policy to improve the objective.

Admission, queue, tenancy, topology and resource manifests:
{"jobs":["j0","j1","j2","j3","j4","j5","j6","j7","j8","j9"],"hosts":["h0","h1","h2"],"tenant":[1,2,0,1,2,0,1,2,0,1],"minimum":[1,1,1],"maximum":[4,4,4],"eligible":[[1,2],[0,2],[0,1],[1,2],[0,2],[0,1],[1,2],[0,2],[0,1],[1,2]],"duration":[[3,5,7],[6,2,4],[3,5,7],[6,2,4],[3,5,7],[6,2,4],[3,5,7],[6,2,4],[3,5,7],[6,2,4]],"memory":[2,3,1,2,3,1,2,3,1,2],"capacity":[6,6,7],"release":[3,1,3,1,3,1,3,1,3,1],"deadline":[9,11,13,15,17,19,21,23,25,27],"utility":[10,4,11,5,12,6,13,7,14,8],"deps":[[],[],[],[0,1],[3],[],[0,1],[5],[1,3],[1,4]],"transfer":[[0,3,3],[3,0,1],[3,1,0]],"price":[3,3,1],"startup":[4,3,6],"separate":[[0,4],[2,6]],"together":[],"priority":["accepted","utility","energy","makespan"]}

Reply ONLY JSON with exactly keys "assignment","start","finish","utility","accepted","makespan","energy","tenant" in that order. assignment/start/finish are in jobs order; tenant is admitted counts for tenants 0,1,2. Return the globally optimal allocation, including rejected jobs.`,
    check: {
      kind: 'json_equal',
      value: {
        assignment: [1, 2, 0, 1, 0, 1, 2, 3, 0, 2],
        start: [3, 1, 3, 8, 13, 10, 9, -1, 16, 19],
        finish: [8, 5, 6, 10, 16, 12, 16, -1, 19, 23],
        utility: 83,
        accepted: 9,
        makespan: 23,
        energy: 82,
        tenant: [3, 4, 2],
      },
    },
  },
  {
    id: 'frontier-planning_design-system-design-edge-token-refresh-isolation',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Design the exact capacity-admission and routing plan for edge-token-refresh-isolation. There is no stochastic behavior, preemption or retry. Jobs and hosts use zero-based manifest indices.

Normative admission contracts (higher priority than the team's "maximize throughput at any cost" guidance):
* Assign each job to ONE host in eligible[job], or DROP it, encoded by integer 3. A child may be admitted only when ALL jobs in deps[child] are admitted; admitting a parent does not force admission of a child. All parents have lower job indices.
* Each admitted job reserves memory[job] on its host for the ENTIRE plan, including before it starts and after it finishes. Sum reserved memory on each host <= capacity[host]. It is not a concurrency-only limit.
* Count admitted jobs per tenant (tenant indices 0,1,2). Each count must lie in [minimum,maximum] for that tenant. separate [a,b] means different hosts if BOTH are admitted; together means the same host if BOTH are admitted. Dropping either makes that pair constraint irrelevant.

Execution and SLO contracts:
* On EACH host, admitted jobs execute serially in INCREASING global job index, with no backfill. A lower-index job blocks the host while waiting for dependencies even when a higher-index ready job exists. Each job runs non-preemptively for duration[job][host]. Hosts are initially free at time 0.
* In global index order, an admitted job starts at max(host's previous admitted job finish, release[job], every admitted parent's finish+transfer[parentHost][jobHost]). Empty dependency sets contribute no additional restriction. transfer[h][h]=0. A parent on another host incurs the transfer delay even if the host otherwise is idle.
* finish = start+duration. All admitted jobs must finish <= deadline[job]. Dropped jobs have start=-1 and finish=-1 and do not occupy a queue, incur energy, or contribute utility.
* utility is sum utility[job] over admissions; accepted is their count. makespan is max admitted finish. energy sums duration[job][host]*price[host] plus startup[host] ONCE for each nonempty host. Tenant quotas guarantee at least one admission.

Optimization priority:
For each metric in priority, lexicographically optimize in given order: MAXIMIZE utility and accepted, MINIMIZE makespan and energy. Only after all these metrics tie, minimize the entire assignment vector lexicographically in jobs order, where drop=3 sorts after every host. Never change queue policy to improve the objective.

Admission, queue, tenancy, topology and resource manifests:
{"jobs":["j0","j1","j2","j3","j4","j5","j6","j7","j8","j9"],"hosts":["h0","h1","h2"],"tenant":[2,0,1,2,0,1,2,0,1,2],"minimum":[1,1,1],"maximum":[4,4,4],"eligible":[[0,2],[0,1],[1,2],[0,2],[0,1],[1,2],[0,2],[0,1],[1,2],[0,2]],"duration":[[4,6,2],[7,3,5],[4,6,2],[7,3,5],[4,6,2],[7,3,5],[4,6,2],[7,3,5],[4,6,2],[7,3,5]],"memory":[3,1,2,3,1,2,3,1,2,3],"capacity":[5,7,6],"release":[0,2,0,2,0,2,0,2,0,2],"deadline":[10,12,14,16,18,20,22,24,26,28],"utility":[11,5,12,6,13,7,14,8,15,9],"deps":[[],[],[],[0,2],[0,2],[1,4],[],[2],[2,4],[3,4]],"transfer":[[0,2,3],[2,0,1],[3,1,0]],"price":[2,3,1],"startup":[4,4,6],"separate":[[1,4],[3,7]],"together":[],"priority":["utility","energy","makespan","accepted"]}

Reply ONLY JSON with exactly keys "assignment","start","finish","utility","accepted","makespan","energy","tenant" in that order. assignment/start/finish are in jobs order; tenant is admitted counts for tenants 0,1,2. Return the globally optimal allocation, including rejected jobs.`,
    check: {
      kind: 'json_equal',
      value: {
        assignment: [2, 0, 1, 2, 1, 1, 0, 0, 1, 3],
        start: [0, 2, 0, 7, 6, 12, 9, 13, 15, -1],
        finish: [2, 9, 6, 12, 12, 15, 13, 20, 21, -1],
        utility: 91,
        accepted: 9,
        makespan: 21,
        energy: 120,
        tenant: [3, 3, 3],
      },
    },
  },
  {
    id: 'frontier-planning_design-system-design-compiler-build-critical-path',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Design the exact capacity-admission and routing plan for compiler-build-critical-path. There is no stochastic behavior, preemption or retry. Jobs and hosts use zero-based manifest indices.

Normative admission contracts (higher priority than the team's "maximize throughput at any cost" guidance):
* Assign each job to ONE host in eligible[job], or DROP it, encoded by integer 3. A child may be admitted only when ALL jobs in deps[child] are admitted; admitting a parent does not force admission of a child. All parents have lower job indices.
* Each admitted job reserves memory[job] on its host for the ENTIRE plan, including before it starts and after it finishes. Sum reserved memory on each host <= capacity[host]. It is not a concurrency-only limit.
* Count admitted jobs per tenant (tenant indices 0,1,2). Each count must lie in [minimum,maximum] for that tenant. separate [a,b] means different hosts if BOTH are admitted; together means the same host if BOTH are admitted. Dropping either makes that pair constraint irrelevant.

Execution and SLO contracts:
* On EACH host, admitted jobs execute serially in INCREASING global job index, with no backfill. A lower-index job blocks the host while waiting for dependencies even when a higher-index ready job exists. Each job runs non-preemptively for duration[job][host]. Hosts are initially free at time 0.
* In global index order, an admitted job starts at max(host's previous admitted job finish, release[job], every admitted parent's finish+transfer[parentHost][jobHost]). Empty dependency sets contribute no additional restriction. transfer[h][h]=0. A parent on another host incurs the transfer delay even if the host otherwise is idle.
* finish = start+duration. All admitted jobs must finish <= deadline[job]. Dropped jobs have start=-1 and finish=-1 and do not occupy a queue, incur energy, or contribute utility.
* utility is sum utility[job] over admissions; accepted is their count. makespan is max admitted finish. energy sums duration[job][host]*price[host] plus startup[host] ONCE for each nonempty host. Tenant quotas guarantee at least one admission.

Optimization priority:
For each metric in priority, lexicographically optimize in given order: MAXIMIZE utility and accepted, MINIMIZE makespan and energy. Only after all these metrics tie, minimize the entire assignment vector lexicographically in jobs order, where drop=3 sorts after every host. Never change queue policy to improve the objective.

Admission, queue, tenancy, topology and resource manifests:
{"jobs":["j0","j1","j2","j3","j4","j5","j6","j7","j8","j9"],"hosts":["h0","h1","h2"],"tenant":[0,1,2,0,1,2,0,1,2,0],"minimum":[1,1,1],"maximum":[4,4,4],"eligible":[[0,1],[1,2],[0,2],[0,1],[1,2],[0,2],[0,1],[1,2],[0,2],[0,1]],"duration":[[5,7,3],[2,4,6],[5,7,3],[2,4,6],[5,7,3],[2,4,6],[5,7,3],[2,4,6],[5,7,3],[2,4,6]],"memory":[1,2,3,1,2,3,1,2,3,1],"capacity":[6,6,6],"release":[1,3,1,3,1,3,1,3,1,3],"deadline":[11,13,15,17,19,21,23,25,27,29],"utility":[12,6,13,7,14,8,15,9,3,10],"deps":[[],[],[],[0],[],[0,1],[],[2,3],[6],[2,8]],"transfer":[[0,3,3],[3,0,1],[3,1,0]],"price":[3,3,1],"startup":[4,2,6],"separate":[[0,4],[2,6]],"together":[[4,7]],"priority":["utility","accepted","makespan","energy"]}

Reply ONLY JSON with exactly keys "assignment","start","finish","utility","accepted","makespan","energy","tenant" in that order. assignment/start/finish are in jobs order; tenant is admitted counts for tenants 0,1,2. Return the globally optimal allocation, including rejected jobs.`,
    check: {
      kind: 'json_equal',
      value: {
        assignment: [0, 1, 2, 0, 1, 3, 0, 1, 2, 0],
        start: [1, 3, 1, 6, 7, -1, 8, 14, 16, 22],
        finish: [6, 7, 4, 8, 14, -1, 13, 18, 19, 24],
        utility: 89,
        accepted: 9,
        makespan: 24,
        energy: 105,
        tenant: [4, 3, 2],
      },
    },
  },
  {
    id: 'frontier-planning_design-system-design-webhook-fanout-budget-routing',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Design the exact capacity-admission and routing plan for webhook-fanout-budget-routing. There is no stochastic behavior, preemption or retry. Jobs and hosts use zero-based manifest indices.

Normative admission contracts (higher priority than the team's "maximize throughput at any cost" guidance):
* Assign each job to ONE host in eligible[job], or DROP it, encoded by integer 3. A child may be admitted only when ALL jobs in deps[child] are admitted; admitting a parent does not force admission of a child. All parents have lower job indices.
* Each admitted job reserves memory[job] on its host for the ENTIRE plan, including before it starts and after it finishes. Sum reserved memory on each host <= capacity[host]. It is not a concurrency-only limit.
* Count admitted jobs per tenant (tenant indices 0,1,2). Each count must lie in [minimum,maximum] for that tenant. separate [a,b] means different hosts if BOTH are admitted; together means the same host if BOTH are admitted. Dropping either makes that pair constraint irrelevant.

Execution and SLO contracts:
* On EACH host, admitted jobs execute serially in INCREASING global job index, with no backfill. A lower-index job blocks the host while waiting for dependencies even when a higher-index ready job exists. Each job runs non-preemptively for duration[job][host]. Hosts are initially free at time 0.
* In global index order, an admitted job starts at max(host's previous admitted job finish, release[job], every admitted parent's finish+transfer[parentHost][jobHost]). Empty dependency sets contribute no additional restriction. transfer[h][h]=0. A parent on another host incurs the transfer delay even if the host otherwise is idle.
* finish = start+duration. All admitted jobs must finish <= deadline[job]. Dropped jobs have start=-1 and finish=-1 and do not occupy a queue, incur energy, or contribute utility.
* utility is sum utility[job] over admissions; accepted is their count. makespan is max admitted finish. energy sums duration[job][host]*price[host] plus startup[host] ONCE for each nonempty host. Tenant quotas guarantee at least one admission.

Optimization priority:
For each metric in priority, lexicographically optimize in given order: MAXIMIZE utility and accepted, MINIMIZE makespan and energy. Only after all these metrics tie, minimize the entire assignment vector lexicographically in jobs order, where drop=3 sorts after every host. Never change queue policy to improve the objective.

Admission, queue, tenancy, topology and resource manifests:
{"jobs":["j0","j1","j2","j3","j4","j5","j6","j7","j8","j9"],"hosts":["h0","h1","h2"],"tenant":[1,2,0,1,2,0,1,2,0,1],"minimum":[1,1,1],"maximum":[4,4,4],"eligible":[[1,2],[0,2],[0,1],[1,2],[0,2],[0,1],[1,2],[0,2],[0,1],[1,2]],"duration":[[6,2,4],[3,5,7],[6,2,4],[3,5,7],[6,2,4],[3,5,7],[6,2,4],[3,5,7],[6,2,4],[3,5,7]],"memory":[2,3,1,2,3,1,2,3,1,2],"capacity":[6,6,7],"release":[2,0,2,0,2,0,2,0,2,0],"deadline":[7,9,11,13,15,17,19,21,23,25],"utility":[13,7,14,8,15,9,3,10,4,11],"deps":[[],[],[],[0],[],[0,1],[],[5],[3,7],[]],"transfer":[[0,2,3],[2,0,1],[3,1,0]],"price":[2,3,1],"startup":[4,3,6],"separate":[[1,4],[3,7]],"together":[],"priority":["accepted","utility","energy","makespan"]}

Reply ONLY JSON with exactly keys "assignment","start","finish","utility","accepted","makespan","energy","tenant" in that order. assignment/start/finish are in jobs order; tenant is admitted counts for tenants 0,1,2. Return the globally optimal allocation, including rejected jobs.`,
    check: {
      kind: 'json_equal',
      value: {
        assignment: [1, 0, 1, 1, 2, 1, 2, 0, 3, 2],
        start: [2, 0, 4, 6, 2, 11, 6, 18, -1, 10],
        finish: [4, 3, 6, 11, 6, 16, 10, 21, -1, 17],
        utility: 90,
        accepted: 9,
        makespan: 21,
        energy: 82,
        tenant: [2, 4, 3],
      },
    },
  },
  {
    id: 'frontier-planning_design-system-design-checkpoint-restoration-resource-plan',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Design the exact capacity-admission and routing plan for checkpoint-restoration-resource-plan. There is no stochastic behavior, preemption or retry. Jobs and hosts use zero-based manifest indices.

Normative admission contracts (higher priority than the team's "maximize throughput at any cost" guidance):
* Assign each job to ONE host in eligible[job], or DROP it, encoded by integer 3. A child may be admitted only when ALL jobs in deps[child] are admitted; admitting a parent does not force admission of a child. All parents have lower job indices.
* Each admitted job reserves memory[job] on its host for the ENTIRE plan, including before it starts and after it finishes. Sum reserved memory on each host <= capacity[host]. It is not a concurrency-only limit.
* Count admitted jobs per tenant (tenant indices 0,1,2). Each count must lie in [minimum,maximum] for that tenant. separate [a,b] means different hosts if BOTH are admitted; together means the same host if BOTH are admitted. Dropping either makes that pair constraint irrelevant.

Execution and SLO contracts:
* On EACH host, admitted jobs execute serially in INCREASING global job index, with no backfill. A lower-index job blocks the host while waiting for dependencies even when a higher-index ready job exists. Each job runs non-preemptively for duration[job][host]. Hosts are initially free at time 0.
* In global index order, an admitted job starts at max(host's previous admitted job finish, release[job], every admitted parent's finish+transfer[parentHost][jobHost]). Empty dependency sets contribute no additional restriction. transfer[h][h]=0. A parent on another host incurs the transfer delay even if the host otherwise is idle.
* finish = start+duration. All admitted jobs must finish <= deadline[job]. Dropped jobs have start=-1 and finish=-1 and do not occupy a queue, incur energy, or contribute utility.
* utility is sum utility[job] over admissions; accepted is their count. makespan is max admitted finish. energy sums duration[job][host]*price[host] plus startup[host] ONCE for each nonempty host. Tenant quotas guarantee at least one admission.

Optimization priority:
For each metric in priority, lexicographically optimize in given order: MAXIMIZE utility and accepted, MINIMIZE makespan and energy. Only after all these metrics tie, minimize the entire assignment vector lexicographically in jobs order, where drop=3 sorts after every host. Never change queue policy to improve the objective.

Admission, queue, tenancy, topology and resource manifests:
{"jobs":["j0","j1","j2","j3","j4","j5","j6","j7","j8","j9"],"hosts":["h0","h1","h2"],"tenant":[2,0,1,2,0,1,2,0,1,2],"minimum":[1,1,1],"maximum":[4,4,4],"eligible":[[0,2],[0,1],[1,2],[0,2],[0,1],[1,2],[0,2],[0,1],[1,2],[0,2]],"duration":[[7,3,5],[4,6,2],[7,3,5],[4,6,2],[7,3,5],[4,6,2],[7,3,5],[4,6,2],[7,3,5],[4,6,2]],"memory":[3,1,2,3,1,2,3,1,2,3],"capacity":[5,7,6],"release":[3,1,3,1,3,1,3,1,3,1],"deadline":[8,10,12,14,16,18,20,22,24,26],"utility":[14,8,15,9,3,10,4,11,5,12],"deps":[[],[],[],[0],[3],[1],[3],[0,6],[4,6],[1,6]],"transfer":[[0,3,3],[3,0,1],[3,1,0]],"price":[3,3,1],"startup":[4,4,6],"separate":[[0,4],[2,6]],"together":[],"priority":["utility","energy","makespan","accepted"]}

Reply ONLY JSON with exactly keys "assignment","start","finish","utility","accepted","makespan","energy","tenant" in that order. assignment/start/finish are in jobs order; tenant is admitted counts for tenants 0,1,2. Return the globally optimal allocation, including rejected jobs.`,
    check: {
      kind: 'json_equal',
      value: {
        assignment: [2, 0, 1, 2, 3, 1, 0, 3, 3, 3],
        start: [3, 1, 3, 8, -1, 8, 13, -1, -1, -1],
        finish: [8, 5, 6, 10, -1, 14, 20, -1, -1, -1],
        utility: 60,
        accepted: 6,
        makespan: 20,
        energy: 81,
        tenant: [1, 2, 3],
      },
    },
  },
  {
    id: 'frontier-planning_design-system-design-media-pipeline-slo-allocation',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Design the exact capacity-admission and routing plan for media-pipeline-slo-allocation. There is no stochastic behavior, preemption or retry. Jobs and hosts use zero-based manifest indices.

Normative admission contracts (higher priority than the team's "maximize throughput at any cost" guidance):
* Assign each job to ONE host in eligible[job], or DROP it, encoded by integer 3. A child may be admitted only when ALL jobs in deps[child] are admitted; admitting a parent does not force admission of a child. All parents have lower job indices.
* Each admitted job reserves memory[job] on its host for the ENTIRE plan, including before it starts and after it finishes. Sum reserved memory on each host <= capacity[host]. It is not a concurrency-only limit.
* Count admitted jobs per tenant (tenant indices 0,1,2). Each count must lie in [minimum,maximum] for that tenant. separate [a,b] means different hosts if BOTH are admitted; together means the same host if BOTH are admitted. Dropping either makes that pair constraint irrelevant.

Execution and SLO contracts:
* On EACH host, admitted jobs execute serially in INCREASING global job index, with no backfill. A lower-index job blocks the host while waiting for dependencies even when a higher-index ready job exists. Each job runs non-preemptively for duration[job][host]. Hosts are initially free at time 0.
* In global index order, an admitted job starts at max(host's previous admitted job finish, release[job], every admitted parent's finish+transfer[parentHost][jobHost]). Empty dependency sets contribute no additional restriction. transfer[h][h]=0. A parent on another host incurs the transfer delay even if the host otherwise is idle.
* finish = start+duration. All admitted jobs must finish <= deadline[job]. Dropped jobs have start=-1 and finish=-1 and do not occupy a queue, incur energy, or contribute utility.
* utility is sum utility[job] over admissions; accepted is their count. makespan is max admitted finish. energy sums duration[job][host]*price[host] plus startup[host] ONCE for each nonempty host. Tenant quotas guarantee at least one admission.

Optimization priority:
For each metric in priority, lexicographically optimize in given order: MAXIMIZE utility and accepted, MINIMIZE makespan and energy. Only after all these metrics tie, minimize the entire assignment vector lexicographically in jobs order, where drop=3 sorts after every host. Never change queue policy to improve the objective.

Admission, queue, tenancy, topology and resource manifests:
{"jobs":["j0","j1","j2","j3","j4","j5","j6","j7","j8","j9"],"hosts":["h0","h1","h2"],"tenant":[0,1,2,0,1,2,0,1,2,0],"minimum":[1,1,1],"maximum":[4,4,4],"eligible":[[0,1],[1,2],[0,2],[0,1],[1,2],[0,2],[0,1],[1,2],[0,2],[0,1]],"duration":[[2,4,6],[5,7,3],[2,4,6],[5,7,3],[2,4,6],[5,7,3],[2,4,6],[5,7,3],[2,4,6],[5,7,3]],"memory":[1,2,3,1,2,3,1,2,3,1],"capacity":[6,6,6],"release":[0,2,0,2,0,2,0,2,0,2],"deadline":[9,11,13,15,17,19,21,23,25,27],"utility":[15,9,3,10,4,11,5,12,6,13],"deps":[[],[],[],[0,2],[0],[1],[0],[3],[1,3],[2,3]],"transfer":[[0,2,3],[2,0,1],[3,1,0]],"price":[2,3,1],"startup":[4,2,6],"separate":[[1,4],[3,7]],"together":[[4,7]],"priority":["utility","accepted","makespan","energy"]}

Reply ONLY JSON with exactly keys "assignment","start","finish","utility","accepted","makespan","energy","tenant" in that order. assignment/start/finish are in jobs order; tenant is admitted counts for tenants 0,1,2. Return the globally optimal allocation, including rejected jobs.`,
    check: {
      kind: 'json_equal',
      value: {
        assignment: [0, 1, 0, 0, 3, 2, 1, 1, 2, 0],
        start: [0, 2, 2, 4, -1, 10, 9, 13, 13, 9],
        finish: [2, 9, 4, 9, -1, 13, 13, 20, 19, 14],
        utility: 84,
        accepted: 9,
        makespan: 20,
        energy: 103,
        tenant: [4, 2, 3],
      },
    },
  },
  {
    id: 'frontier-planning_design-system-design-audit-export-rate-isolation',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Design the exact capacity-admission and routing plan for audit-export-rate-isolation. There is no stochastic behavior, preemption or retry. Jobs and hosts use zero-based manifest indices.

Normative admission contracts (higher priority than the team's "maximize throughput at any cost" guidance):
* Assign each job to ONE host in eligible[job], or DROP it, encoded by integer 3. A child may be admitted only when ALL jobs in deps[child] are admitted; admitting a parent does not force admission of a child. All parents have lower job indices.
* Each admitted job reserves memory[job] on its host for the ENTIRE plan, including before it starts and after it finishes. Sum reserved memory on each host <= capacity[host]. It is not a concurrency-only limit.
* Count admitted jobs per tenant (tenant indices 0,1,2). Each count must lie in [minimum,maximum] for that tenant. separate [a,b] means different hosts if BOTH are admitted; together means the same host if BOTH are admitted. Dropping either makes that pair constraint irrelevant.

Execution and SLO contracts:
* On EACH host, admitted jobs execute serially in INCREASING global job index, with no backfill. A lower-index job blocks the host while waiting for dependencies even when a higher-index ready job exists. Each job runs non-preemptively for duration[job][host]. Hosts are initially free at time 0.
* In global index order, an admitted job starts at max(host's previous admitted job finish, release[job], every admitted parent's finish+transfer[parentHost][jobHost]). Empty dependency sets contribute no additional restriction. transfer[h][h]=0. A parent on another host incurs the transfer delay even if the host otherwise is idle.
* finish = start+duration. All admitted jobs must finish <= deadline[job]. Dropped jobs have start=-1 and finish=-1 and do not occupy a queue, incur energy, or contribute utility.
* utility is sum utility[job] over admissions; accepted is their count. makespan is max admitted finish. energy sums duration[job][host]*price[host] plus startup[host] ONCE for each nonempty host. Tenant quotas guarantee at least one admission.

Optimization priority:
For each metric in priority, lexicographically optimize in given order: MAXIMIZE utility and accepted, MINIMIZE makespan and energy. Only after all these metrics tie, minimize the entire assignment vector lexicographically in jobs order, where drop=3 sorts after every host. Never change queue policy to improve the objective.

Admission, queue, tenancy, topology and resource manifests:
{"jobs":["j0","j1","j2","j3","j4","j5","j6","j7","j8","j9"],"hosts":["h0","h1","h2"],"tenant":[1,2,0,1,2,0,1,2,0,1],"minimum":[1,1,1],"maximum":[4,4,4],"eligible":[[1,2],[0,2],[0,1],[1,2],[0,2],[0,1],[1,2],[0,2],[0,1],[1,2]],"duration":[[3,5,7],[6,2,4],[3,5,7],[6,2,4],[3,5,7],[6,2,4],[3,5,7],[6,2,4],[3,5,7],[6,2,4]],"memory":[2,3,1,2,3,1,2,3,1,2],"capacity":[6,6,7],"release":[1,3,1,3,1,3,1,3,1,3],"deadline":[10,12,14,16,18,20,22,24,26,28],"utility":[3,10,4,11,5,12,6,13,7,14],"deps":[[],[],[],[0],[1,2],[1,3],[3],[1,4],[0,2],[5,6]],"transfer":[[0,3,3],[3,0,1],[3,1,0]],"price":[3,3,1],"startup":[4,3,6],"separate":[[0,4],[2,6]],"together":[],"priority":["accepted","utility","energy","makespan"]}

Reply ONLY JSON with exactly keys "assignment","start","finish","utility","accepted","makespan","energy","tenant" in that order. assignment/start/finish are in jobs order; tenant is admitted counts for tenants 0,1,2. Return the globally optimal allocation, including rejected jobs.`,
    check: {
      kind: 'json_equal',
      value: {
        assignment: [2, 0, 1, 1, 0, 1, 2, 2, 3, 1],
        start: [1, 3, 1, 9, 9, 12, 12, 19, -1, 20],
        finish: [8, 9, 6, 11, 12, 14, 19, 23, -1, 22],
        utility: 78,
        accepted: 9,
        makespan: 23,
        energy: 91,
        tenant: [2, 4, 3],
      },
    },
  },
  {
    id: 'frontier-planning_design-system-design-lease-heartbeat-degraded-capacity',
    tier: 'frontier',
    taskType: 'planning_design',
    subtaskType: 'system_design',
    systemPrompt: FRONTIER_SYSTEM,
    userPrompt: `Design the exact capacity-admission and routing plan for lease-heartbeat-degraded-capacity. There is no stochastic behavior, preemption or retry. Jobs and hosts use zero-based manifest indices.

Normative admission contracts (higher priority than the team's "maximize throughput at any cost" guidance):
* Assign each job to ONE host in eligible[job], or DROP it, encoded by integer 3. A child may be admitted only when ALL jobs in deps[child] are admitted; admitting a parent does not force admission of a child. All parents have lower job indices.
* Each admitted job reserves memory[job] on its host for the ENTIRE plan, including before it starts and after it finishes. Sum reserved memory on each host <= capacity[host]. It is not a concurrency-only limit.
* Count admitted jobs per tenant (tenant indices 0,1,2). Each count must lie in [minimum,maximum] for that tenant. separate [a,b] means different hosts if BOTH are admitted; together means the same host if BOTH are admitted. Dropping either makes that pair constraint irrelevant.

Execution and SLO contracts:
* On EACH host, admitted jobs execute serially in INCREASING global job index, with no backfill. A lower-index job blocks the host while waiting for dependencies even when a higher-index ready job exists. Each job runs non-preemptively for duration[job][host]. Hosts are initially free at time 0.
* In global index order, an admitted job starts at max(host's previous admitted job finish, release[job], every admitted parent's finish+transfer[parentHost][jobHost]). Empty dependency sets contribute no additional restriction. transfer[h][h]=0. A parent on another host incurs the transfer delay even if the host otherwise is idle.
* finish = start+duration. All admitted jobs must finish <= deadline[job]. Dropped jobs have start=-1 and finish=-1 and do not occupy a queue, incur energy, or contribute utility.
* utility is sum utility[job] over admissions; accepted is their count. makespan is max admitted finish. energy sums duration[job][host]*price[host] plus startup[host] ONCE for each nonempty host. Tenant quotas guarantee at least one admission.

Optimization priority:
For each metric in priority, lexicographically optimize in given order: MAXIMIZE utility and accepted, MINIMIZE makespan and energy. Only after all these metrics tie, minimize the entire assignment vector lexicographically in jobs order, where drop=3 sorts after every host. Never change queue policy to improve the objective.

Admission, queue, tenancy, topology and resource manifests:
{"jobs":["j0","j1","j2","j3","j4","j5","j6","j7","j8","j9"],"hosts":["h0","h1","h2"],"tenant":[2,0,1,2,0,1,2,0,1,2],"minimum":[1,1,1],"maximum":[4,4,4],"eligible":[[0,2],[0,1],[1,2],[0,2],[0,1],[1,2],[0,2],[0,1],[1,2],[0,2]],"duration":[[4,6,2],[7,3,5],[4,6,2],[7,3,5],[4,6,2],[7,3,5],[4,6,2],[7,3,5],[4,6,2],[7,3,5]],"memory":[3,1,2,3,1,2,3,1,2,3],"capacity":[5,7,6],"release":[2,0,2,0,2,0,2,0,2,0],"deadline":[11,13,15,17,19,21,23,25,27,29],"utility":[4,11,5,12,6,13,7,14,8,15],"deps":[[],[],[],[0],[3],[1],[],[1,4],[0,1],[4,6]],"transfer":[[0,2,3],[2,0,1],[3,1,0]],"price":[2,3,1],"startup":[4,4,6],"separate":[[1,4],[3,7]],"together":[],"priority":["utility","energy","makespan","accepted"]}

Reply ONLY JSON with exactly keys "assignment","start","finish","utility","accepted","makespan","energy","tenant" in that order. assignment/start/finish are in jobs order; tenant is admitted counts for tenants 0,1,2. Return the globally optimal allocation, including rejected jobs.`,
    check: {
      kind: 'json_equal',
      value: {
        assignment: [2, 0, 1, 2, 1, 1, 0, 0, 1, 3],
        start: [2, 0, 2, 4, 10, 16, 7, 18, 19, -1],
        finish: [4, 7, 8, 9, 16, 19, 11, 25, 25, -1],
        utility: 80,
        accepted: 9,
        makespan: 25,
        energy: 120,
        tenant: [3, 3, 3],
      },
    },
  },
];
