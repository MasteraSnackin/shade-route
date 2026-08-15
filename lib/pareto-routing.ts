/**
 * Deterministic multi-objective routing primitives for a future controlled
 * ShadeRoute pedestrian graph.
 *
 * The live pilot currently compares routes returned by the configured walking
 * router. This module does not make that shortlist network-wide optimal. It is
 * deliberately independent of providers so a release-time graph can attach
 * time-bucketed, calibrated exposure costs and return a bounded Pareto set.
 */

export interface ParetoGraphEdge {
  id: string;
  from: string;
  to: string;
  /** Strictly positive modelled traversal time for this time bucket. */
  durationSeconds: number;
  /** Modelled direct-sun time on the edge. */
  directSunSeconds: number;
  /** Unresolved daylight exposure; conservatively counted in the worst case. */
  unknownSeconds: number;
}

export interface ParetoGraph {
  edges: readonly ParetoGraphEdge[];
}

export interface ParetoPath {
  edgeIds: string[];
  nodeIds: string[];
  durationSeconds: number;
  estimatedDirectSunSeconds: number;
  unknownSeconds: number;
  /** Direct sun plus unknown daylight: the conservative exposure objective. */
  potentialDirectSunSeconds: number;
}

export interface ParetoRoutingOptions {
  /** Hard bound against malformed or unexpectedly large graphs. */
  maximumExpandedLabels?: number;
  /** Hard bound against cycles and pathological paths. */
  maximumHops?: number;
  /** Bound retained labels per graph node. */
  maximumLabelsPerNode?: number;
  /** Maximum number of non-dominated destination paths returned. */
  maximumResults?: number;
}

const DEFAULT_MAXIMUM_EXPANDED_LABELS = 50_000;
const DEFAULT_MAXIMUM_HOPS = 512;
const DEFAULT_MAXIMUM_LABELS_PER_NODE = 48;
const DEFAULT_MAXIMUM_RESULTS = 8;
const EPSILON = 1e-9;

interface Label {
  nodeId: string;
  edgeIds: string[];
  nodeIds: string[];
  visited: Set<string>;
  durationSeconds: number;
  directSunSeconds: number;
  unknownSeconds: number;
}

function potentialSun(label: Pick<Label, "directSunSeconds" | "unknownSeconds">) {
  return label.directSunSeconds + label.unknownSeconds;
}

function finiteNonNegative(value: number) {
  return Number.isFinite(value) && value >= 0;
}

function validBound(value: number | undefined, fallback: number) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("Pareto routing bounds must be positive safe integers.");
  }
  return value;
}

function dominates(a: Label, b: Label) {
  const aPotential = potentialSun(a);
  const bPotential = potentialSun(b);
  const noWorse =
    a.durationSeconds <= b.durationSeconds + EPSILON &&
    aPotential <= bPotential + EPSILON;
  const strictlyBetter =
    a.durationSeconds < b.durationSeconds - EPSILON ||
    aPotential < bPotential - EPSILON;
  return noWorse && strictlyBetter;
}

function sameObjectives(a: Label, b: Label) {
  return (
    Math.abs(a.durationSeconds - b.durationSeconds) <= EPSILON &&
    Math.abs(potentialSun(a) - potentialSun(b)) <= EPSILON
  );
}

function labelOrder(a: Label, b: Label) {
  return (
    a.durationSeconds - b.durationSeconds ||
    potentialSun(a) - potentialSun(b) ||
    a.unknownSeconds - b.unknownSeconds ||
    a.edgeIds.join("\u0000").localeCompare(b.edgeIds.join("\u0000"))
  );
}

function validateGraph(graph: ParetoGraph) {
  if (!graph || !Array.isArray(graph.edges)) {
    throw new TypeError("A Pareto graph with an edge array is required.");
  }
  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (
      !edge ||
      typeof edge.id !== "string" ||
      edge.id.length === 0 ||
      typeof edge.from !== "string" ||
      edge.from.length === 0 ||
      typeof edge.to !== "string" ||
      edge.to.length === 0
    ) {
      throw new TypeError("Every Pareto graph edge needs non-empty id, from and to values.");
    }
    if (edgeIds.has(edge.id)) throw new TypeError(`Duplicate Pareto graph edge id: ${edge.id}`);
    edgeIds.add(edge.id);
    if (!Number.isFinite(edge.durationSeconds) || edge.durationSeconds <= 0) {
      throw new RangeError(`Pareto edge ${edge.id} needs a positive duration.`);
    }
    if (
      !finiteNonNegative(edge.directSunSeconds) ||
      !finiteNonNegative(edge.unknownSeconds) ||
      edge.directSunSeconds + edge.unknownSeconds > edge.durationSeconds + EPSILON
    ) {
      throw new RangeError(`Pareto edge ${edge.id} has incoherent exposure costs.`);
    }
  }
}

function insertNonDominated(labels: Label[], candidate: Label, maximum: number) {
  if (labels.some((label) => dominates(label, candidate) || sameObjectives(label, candidate))) {
    return false;
  }
  const retained = labels.filter((label) => !dominates(candidate, label));
  retained.push(candidate);
  retained.sort(labelOrder);
  labels.splice(0, labels.length, ...retained.slice(0, maximum));
  return labels.includes(candidate);
}

/**
 * Find non-dominated paths for two objectives: traversal time and conservative
 * potential direct sun. Unknown daylight is never allowed to make a path look
 * cooler; it is added to the exposure objective and remains separately visible.
 */
export function findParetoPaths(
  graph: ParetoGraph,
  originNodeId: string,
  destinationNodeId: string,
  options: ParetoRoutingOptions = {},
): ParetoPath[] {
  validateGraph(graph);
  if (!originNodeId || !destinationNodeId) {
    throw new TypeError("Origin and destination node ids are required.");
  }
  if (originNodeId === destinationNodeId) {
    return [{
      edgeIds: [],
      nodeIds: [originNodeId],
      durationSeconds: 0,
      estimatedDirectSunSeconds: 0,
      unknownSeconds: 0,
      potentialDirectSunSeconds: 0,
    }];
  }

  const maximumExpandedLabels = validBound(
    options.maximumExpandedLabels,
    DEFAULT_MAXIMUM_EXPANDED_LABELS,
  );
  const maximumHops = validBound(options.maximumHops, DEFAULT_MAXIMUM_HOPS);
  const maximumLabelsPerNode = validBound(
    options.maximumLabelsPerNode,
    DEFAULT_MAXIMUM_LABELS_PER_NODE,
  );
  const maximumResults = validBound(options.maximumResults, DEFAULT_MAXIMUM_RESULTS);

  const outgoing = new Map<string, ParetoGraphEdge[]>();
  for (const edge of graph.edges) {
    const entries = outgoing.get(edge.from) ?? [];
    entries.push(edge);
    outgoing.set(edge.from, entries);
  }
  for (const entries of outgoing.values()) entries.sort((a, b) => a.id.localeCompare(b.id));

  const start: Label = {
    nodeId: originNodeId,
    edgeIds: [],
    nodeIds: [originNodeId],
    visited: new Set([originNodeId]),
    durationSeconds: 0,
    directSunSeconds: 0,
    unknownSeconds: 0,
  };
  const queue: Label[] = [start];
  const retainedByNode = new Map<string, Label[]>([[originNodeId, [start]]]);
  const destinations: Label[] = [];
  let expanded = 0;

  while (queue.length > 0) {
    queue.sort(labelOrder);
    const current = queue.shift()!;
    const retained = retainedByNode.get(current.nodeId) ?? [];
    if (!retained.includes(current)) continue;
    if (current.nodeId === destinationNodeId) {
      insertNonDominated(destinations, current, maximumResults);
      continue;
    }
    if (current.edgeIds.length >= maximumHops) continue;
    expanded += 1;
    if (expanded > maximumExpandedLabels) {
      throw new RangeError("Pareto routing exceeded its label-expansion bound.");
    }

    for (const edge of outgoing.get(current.nodeId) ?? []) {
      if (current.visited.has(edge.to)) continue;
      const next: Label = {
        nodeId: edge.to,
        edgeIds: [...current.edgeIds, edge.id],
        nodeIds: [...current.nodeIds, edge.to],
        visited: new Set([...current.visited, edge.to]),
        durationSeconds: current.durationSeconds + edge.durationSeconds,
        directSunSeconds: current.directSunSeconds + edge.directSunSeconds,
        unknownSeconds: current.unknownSeconds + edge.unknownSeconds,
      };
      const nextLabels = retainedByNode.get(edge.to) ?? [];
      if (insertNonDominated(nextLabels, next, maximumLabelsPerNode)) {
        retainedByNode.set(edge.to, nextLabels);
        queue.push(next);
      }
    }
  }

  return destinations.sort(labelOrder).map((label) => ({
    edgeIds: label.edgeIds,
    nodeIds: label.nodeIds,
    durationSeconds: label.durationSeconds,
    estimatedDirectSunSeconds: label.directSunSeconds,
    unknownSeconds: label.unknownSeconds,
    potentialDirectSunSeconds: potentialSun(label),
  }));
}
