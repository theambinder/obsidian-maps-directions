import { buildRoadGraph, type RoadGraph } from './road-graph';
import type { RoutingJob, RoutingResult } from './routing-protocol';

const scope = globalThis as unknown as {
  onmessage: ((event: { data: RoutingJob }) => void) | null;
  postMessage(message: RoutingResult): void;
};
let graph: RoadGraph | null = null;
let graphKey = '';
scope.onmessage = ({ data: job }) => {
  try {
    if (!graph || graphKey !== job.graphKey) {
      graph = buildRoadGraph(job.features);
      graphKey = job.graphKey;
    }
    scope.postMessage({
      id: job.id,
      routes: job.legs.map(leg => graph!.route(leg.from, leg.to, leg.maxSnapMeters ?? 100, { from: leg.fromAnchor, to: leg.toAnchor })),
      stats: graph.stats,
      ...(job.gate ? { portals: graph.portals(job.gate) } : {}),
    });
  } catch {
    graph = null;
    graphKey = '';
    scope.postMessage({ id: job.id, routes: [], stats: { nodes: 0, edges: 0, truncated: false }, error: 'Local road search failed.' });
  }
};
