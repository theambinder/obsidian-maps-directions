import type { RoadFeature, RoadGraph } from './road-graph';

export type RoadRoute = NonNullable<ReturnType<RoadGraph['route']>>;
export interface RoutingJob {
  id: number;
  graphKey: string;
  features: RoadFeature[];
  legs: Array<{ from: [number, number]; to: [number, number] }>;
}
export interface RoutingResult {
  id: number;
  routes: Array<RoadRoute | null>;
  stats: { nodes: number; edges: number; truncated: boolean };
  error?: string;
}
