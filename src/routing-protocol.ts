import type { RoadAnchor, RoadFeature, RoadGate, RoadGraph } from './road-graph';

export type RoadRoute = NonNullable<ReturnType<RoadGraph['route']>>;
export interface RoutingJob {
  id: number;
  graphKey: string;
  features: RoadFeature[];
  legs: Array<{ from: [number, number]; to: [number, number]; fromAnchor?: RoadAnchor; toAnchor?: RoadAnchor; maxSnapMeters?: number }>;
  gate?: RoadGate;
}
export interface RoutingResult {
  id: number;
  routes: Array<RoadRoute | null>;
  stats: { nodes: number; edges: number; truncated: boolean };
  portals?: RoadAnchor[];
  error?: string;
}
