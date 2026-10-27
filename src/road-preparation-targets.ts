import type { FeatureCollection } from './contracts';
import { roadDistance, type RoadCoordinate } from './road-graph';

export interface RoadPreparationPlan {
  centers: RoadCoordinate[];
  limited: boolean;
  /** Long legs receive endpoint views only, rather than a country-wide tile corridor. */
  skippedLongLegs: number;
}
export interface RoadPreparationPlanOptions { maxAreas?: number }

export const ROAD_PREPARATION_ZOOM = 14;
export const ROAD_PREPARATION_WIDTH = 1024;
export const ROAD_PREPARATION_HEIGHT = 768;
export const MAX_PREPARATION_AREAS = 64;
const MAX_CONNECTIONS = 200;
const MAX_INPUT_FEATURES = 1000;
const MAX_CORRIDOR_METERS = 30000;
const MAX_CORRIDOR_SAMPLES = 512;
const EARTH = 6371008.8;
const WORLD = 2 * Math.PI * EARTH;
const RAD = Math.PI / 180;
// At zoom 14 a 1024×768, 512-pixel-tile viewport spans about 4.9×3.7 projected km.
// A 1 km sampling interval and 500 m deduplication radius retain an overlap margin.
const STEP = 1000;
const SAME_AREA = 500;
const normalize = (longitude: number): number => longitude >= -180 && longitude < 180 ? longitude : ((longitude + 180) % 360 + 360) % 360 - 180;
const valid = (point: unknown): point is RoadCoordinate => Array.isArray(point) && point.length >= 2 &&
  typeof point[0] === 'number' && typeof point[1] === 'number' && Number.isFinite(point[0]) &&
  Number.isFinite(point[1]) && Math.abs(point[1]) <= 85.051129;
const project = ([longitude, latitude]: RoadCoordinate): RoadCoordinate => [
  longitude * RAD * EARTH,
  EARTH * Math.log(Math.tan(Math.PI / 4 + latitude * RAD / 2)),
];
const unproject = ([x, y]: RoadCoordinate): RoadCoordinate => [
  normalize(x / EARTH / RAD),
  (2 * Math.atan(Math.exp(y / EARTH)) - Math.PI / 2) / RAD,
];
const projectedDistance = (a: RoadCoordinate, b: RoadCoordinate): number => {
  const dx = Math.abs(a[0] - b[0]) % WORLD;
  return Math.hypot(Math.min(dx, WORLD - dx), a[1] - b[1]);
};

interface Leg { from: RoadCoordinate; to: RoadCoordinate; distance: number; nearby: number; long: boolean }

/** Plan bounded detailed-map views. No map, camera, storage or network is touched here. */
export function planRoadPreparation(
  data: FeatureCollection,
  mapCenter?: RoadCoordinate | null,
  options: RoadPreparationPlanOptions = {},
): RoadPreparationPlan {
  const maxAreas = typeof options.maxAreas === 'number' && Number.isFinite(options.maxAreas) ?
    Math.max(1, Math.min(MAX_PREPARATION_AREAS, Math.floor(options.maxAreas))) : MAX_PREPARATION_AREAS;
  const origin: RoadCoordinate | null = valid(mapCenter) ? [normalize(mapCenter[0]), mapCenter[1]] : null;
  const legs: Leg[] = [];
  let limited = data.features.length > MAX_INPUT_FEATURES;
  let unresolved = 0;
  let skippedLongLegs = 0;
  for (const feature of data.features.slice(0, MAX_INPUT_FEATURES)) {
    if (['road', 'connector'].includes(String(feature.properties.connectionKind))) continue;
    if (++unresolved > MAX_CONNECTIONS) { limited = true; break; }
    const coordinates = feature.geometry.coordinates;
    if (coordinates.length < 2 || !valid(coordinates[0]) || !valid(coordinates[coordinates.length - 1])) continue;
    const from: RoadCoordinate = [normalize(coordinates[0][0]), coordinates[0][1]];
    const end = coordinates[coordinates.length - 1];
    const to: RoadCoordinate = [normalize(end[0]), end[1]];
    const distance = roadDistance(from, to);
    const long = distance > MAX_CORRIDOR_METERS;
    if (long) skippedLongLegs++;
    const middle: RoadCoordinate = [normalize(from[0] + normalize(to[0] - from[0]) / 2), (from[1] + to[1]) / 2];
    const nearby = origin ? Math.min(roadDistance(origin, from), roadDistance(origin, to), ...(long ? [] : [roadDistance(origin, middle)])) : 0;
    legs.push({ from, to, distance, nearby, long });
  }
  if (!legs.length) return { centers: [], limited, skippedLongLegs };
  // Nearby urban chains are useful first. Intercity/transport legs only get endpoint detail.
  legs.sort((a, b) => Number(a.long) - Number(b.long) || a.nearby - b.nearby || a.distance - b.distance ||
    a.from[0] - b.from[0] || a.from[1] - b.from[1] || a.to[0] - b.to[0] || a.to[1] - b.to[1]);

  const centers: RoadCoordinate[] = [];
  const projected: RoadCoordinate[] = [];
  const add = (point: RoadCoordinate): void => {
    const mercator = project(point);
    if (projected.some(previous => projectedDistance(previous, mercator) <= SAME_AREA)) return;
    if (centers.length >= maxAreas) { limited = true; return; }
    centers.push([...point]); projected.push(mercator);
  };
  if (origin) add(origin);
  for (const leg of legs) {
    const candidates: RoadCoordinate[] = [];
    if (leg.long) candidates.push(leg.from, leg.to);
    else {
      const from = project(leg.from), to = project(leg.to);
      // Unwrap the short date-line crossing before interpolation.
      to[0] = from[0] + normalize(leg.to[0] - leg.from[0]) * RAD * EARTH;
      const requiredSteps = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / STEP));
      const steps = Math.min(MAX_CORRIDOR_SAMPLES - 1, requiredSteps);
      if (steps < requiredSteps) limited = true;
      for (let index = 0; index <= steps; index++) candidates.push(unproject([
        from[0] + (to[0] - from[0]) * index / steps,
        from[1] + (to[1] - from[1]) * index / steps,
      ]));
    }
    const reference = origin ?? leg.from;
    candidates.sort((a, b) => roadDistance(reference, a) - roadDistance(reference, b) || a[0] - b[0] || a[1] - b[1]);
    for (const candidate of candidates) add(candidate);
  }
  return { centers, limited, skippedLongLegs };
}
