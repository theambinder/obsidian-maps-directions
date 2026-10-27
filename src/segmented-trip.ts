import { roadDistance, type RoadAnchor, type RoadCoordinate, type RoadRoute } from './road-graph';
import { prepareBackgroundRoads } from './background-roads';
import type { RoadClipBounds } from './road-clipping';
import type { RoutingJob } from './routing-protocol';
import type { TripSplitPath, TripSplitProgress } from './trip-queue';
import type { TripProcessorOptions } from './trip-processor';

const EARTH = 6371008.8, RAD = Math.PI / 180, WORLD = 2 * Math.PI * EARTH;
const PASSES = [{ step: 450, width: 250 }, { step: 300, width: 650 }, { step: 200, width: 1000 }];
const normalize = (value: number): number => ((value + 180) % 360 + 360) % 360 - 180;
const interpolate = (from: RoadCoordinate, to: RoadCoordinate, fraction: number): RoadCoordinate =>
  [normalize(from[0] + normalize(to[0] - from[0]) * fraction), from[1] + (to[1] - from[1]) * fraction];

export interface SplitWindow { from: RoadCoordinate; to: RoadCoordinate; center: RoadCoordinate; zoom: number; bounds: RoadClipBounds; total: number; width: number }
/** Overlapping local windows, independent of the size of the whole connection. */
export function splitTripWindow(from: RoadCoordinate, to: RoadCoordinate, pass: number, index: number): SplitWindow {
  const shape = PASSES[pass] ?? PASSES[0], total = Math.max(1, Math.ceil(roadDistance(from, to) / shape.step));
  const start = interpolate(from, to, index / total), end = interpolate(from, to, Math.min(total, index + 1) / total);
  const center = interpolate(start, end, 0.5);
  const latitudeMargin = shape.width / EARTH / RAD;
  const longitudeMargin = latitudeMargin / Math.max(0.08, Math.cos(center[1] * RAD));
  const startX = center[0] + normalize(start[0] - center[0]), endX = center[0] + normalize(end[0] - center[0]);
  const bounds = { west: Math.min(startX, endX) - longitudeMargin, east: Math.max(startX, endX) + longitudeMargin,
    south: Math.max(-85.051129, Math.min(start[1], end[1]) - latitudeMargin), north: Math.min(85.051129, Math.max(start[1], end[1]) + latitudeMargin) };
  const maximumLatitude = Math.min(85.051129, Math.max(Math.abs(from[1]), Math.abs(to[1])) + latitudeMargin);
  const cosine = Math.max(0.08, Math.cos(maximumLatitude * RAD));
  const spanX = (Math.abs(normalize(to[0] - from[0])) / total + 2 * latitudeMargin / cosine) * RAD * EARTH;
  const spanY = (Math.abs(to[1] - from[1]) / total + 2 * latitudeMargin) * RAD * EARTH / cosine;
  // One zoom for the whole pass keeps anchors on the same source detail level.
  // The fixed Eco viewport covers the clipped window, with margin for tile loading.
  const zoom = Math.max(0, Math.min(16, Math.floor(Math.log2(Math.min(768 / (spanX * 1.15), 512 / (spanY * 1.15)) * WORLD / 512))));
  return { from: start, to: end, center, zoom, bounds, total, width: shape.width };
}

/** Only join verified local paths at the same level and the same road anchor. */
export function appendSplitPath(prefix: TripSplitPath | null, route: RoadRoute, end?: RoadAnchor): RoadRoute | null {
  if (!Number.isFinite(route.distance) || route.distance < 0 || route.coordinates.length < 2 ||
    !route.coordinates.every(point => point.length === 2 && point.every(Number.isFinite) && Math.abs(point[1]) <= 85.051129)) return null;
  if (end && roadDistance(route.coordinates[route.coordinates.length - 1], end.point) > 0.05) return null;
  if (!prefix) return { distance: route.distance, coordinates: route.coordinates.map(point => [...point]) };
  const previous = prefix.route.coordinates[prefix.route.coordinates.length - 1];
  if (roadDistance(previous, prefix.anchor.point) > 0.05 || roadDistance(previous, route.coordinates[0]) > 0.05) return null;
  const coordinates = prefix.route.coordinates.map(point => [...point] as RoadCoordinate);
  for (const point of route.coordinates.slice(1)) {
    const last = coordinates[coordinates.length - 1];
    coordinates.push([last[0] + normalize(point[0] - last[0]), point[1]]);
  }
  return { distance: prefix.route.distance + route.distance, coordinates };
}

/** A bounded beam of real road portals; each window graph is released before the next. */
export async function processSplitTrip(options: TripProcessorOptions, key: string, distanceAllowed: () => boolean): Promise<void> {
  const { ledger, signal, client } = options;
  const initial = ledger.get(key);
  if (!initial || initial.state !== 'preparing') return;
  const active = (): boolean => !signal.aborted && ledger.get(key)?.state === 'preparing' && distanceAllowed();
  let saved = initial.split;
  for (let pass = saved?.pass ?? 0; pass < PASSES.length && active(); pass++) {
    const first = splitTripWindow(initial.from, initial.to, pass, 0);
    let nextPart = saved?.pass === pass && saved.totalParts === first.total ? saved.nextPart : 0;
    let frontier = nextPart > 0 ? saved!.frontier : [];
    const checkpoint = (): TripSplitProgress => ({ version: 1, pass, nextPart, totalParts: first.total, frontier });
    ledger.setSplit(key, checkpoint());
    let failed = false;
    while (nextPart < first.total && active()) {
      if (options.visible && !options.visible()) throw new Error('The map is no longer visible.');
      const window = splitTripWindow(initial.from, initial.to, pass, nextPart), last = nextPart === first.total - 1;
      const profile = options.profile();
      client.configure?.(profile.workerTimeoutMs);
      options.onProgress?.({ key, completed: nextPart, total: first.total, unit: 'sections',
        message: `Preparing smaller sections: ${nextPart}/${first.total} saved (attempt ${pass + 1}/${PASSES.length}).` });
      let accepted: TripSplitPath[] = [], completed: RoadRoute | null = null;
      for (let attempt = 0; attempt < 2 && active() && !accepted.length && !completed; attempt++) {
        try {
          await options.serial.run(signal, () => (options.run ?? prepareBackgroundRoads)(options.original, [{ center: window.center, zoom: window.zoom }], {
            factory: options.factory, signal, viewportWidth: profile.viewportWidth, viewportHeight: profile.viewportHeight, tileCacheSize: profile.tileCacheSize,
            roadLimits: { maxFeatures: profile.maxRoadFeatures, maxPositions: profile.maxRoadPositions, clipBounds: window.bounds },
            timeoutMs: 8000, totalTimeoutMs: 120000,
            onSnapshot: async (snapshot, chunkSignal) => {
              if (!active() || chunkSignal.aborted || snapshot.state !== 'ready') return false;
              const cancel = (): void => client.cancel();
              chunkSignal.addEventListener('abort', cancel, { once: true });
              try {
                const portalResult = await client.route(snapshot, [], last ? undefined : { from: initial.from, to: initial.to, center: window.to, halfWidthMeters: window.width, maxPortals: 8 });
                if (!active() || chunkSignal.aborted) return false;
                const portals = last ? [] : portalResult.portals ?? [];
                const origins: Array<TripSplitPath | null> = nextPart === 0 ? [null] : frontier;
                const legs: RoutingJob['legs'] = [];
                const pairs: Array<{ prefix: TripSplitPath | null; end?: RoadAnchor }> = [];
                for (const prefix of origins) {
                  const start = prefix?.anchor.point ?? initial.from;
                  if (last) { legs.push({ from: start, to: initial.to, maxSnapMeters: profile.maxAccessMeters, ...(prefix ? { fromAnchor: prefix.anchor } : {}) }); pairs.push({ prefix }); }
                  else for (const end of portals) {
                    legs.push({ from: start, to: end.point, maxSnapMeters: profile.maxAccessMeters, ...(prefix ? { fromAnchor: prefix.anchor } : {}), toAnchor: end });
                    pairs.push({ prefix, end });
                  }
                }
                if (!legs.length) return false;
                const result = await client.route(snapshot, legs);
                if (!active() || chunkSignal.aborted) return false;
                const best = new Map<string, TripSplitPath>();
                result.routes.forEach((route, index) => {
                  const pair = pairs[index];
                  if (!route || !pair) return;
                  const joined = appendSplitPath(pair.prefix, route, pair.end);
                  if (!joined) return;
                  if (!pair.end) { if (!completed || joined.distance < completed.distance) completed = joined; return; }
                  const id = JSON.stringify(pair.end);
                  if (!best.has(id) || joined.distance < best.get(id)!.route.distance) best.set(id, { anchor: pair.end, route: joined });
                });
                accepted = [...best.values()];
                return false;
              } finally { chunkSignal.removeEventListener('abort', cancel); }
            },
          }));
        } catch (error) { if (signal.aborted || !active()) throw error; }
        finally { client.cancel(); }
        if (!accepted.length && !completed && attempt === 0 && profile.pauseMs > 0 && active()) await pause(profile.pauseMs, signal);
      }
      if (!active()) return;
      if (completed) {
        if (ledger.finish(key, 'ready', 'Walking path assembled from verified local road sections.', completed)) options.onRoute?.(key, completed);
        return;
      }
      if (!accepted.length) { failed = true; break; }
      frontier = accepted; nextPart++;
      ledger.setSplit(key, checkpoint());
      options.onProgress?.({ key, completed: nextPart, total: first.total, unit: 'sections', message: `Smaller sections saved: ${nextPart}/${first.total}.` });
      if (profile.pauseMs > 0 && active()) await pause(profile.pauseMs, signal);
    }
    if (!active()) return;
    if (!failed) break;
    saved = undefined;
    if (pass + 1 < PASSES.length) {
      ledger.setSplit(key, { version: 1, pass: pass + 1, nextPart: 0, totalParts: 0, frontier: [] });
      options.onProgress?.({ key, completed: 0, total: 0, unit: 'sections', message: 'Trying a wider corridor with smaller sections. Saved routes for other connections are kept.' });
      if (options.profile().pauseMs > 0) await pause(options.profile().pauseMs, signal);
    }
  }
  if (active()) ledger.finish(key, 'unavailable', 'Automatic section searches could not assemble a connected walking path from the available road data. Barriers, missing detail or local data limits may prevent routing; this is not proof that no path exists.');
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('Preparation stopped.'));
  return new Promise((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('Preparation stopped.')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
