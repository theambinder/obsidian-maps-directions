import { prepareBackgroundRoads } from './background-roads';
import type { RoadClipBounds } from './road-clipping';
import { roadDistance, type RoadCoordinate, type RoadRoute } from './road-graph';
import type { TripProcessorOptions } from './trip-processor';

const EARTH = 6371008.8, RAD = Math.PI / 180, WORLD = 2 * Math.PI * EARTH;
const SHAPES = [{ zoom: 15, step: 350, width: 250 }, { zoom: 15, step: 250, width: 350 }, { zoom: 14, step: 200, width: 500 }];
const MAX_LATITUDE = 85.051129;
const normalize = (value: number): number => ((value + 180) % 360 + 360) % 360 - 180;
const interpolate = (from: RoadCoordinate, to: RoadCoordinate, fraction: number): RoadCoordinate =>
  [normalize(from[0] + normalize(to[0] - from[0]) * fraction), from[1] + (to[1] - from[1]) * fraction];
const validPoint = (point: unknown): point is RoadCoordinate => Array.isArray(point) && point.length === 2 &&
  point.every(value => typeof value === 'number' && Number.isFinite(value)) && Math.abs(point[1]) <= MAX_LATITUDE;
const validRoute = (route: RoadRoute | null | undefined): route is RoadRoute => !!route && Number.isFinite(route.distance) && route.distance >= 0 &&
  Array.isArray(route.coordinates) && route.coordinates.length >= 2 && Array.from(route.coordinates).every(validPoint);
const samePoint = (a: RoadCoordinate, b: RoadCoordinate): boolean => normalize(a[0]) === normalize(b[0]) && a[1] === b[1];
const mercatorY = (latitude: number): number => EARTH * Math.log(Math.tan(Math.PI / 4 + latitude * RAD / 2));
const inside = (point: RoadCoordinate, bounds: RoadClipBounds): boolean => {
  const middle = (bounds.west + bounds.east) / 2;
  const longitude = point[0] + Math.round((middle - point[0]) / 360) * 360;
  return longitude >= bounds.west - 1e-9 && longitude <= bounds.east + 1e-9 && point[1] >= bounds.south - 1e-9 && point[1] <= bounds.north + 1e-9;
};

export interface GuidedTripWindow {
  from: RoadCoordinate; to: RoadCoordinate; center: RoadCoordinate; zoom: number;
  bounds: RoadClipBounds; total: number; width: number;
  gateFrom: RoadCoordinate; gateTo: RoadCoordinate;
}

/** Sample the actual guide by travelled distance, including its bends and backtracking. */
export function guidedTripWindow(guide: RoadRoute, pass: number, index: number): GuidedTripWindow {
  if (!validRoute(guide)) throw new Error('Invalid walking detour guide.');
  const cumulative = [0];
  for (let at = 1; at < guide.coordinates.length; at++) cumulative.push(cumulative[at - 1] + roadDistance(guide.coordinates[at - 1], guide.coordinates[at]));
  const length = cumulative[cumulative.length - 1];
  const shape = SHAPES[pass] ?? SHAPES[0];
  const maximumLatitude = Math.max(...guide.coordinates.map(point => Math.abs(point[1])));
  const cosine = Math.cos(Math.min(MAX_LATITUDE, maximumLatitude) * RAD);
  const height = WORLD / 2 ** shape.zoom * cosine;
  const step = Math.min(shape.step, height * 0.25), width = Math.min(shape.width, height * 0.25);
  const total = Math.max(1, Math.ceil(length / step));
  const part = Math.max(0, Math.min(total - 1, Math.floor(index)));
  const startDistance = length * part / total, endDistance = length * (part + 1) / total;
  const at = (distance: number): RoadCoordinate => {
    const target = Math.max(0, Math.min(length, distance));
    for (let segment = 1; segment < cumulative.length; segment++) if (target <= cumulative[segment]) {
      const span = cumulative[segment] - cumulative[segment - 1];
      return interpolate(guide.coordinates[segment - 1], guide.coordinates[segment], span ? (target - cumulative[segment - 1]) / span : 0);
    }
    return [...guide.coordinates[guide.coordinates.length - 1]];
  };
  const from = at(startDistance), to = at(endDistance);
  const points = [from, ...guide.coordinates.filter((_point, vertex) => cumulative[vertex] > startDistance && cumulative[vertex] < endDistance), to];
  const reference = from[0], longitudes = points.map(point => reference + normalize(point[0] - reference));
  const latitudeMargin = width / EARTH / RAD, longitudeMargin = latitudeMargin / cosine;
  const bounds: RoadClipBounds = {
    west: Math.min(...longitudes) - longitudeMargin, east: Math.max(...longitudes) + longitudeMargin,
    south: Math.max(-MAX_LATITUDE, Math.min(...points.map(point => point[1])) - latitudeMargin),
    north: Math.min(MAX_LATITUDE, Math.max(...points.map(point => point[1])) + latitudeMargin),
  };
  const center: RoadCoordinate = [normalize((bounds.west + bounds.east) / 2), (bounds.south + bounds.north) / 2];
  const tangentDistance = Math.min(20, step * 0.1);
  return { from, to, center, zoom: shape.zoom, bounds, total, width,
    gateFrom: at(endDistance - tangentDistance), gateTo: at(endDistance + tangentDistance) };
}

/** Coarse paths are search guides only; every final road section must be verified separately. */
export async function findTripGuide(options: TripProcessorOptions, key: string, active: () => boolean): Promise<RoadRoute | null> {
  const initial = options.ledger.get(key);
  if (!initial || initial.state !== 'preparing') return null;
  const current = (): boolean => {
    if (options.signal.aborted || !active() || options.visible && !options.visible()) return false;
    const task = options.ledger.get(key);
    return task?.state === 'preparing' && samePoint(task.from, initial.from) && samePoint(task.to, initial.to);
  };
  if (!current()) return null;
  const middle: RoadCoordinate = interpolate(initial.from, initial.to, 0.5);
  const maximumLatitude = Math.max(Math.abs(initial.from[1]), Math.abs(initial.to[1]));
  const margin = 2000 / EARTH / RAD, cosine = Math.cos(Math.min(MAX_LATITUDE, maximumLatitude + margin) * RAD);
  const startX = middle[0] + normalize(initial.from[0] - middle[0]), endX = middle[0] + normalize(initial.to[0] - middle[0]);
  const bounds: RoadClipBounds = {
    west: Math.min(startX, endX) - margin / cosine, east: Math.max(startX, endX) + margin / cosine,
    south: Math.max(-MAX_LATITUDE, Math.min(initial.from[1], initial.to[1]) - margin),
    north: Math.min(MAX_LATITUDE, Math.max(initial.from[1], initial.to[1]) + margin),
  };
  const center: RoadCoordinate = [normalize((bounds.west + bounds.east) / 2), (bounds.south + bounds.north) / 2];
  const spanX = Math.max(1, (bounds.east - bounds.west) * RAD * EARTH);
  const spanY = Math.max(1, mercatorY(bounds.north) - mercatorY(bounds.south));
  const fit = Math.floor(Math.log2(Math.min(768 / (spanX * 1.15), 512 / (spanY * 1.15)) * WORLD / 512));
  const zooms = [Math.max(0, Math.min(14, fit)), Math.max(0, Math.min(16, fit + 1))];
  let best: RoadRoute | null = null;
  const cancel = (): void => options.client.cancel();
  options.signal.addEventListener('abort', cancel, { once: true });
  try {
    for (let attempt = 0; attempt < zooms.length && current(); attempt++) {
      const profile = options.profile();
      options.client.configure?.(Math.min(profile.workerTimeoutMs, 8000));
      options.onProgress?.({ key, completed: attempt, total: zooms.length, message: 'Finding a walking detour guide…' });
      try {
        await options.serial.run(options.signal, async () => {
          if (!current() || options.visible && !options.visible()) return;
          await (options.run ?? prepareBackgroundRoads)(options.original, [{ center, zoom: zooms[attempt] }], {
            factory: options.factory, signal: options.signal, viewportWidth: 768, viewportHeight: 512, tileCacheSize: 8,
            roadLimits: { maxFeatures: Math.min(profile.maxRoadFeatures, 6000), maxPositions: Math.min(profile.maxRoadPositions, 50000), clipBounds: bounds },
            timeoutMs: 8000, totalTimeoutMs: 120000,
            onSnapshot: async (snapshot, chunkSignal) => {
              if (!current() || chunkSignal.aborted || snapshot.state !== 'ready') return false;
              chunkSignal.addEventListener('abort', cancel, { once: true });
              try {
                const result = await options.client.route(snapshot, [{ from: initial.from, to: initial.to, maxSnapMeters: 1000 }]);
                if (!current() || chunkSignal.aborted) return false;
                const route = result.routes[0];
                if (!validRoute(route) || !route.coordinates.every(point => inside(point, bounds)) ||
                  roadDistance(initial.from, route.coordinates[0]) > 1000 || roadDistance(initial.to, route.coordinates[route.coordinates.length - 1]) > 1000) return false;
                const coordinates: RoadCoordinate[] = [[...initial.from]];
                for (const point of [...route.coordinates, initial.to]) {
                  const last = coordinates[coordinates.length - 1];
                  if (roadDistance(last, point) > 0.005) coordinates.push([last[0] + normalize(point[0] - last[0]), point[1]]);
                }
                if (coordinates.length < 2) return false;
                const distance = coordinates.slice(1).reduce((sum, point, index) => sum + roadDistance(coordinates[index], point), 0);
                if (!best || distance < best.distance) best = { coordinates, distance };
                return false;
              } finally { chunkSignal.removeEventListener('abort', cancel); }
            },
          });
        });
      } catch { if (!current()) return null; }
      finally { options.client.cancel(); }
      if (!current()) return null;
      if (attempt + 1 < zooms.length && profile.pauseMs > 0) await pause(profile.pauseMs, options.signal);
    }
    return current() ? best : null;
  } catch { return null; }
  finally { options.signal.removeEventListener('abort', cancel); }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('Preparation stopped.'));
  return new Promise((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('Preparation stopped.')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
