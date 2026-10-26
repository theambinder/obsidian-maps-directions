import type { MapLike } from './contracts';
import type { RoadFeature } from './road-graph';

export const MIN_ROAD_ZOOM = 14;
const MAX_FEATURES = 12000;
const MAX_POSITIONS = 100000;

export interface RoadSnapshot {
  key: string;
  features: RoadFeature[];
  sources: string[];
  state: 'ready' | 'zoom' | 'unsupported' | 'empty' | 'limited';
}

/** Only read the existing map. Never request tiles, move its camera, or alter its style. */
export function collectLocalRoads(map: Pick<MapLike, 'getStyle' | 'getZoom' | 'querySourceFeatures'>): RoadSnapshot {
  const empty = (state: RoadSnapshot['state'], sources: string[] = []): RoadSnapshot =>
    ({ key: state, features: [], sources, state });
  if (!map.getStyle || !map.querySourceFeatures || !map.getZoom) return empty('unsupported');
  const style = map.getStyle();
  const sources = [...new Set((style.layers ?? [])
    .filter(layer => layer['source-layer'] === 'transportation' && layer.source && style.sources?.[layer.source]?.type === 'vector')
    .map(layer => layer.source!))].sort();
  if (!sources.length) return empty('unsupported');
  if (map.getZoom() < MIN_ROAD_ZOOM) return empty('zoom', sources);

  const features: RoadFeature[] = [];
  const signatures = new Set<string>();
  let positions = 0;
  for (const source of sources) {
    let roads: RoadFeature[];
    try { roads = map.querySourceFeatures(source, { sourceLayer: 'transportation' }); }
    catch { continue; } // A custom vector source can omit this tile layer.
    for (const road of roads) {
      const geometry = road.geometry;
      if (!geometry || (geometry.type !== 'LineString' && geometry.type !== 'MultiLineString') || !Array.isArray(geometry.coordinates)) continue;
      const properties = road.properties ?? {};
      const feature: RoadFeature = {
        geometry: { type: geometry.type, coordinates: geometry.coordinates },
        properties: Object.fromEntries(['class', 'subclass', 'brunnel', 'layer', 'level', 'access', 'foot', 'indoor']
          .filter(key => properties[key] !== undefined).map(key => [key, properties[key]])),
      };
      const signature = JSON.stringify(feature);
      if (signatures.has(signature)) continue;
      const count = geometry.type === 'LineString' ? geometry.coordinates.length : geometry.coordinates.reduce((sum: number, line: unknown) => sum + (Array.isArray(line) ? line.length : 0), 0);
      positions += count;
      if (features.length >= MAX_FEATURES || positions > MAX_POSITIONS) return empty('limited', sources);
      signatures.add(signature);
      features.push(feature);
    }
  }
  if (!features.length) return empty('empty', sources);
  // Tile query order is not stable. Sorting prevents identical idle events from rebuilding a graph.
  const sorted = [...signatures].sort();
  let hash = 2166136261;
  for (const text of sorted) for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return { key: `${sources.join(',')}:${features.length}:${positions}:${hash >>> 0}`, features, sources, state: 'ready' };
}
