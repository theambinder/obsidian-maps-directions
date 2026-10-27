import type { RoadSnapshot } from './local-roads';
import type { RoadFeature } from './road-graph';

export interface RoadMemoryLimits { features: number; positions: number }
const DEFAULT_LIMITS: RoadMemoryLimits = { features: 12000, positions: 100000 };
const PROPERTY_KEYS = ['class', 'subclass', 'brunnel', 'layer', 'level', 'access', 'foot', 'indoor'];

/** Keeps bounded detailed geometry already seen by this map; it never loads tiles. */
export class DetailedRoadMemory {
  private readonly features = new Map<string, { feature: RoadFeature; positions: number }>();
  private sources = '';
  private positions = 0;
  private snapshot: RoadSnapshot | null = null;
  private readonly limits: RoadMemoryLimits;

  constructor(limits: Partial<RoadMemoryLimits> = {}) {
    this.limits = {
      features: Number.isFinite(limits.features) ? Math.max(1, Math.min(DEFAULT_LIMITS.features, Math.floor(limits.features!))) : DEFAULT_LIMITS.features,
      positions: Number.isFinite(limits.positions) ? Math.max(2, Math.min(DEFAULT_LIMITS.positions, Math.floor(limits.positions!))) : DEFAULT_LIMITS.positions,
    };
  }

  merge(incoming: RoadSnapshot): RoadSnapshot {
    const sourceIds = [...new Set(incoming.sources)].sort();
    const sources = JSON.stringify(sourceIds);
    if (incoming.state === 'unsupported' || !sourceIds.length) { this.clear(); return incoming; }
    if (sources !== this.sources) { this.clear(); this.sources = sources; }
    if (incoming.state !== 'ready') return this.snapshot ?? incoming;
    let changed = false;
    for (const original of incoming.features.slice(0, this.limits.features)) {
      const road = cloneRoad(original, this.limits.positions);
      if (!road) continue;
      const signature = JSON.stringify(road.feature);
      const existing = this.features.get(signature);
      if (existing) {
        // Currently loaded roads stay newer than roads left behind after a pan.
        // Refresh recency without changing geometry or invalidating the snapshot.
        this.features.delete(signature);
        this.features.set(signature, existing);
        continue;
      }
      this.features.set(signature, road);
      this.positions += road.positions;
      changed = true;
      while (this.features.size > this.limits.features || this.positions > this.limits.positions) {
        const oldest = this.features.entries().next().value as [string, { positions: number }] | undefined;
        if (!oldest) break;
        this.positions -= oldest[1].positions;
        this.features.delete(oldest[0]);
      }
    }
    if (!changed || !this.features.size) return this.snapshot ?? { key: `memory:${sources}:empty`, state: 'empty', sources: sourceIds, features: [] };
    // Stable order and key keep duplicate idle/source events from rebuilding a graph.
    const signatures = [...this.features.keys()].sort();
    let hash = 2166136261;
    for (const text of signatures) for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
    this.snapshot = Object.freeze({
      state: 'ready', sources: Object.freeze(sourceIds) as unknown as string[],
      key: `memory:${sources}:${signatures.length}:${this.positions}:${hash >>> 0}`,
      features: Object.freeze(signatures.map(signature => this.features.get(signature)!.feature)) as unknown as RoadFeature[],
    });
    return this.snapshot;
  }

  clear(): void {
    this.features.clear();
    this.positions = 0;
    this.sources = '';
    this.snapshot = null;
  }
}

function cloneRoad(original: RoadFeature, maxPositions: number): { feature: RoadFeature; positions: number } | null {
  const geometry = original?.geometry;
  if (!geometry || !Array.isArray(geometry.coordinates)) return null;
  const lines: unknown[] = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.type === 'MultiLineString' ? geometry.coordinates : [];
  if (!lines.length || lines.length > maxPositions / 2) return null;
  let positions = 0;
  const copied: number[][][] = [];
  for (const line of lines) {
    if (!Array.isArray(line) || line.length < 2 || line.length > maxPositions - positions) return null;
    const coordinates: number[][] = [];
    for (const point of line) {
      if (!Array.isArray(point) || point.length < 2 || typeof point[0] !== 'number' || typeof point[1] !== 'number' ||
        !Number.isFinite(point[0]) || !Number.isFinite(point[1]) || Math.abs(point[1]) > 85.051129) return null;
      coordinates.push(Object.freeze([point[0], point[1]]) as unknown as number[]);
    }
    positions += line.length;
    copied.push(Object.freeze(coordinates) as unknown as number[][]);
  }
  const properties: Record<string, unknown> = {};
  for (const key of PROPERTY_KEYS) {
    const value = original.properties?.[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) properties[key] = value;
  }
  return { positions, feature: Object.freeze({
    geometry: Object.freeze({ type: geometry.type, coordinates: geometry.type === 'LineString' ? copied[0] : Object.freeze(copied) }),
    properties: Object.freeze(properties),
  }) };
}
