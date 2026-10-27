import { collectLocalRoads, MIN_ROAD_ZOOM, type RoadSnapshot, type RoadCollectionOptions } from './local-roads';
import { normalizeLongitude } from './geometry';
import type { RoadFeature } from './road-graph';

export type RoadPreparationCenter = [number, number];
export interface RoadPreparationTarget { center: RoadPreparationCenter; zoom: number }
export interface RoadPreparationArea { index: number; target: RoadPreparationTarget; waitTimedOut: boolean }
export interface RoadPreparationStyle {
  version: 8;
  sources: Record<string, Record<string, unknown>>;
  layers: Array<Record<string, unknown>>;
}
export interface BackgroundRoadMap {
  getStyle(): unknown;
  getZoom(): number;
  querySourceFeatures(sourceId: string, options: { sourceLayer: string }): RoadFeature[];
  isStyleLoaded(): boolean;
  loaded?(): boolean;
  areTilesLoaded?(): boolean;
  jumpTo(options: { center: RoadPreparationCenter; zoom: number }): unknown;
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  off(event: string, handler: (...args: unknown[]) => void): unknown;
  remove(): unknown;
}
export interface BackgroundRoadMapOptions {
  container: HTMLElement;
  style: RoadPreparationStyle;
  center: RoadPreparationCenter;
  zoom: number;
  minZoom: number;
  maxZoom: number;
  bearing: 0;
  pitch: 0;
  interactive: false;
  attributionControl: false;
  maplibreLogo: false;
  trackResize: false;
  renderWorldCopies: false;
  pixelRatio: 1;
  maxTileCacheSize: number;
  fadeDuration: 0;
}
export type BackgroundRoadMapFactory = (options: BackgroundRoadMapOptions) => BackgroundRoadMap;
export type BackgroundMapFactory = BackgroundRoadMapFactory;
export interface RoadPreparationProgress { completed: number; total: number; ready: number }
export interface RoadPreparationResult extends RoadPreparationProgress { timedOut: boolean }
export interface BackgroundRoadPreparationOptions {
  factory: BackgroundRoadMapFactory;
  signal?: AbortSignal;
  onSnapshot: (snapshot: RoadSnapshot, signal: AbortSignal, area?: RoadPreparationArea) => unknown | Promise<unknown>;
  onProgress?: (progress: RoadPreparationProgress) => void;
  viewportWidth?: number;
  viewportHeight?: number;
  tileCacheSize?: number;
  roadLimits?: Pick<RoadCollectionOptions, 'maxFeatures' | 'maxPositions' | 'clipBounds'>;
  /** Per-area wait, capped at eight seconds. */
  timeoutMs?: number;
  /** Deadline for this working chunk, not for the whole trip. At most two minutes. */
  totalTimeoutMs?: number;
}
interface OriginalRoadMap {
  getStyle?(): unknown;
  getContainer?(): HTMLElement;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const bounded = (value: number | undefined, fallback: number, min: number, max: number): number =>
  number(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;

/** Copy only transport vector source configuration; never copy note/marker data. */
export function buildRoadPreparationStyle(original: unknown): RoadPreparationStyle | null {
  if (!record(original) || !record(original.sources) || !Array.isArray(original.layers)) return null;
  const ids = [...new Set(original.layers.flatMap(layer => record(layer) && layer['source-layer'] === 'transportation' &&
    typeof layer.source === 'string' ? [layer.source] : []))].sort();
  const sources: RoadPreparationStyle['sources'] = {};
  for (const id of ids) {
    const source = original.sources[id];
    if (!record(source) || source.type !== 'vector') continue;
    const copy: Record<string, unknown> = { type: 'vector' };
    for (const key of ['url', 'scheme', 'attribution', 'encoding']) if (typeof source[key] === 'string') copy[key] = source[key];
    if (Array.isArray(source.tiles) && source.tiles.length <= 16 && source.tiles.every(tile => typeof tile === 'string')) copy.tiles = [...source.tiles];
    if (typeof copy.url !== 'string' && (!Array.isArray(copy.tiles) || copy.tiles.length === 0)) continue;
    for (const key of ['minzoom', 'maxzoom', 'tileSize']) if (number(source[key])) copy[key] = source[key];
    if (Array.isArray(source.bounds) && source.bounds.length === 4 && source.bounds.every(number)) copy.bounds = [...source.bounds];
    if (typeof source.volatile === 'boolean') copy.volatile = source.volatile;
    sources[id] = copy;
  }
  const layers = Object.keys(sources).map((source, index) => ({
    id: `maps-directions-road-preparation-${index}`, type: 'line', source, 'source-layer': 'transportation',
    paint: { 'line-color': '#777777', 'line-width': 1 },
  }));
  return layers.length ? { version: 8, sources, layers } : null;
}

function cancellation(): Error {
  const error = new Error('Road preparation cancelled.');
  error.name = 'AbortError';
  return error;
}
function checkAbort(signal: AbortSignal): void { if (signal.aborted) throw cancellation(); }

/** Release the map even if a caller's asynchronous snapshot callback is still waiting. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => { cleanup(); reject(cancellation()); };
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) onAbort();
  });
}

function waitForArea(map: BackgroundRoadMap, target: RoadPreparationTarget, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let done = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      for (const [event, handler] of listeners) map.off(event, handler);
      signal.removeEventListener('abort', onAbort);
    };
    const finish = (error?: unknown, timedOut = false): void => {
      if (done) return;
      done = true; cleanup();
      if (error) reject(error); else resolve(timedOut);
    };
    const onAbort = (): void => finish(cancellation());
    const onIdle = (): void => { if (map.isStyleLoaded()) finish(); };
    // loaded() includes pending render/source updates. areTilesLoaded() alone can
    // still describe the previous area immediately after a camera jump.
    const onSource = (): void => { if (map.loaded?.() && map.areTilesLoaded?.()) finish(); };
    const onError = (): void => { /* Missing/offline tiles are handled by the bounded wait. */ };
    const listeners: Array<[string, (...args: unknown[]) => void]> = [
      ['idle', onIdle], ['load', onSource], ['sourcedata', onSource], ['error', onError],
    ];
    const timer = setTimeout(() => finish(undefined, true), timeoutMs);
    try {
      for (const [event, handler] of listeners) map.on(event, handler);
      signal.addEventListener('abort', onAbort, { once: true });
      checkAbort(signal);
      map.jumpTo(target);
    } catch (error) { finish(error); }
  });
}

/**
 * Prepare one caller-selected working chunk with the original Maps runtime.
 * The caller owns durable trip progress; no itinerary-length cutoff is applied here.
 * Only that offscreen map moves; the user's map, style and marker sources stay intact.
 */
export async function prepareBackgroundRoads(
  original: OriginalRoadMap,
  centers: readonly (RoadPreparationCenter | RoadPreparationTarget)[],
  options: BackgroundRoadPreparationOptions,
): Promise<RoadPreparationResult> {
  if (options.signal?.aborted) throw cancellation();
  const targets = centers.flatMap((input): RoadPreparationTarget[] => {
    const point = Array.isArray(input) ? input : input?.center;
    const zoom = Array.isArray(input) ? MIN_ROAD_ZOOM : input?.zoom;
    if (!Array.isArray(point) || point.length !== 2 || !number(point[0]) || !number(point[1]) ||
      Math.abs(point[1]) > 85.051129 || !number(zoom) || zoom < 0 || zoom > 16) return [];
    return [{ center: [normalizeLongitude(point[0]), point[1]], zoom }];
  });
  const result: RoadPreparationResult = { completed: 0, total: targets.length, ready: 0, timedOut: false };
  if (!targets.length) return result;
  const style = buildRoadPreparationStyle(original.getStyle?.());
  const doc = original.getContainer?.()?.ownerDocument;
  if (!style || !doc?.body) throw new Error('This map background does not expose supported vector roads.');
  const width = bounded(options.viewportWidth, 1024, 256, 2048);
  const height = bounded(options.viewportHeight, 768, 256, 2048);
  const tileCache = bounded(options.tileCacheSize, 32, 4, 128);
  const host = doc.createElement('div');
  host.className = 'obsidian-maps-directions-background-roads';
  host.setAttribute('aria-hidden', 'true');
  Object.assign(host.style, {
    position: 'fixed', width: `${width}px`, height: `${height}px`, left: '-100000px', top: '0',
    visibility: 'hidden', pointerEvents: 'none', overflow: 'hidden',
  });
  doc.body.append(host);
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timeout = Math.max(1, Math.min(8000, number(options.timeoutMs) ? options.timeoutMs : 8000));
  const deadline = Math.max(1, Math.min(120000, number(options.totalTimeoutMs) ? options.totalTimeoutMs : 120000));
  const timer = setTimeout(() => { result.timedOut = true; controller.abort(); }, deadline);
  let map: BackgroundRoadMap | null = null;
  try {
    checkAbort(controller.signal);
    map = options.factory({
      container: host, style, center: targets[0].center, zoom: targets[0].zoom, minZoom: 0, maxZoom: 16,
      bearing: 0, pitch: 0, interactive: false, attributionControl: false, maplibreLogo: false,
      trackResize: false, renderWorldCopies: false, pixelRatio: 1, maxTileCacheSize: tileCache, fadeDuration: 0,
    });
    options.onProgress?.({ completed: 0, total: result.total, ready: 0 });
    for (const [index, target] of targets.entries()) {
      let keepGoing = true;
      checkAbort(controller.signal);
      const waitTimedOut = await waitForArea(map, target, timeout, controller.signal);
      checkAbort(controller.signal);
      if (map.isStyleLoaded()) {
        const snapshot = collectLocalRoads({
          getStyle: () => map!.getStyle() as ReturnType<NonNullable<import('./contracts').MapLike['getStyle']>>,
          getZoom: () => map!.getZoom(),
          querySourceFeatures: (source, query) => map!.querySourceFeatures(source, query),
        }, { ...options.roadLimits, minZoom: target.zoom });
        keepGoing = await abortable(Promise.resolve(options.onSnapshot(snapshot, controller.signal, { index, target, waitTimedOut })), controller.signal) !== false;
        if (snapshot.state === 'ready') result.ready++;
      } else {
        const snapshot: RoadSnapshot = { key: 'empty', state: 'empty', sources: Object.keys(style.sources), features: [] };
        keepGoing = await abortable(Promise.resolve(options.onSnapshot(snapshot, controller.signal, { index, target, waitTimedOut })), controller.signal) !== false;
      }
      result.completed++;
      options.onProgress?.({ completed: result.completed, total: result.total, ready: result.ready });
      if (!keepGoing) break;
    }
    return result;
  } catch (error) {
    if (result.timedOut && !options.signal?.aborted) return result;
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    try { map?.remove(); } finally { host.remove(); }
  }
}
