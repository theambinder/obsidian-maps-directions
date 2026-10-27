import { autoPreparationKey } from './auto-preparation';
import { roadDistance, type RoadCoordinate, type RoadRoute } from './road-graph';

export type TripTaskState = 'queued' | 'preparing' | 'ready' | 'no-path' | 'unavailable' | 'paused' | 'direct';
export type TripTaskResult = 'ready' | 'no-path' | 'unavailable';
export interface TripArea { center: RoadCoordinate; zoom: number; stage: 'overview' | 'corridor' | 'endpoint' }
export interface TripConnection { key: string; from: RoadCoordinate; to: RoadCoordinate; areas: TripArea[] }
export interface TripTask extends TripConnection {
  state: TripTaskState;
  nextArea: number;
  updatedAt: number;
  reason?: string;
  /** Active road geometry is not persisted; only an interrupted connection replays. */
  restarted?: boolean;
  /** Durable path geometry prevents a small opportunistic cache from evicting trip results. */
  route?: RoadRoute;
  /** Outcome restored when the distance policy later makes this connection eligible. */
  distancePreviousState?: Exclude<TripTaskState, 'direct'>;
  distancePreviousReason?: string;
}
export interface TripQueueData { version: 1; tasks: TripTask[] }
export interface TripQueueSnapshot {
  total: number; processed: number; ready: number; noPath: number; unavailable: number;
  paused: number; queued: number; preparing: number; percentComplete: number;
  percentRemaining: number; areasProcessed: number; areasTotal: number;
  /** Straight connections deliberately excluded from road calculation and progress. */
  direct?: number;
  /** Connections included in road calculation progress; excludes direct connections. */
  eligible?: number;
}
export interface TripConnectionPlan {
  areas: TripArea[];
  distanceMeters: number;
  overviewZoom: number;
  /** Full street-detail corridor coverage, distinct from a coarse regional attempt. */
  detailedCoverage: boolean;
}

const STATES = new Set<TripTaskState>(['queued', 'preparing', 'ready', 'no-path', 'unavailable', 'paused', 'direct']);
const RESULTS = new Set<TripTaskState>(['ready', 'no-path', 'unavailable', 'direct']);
const STAGES = new Set<TripArea['stage']>(['overview', 'corridor', 'endpoint']);
const EARTH = 6371008.8;
const WORLD = 2 * Math.PI * EARTH;
const RAD = Math.PI / 180;
const WIDTH = 768;
const HEIGHT = 512;
const TILE = 512;
const normalize = (longitude: number): number => ((longitude + 180) % 360 + 360) % 360 - 180;
const point = (value: unknown): value is RoadCoordinate => Array.isArray(value) && value.length === 2 &&
  typeof value[0] === 'number' && Number.isFinite(value[0]) && typeof value[1] === 'number' &&
  Number.isFinite(value[1]) && Math.abs(value[1]) <= 85.051129;
const cleanPoint = (value: RoadCoordinate): RoadCoordinate => [normalize(value[0]), value[1]];
const project = ([longitude, latitude]: RoadCoordinate): RoadCoordinate => [longitude * RAD * EARTH, EARTH * Math.log(Math.tan(Math.PI / 4 + latitude * RAD / 2))];
const unproject = ([x, y]: RoadCoordinate): RoadCoordinate => [normalize(x / EARTH / RAD), (2 * Math.atan(Math.exp(y / EARTH)) - Math.PI / 2) / RAD];
const cloneArea = (area: TripArea): TripArea => ({ center: [...area.center], zoom: area.zoom, stage: area.stage });
const cloneRoute = (route: RoadRoute): RoadRoute => ({ distance: route.distance, coordinates: route.coordinates.map(coordinate => [...coordinate]) });
const cloneTask = (task: TripTask): TripTask => ({ ...task, from: [...task.from], to: [...task.to], areas: task.areas.map(cloneArea), ...(task.route ? { route: cloneRoute(task.route) } : {}) });
const validRoute = (value: unknown): value is RoadRoute => {
  if (!value || typeof value !== 'object') return false;
  const route = value as Partial<RoadRoute>;
  return typeof route.distance === 'number' && Number.isFinite(route.distance) && route.distance >= 0 &&
    Array.isArray(route.coordinates) && route.coordinates.length >= 2 && route.coordinates.every(point);
};
const validArea = (value: unknown): value is TripArea => {
  if (!value || typeof value !== 'object') return false;
  const area = value as Partial<TripArea>;
  return point(area.center) && typeof area.zoom === 'number' && Number.isFinite(area.zoom) && area.zoom >= 0 && area.zoom <= 16 && STAGES.has(area.stage!);
};
const validConnection = (value: unknown): value is TripConnection => {
  if (!value || typeof value !== 'object') return false;
  const task = value as Partial<TripConnection>;
  return typeof task.key === 'string' && task.key.length > 0 && task.key.length <= 1000 && point(task.from) && point(task.to) &&
    Array.isArray(task.areas) && task.areas.every(validArea);
};
const samePoint = (a: RoadCoordinate, b: RoadCoordinate): boolean => normalize(a[0]) === normalize(b[0]) && a[1] === b[1];
const reasonText = (value: unknown): string | undefined => typeof value === 'string' && value.length <= 500 ? value : undefined;

/** Endpoints are ordered; source configuration is hashed rather than saved as a URL. */
export function tripConnectionKey(from: RoadCoordinate, to: RoadCoordinate, sourceContext: string): string {
  return autoPreparationKey(JSON.stringify([cleanPoint(from), cleanPoint(to)]), `trip-queue-v1:${sourceContext}`);
}

/** The setting measures the geodesic straight-line distance before any road search. */
export function exceedsRoadDistance(from: RoadCoordinate, to: RoadCoordinate, maxDistanceKm?: number | null): boolean {
  return typeof maxDistanceKm === 'number' && Number.isFinite(maxDistanceKm) && maxDistanceKm > 0 &&
    roadDistance(from, to) / 1000 > maxDistanceKm;
}

export function roadDistanceLimitReason(from: RoadCoordinate, to: RoadCoordinate, maxDistanceKm: number): string {
  return `Straight line: ${(roadDistance(from, to) / 1000).toFixed(1)} km exceeds the ${maxDistanceKm} km road calculation limit.`;
}

/**
 * A resumable itinerary ledger. There is no cap on the number of trip connections.
 * Completed outcomes are durable. Only an unfinished connection replays its small
 * area plan after reload, since its temporary road network is deliberately not saved.
 */
export class TripQueue {
  private readonly tasks = new Map<string, TripTask>();
  constructor(persisted?: unknown, private readonly onChange: () => void = () => {}, private readonly now: () => number = Date.now) {
    if (!persisted || typeof persisted !== 'object') return;
    const data = persisted as Partial<TripQueueData>;
    if (data.version !== 1 || !Array.isArray(data.tasks)) return;
    for (const original of data.tasks) {
      if (!validConnection(original) || !STATES.has(original.state) || typeof original.updatedAt !== 'number' ||
        !Number.isFinite(original.updatedAt) || original.updatedAt < 0 || !Number.isInteger(original.nextArea) ||
        original.nextArea < 0 || original.nextArea > original.areas.length) continue;
      const { route: rawRoute, ...metadata } = original;
      const task = cloneTask({ ...metadata, ...(validRoute(rawRoute) ? { route: rawRoute } : {}) });
      if (task.state === 'ready' && !task.route) { task.state = 'queued'; task.nextArea = 0; task.reason = 'Saved route data unavailable.'; }
      task.from = cleanPoint(task.from); task.to = cleanPoint(task.to);
      task.reason = reasonText(task.reason);
      const previousState: unknown = original.distancePreviousState;
      if (task.state === 'direct' && typeof previousState === 'string' && previousState !== 'direct' && STATES.has(previousState as TripTaskState)) {
        task.distancePreviousState = previousState as Exclude<TripTaskState, 'direct'>;
        task.distancePreviousReason = reasonText(original.distancePreviousReason);
      } else { delete task.distancePreviousState; delete task.distancePreviousReason; }
      if (task.state === 'preparing' || task.state === 'queued') {
        task.restarted = task.nextArea > 0 || task.state === 'preparing';
        task.state = 'queued'; task.nextArea = 0;
      } else if (task.state === 'paused') {
        task.restarted = task.nextArea > 0;
        task.nextArea = 0;
      }
      this.tasks.set(task.key, task);
    }
  }

  /** Upsert this view's connections without deleting progress owned by other views. */
  reconcile(connections: readonly TripConnection[]): string[] {
    const keys: string[] = [], unique = new Set<string>();
    let changed = false;
    for (const original of connections) {
      if (!validConnection(original) || unique.has(original.key)) continue;
      unique.add(original.key); keys.push(original.key);
      const current = this.tasks.get(original.key);
      if (current && samePoint(current.from, original.from) && samePoint(current.to, original.to)) continue;
      this.tasks.set(original.key, {
        key: original.key, from: cleanPoint(original.from), to: cleanPoint(original.to),
        areas: original.areas.map(cloneArea), state: 'queued', nextArea: 0, updatedAt: this.now(),
      });
      changed = true;
    }
    if (changed) this.onChange();
    return keys;
  }

  status(key: string): Pick<TripTask, 'state' | 'reason' | 'nextArea' | 'updatedAt'> | undefined {
    const task = this.tasks.get(key);
    return task ? { state: task.state, reason: task.reason, nextArea: task.nextArea, updatedAt: task.updatedAt } : undefined;
  }

  get(key: string): TripTask | undefined { const task = this.tasks.get(key); return task ? cloneTask(task) : undefined; }
  next(keys?: readonly string[]): TripTask | null {
    for (const task of this.selected(keys)) if (task.state === 'queued') return cloneTask(task);
    return null;
  }
  start(key: string): boolean {
    const task = this.tasks.get(key);
    if (!task || task.state !== 'queued') return false;
    task.state = 'preparing'; task.reason = undefined; task.restarted = false; this.changed(task);
    return true;
  }
  checkpoint(key: string, nextArea: number): boolean {
    const task = this.tasks.get(key);
    if (!task || task.state !== 'preparing' || !Number.isInteger(nextArea) || nextArea < task.nextArea || nextArea > task.areas.length) return false;
    if (task.nextArea !== nextArea) { task.nextArea = nextArea; this.changed(task); }
    return true;
  }
  /** Replace an oversized area with smaller overlapping children, keeping its position. */
  replaceArea(key: string, index: number, areas: readonly TripArea[]): boolean {
    const task = this.tasks.get(key);
    if (!task || task.state !== 'preparing' || index !== task.nextArea || !areas.length || !areas.every(validArea)) return false;
    task.areas.splice(index, 1, ...areas.map(cloneArea)); this.changed(task); return true;
  }
  finish(key: string, state: TripTaskResult, reason?: string, route?: RoadRoute): boolean {
    const task = this.tasks.get(key);
    if (!task || task.state === 'direct' || !RESULTS.has(state) || route !== undefined && !validRoute(route) || state === 'ready' && !route && !task.route) return false;
    const text = reasonText(reason);
    const sameRoute = route === undefined || task.route !== undefined && route.distance === task.route.distance &&
      route.coordinates.length === task.route.coordinates.length && route.coordinates.every((coordinate, index) => coordinate[0] === task.route!.coordinates[index][0] && coordinate[1] === task.route!.coordinates[index][1]);
    if (task.state === state && task.reason === text && sameRoute) return true;
    task.state = state; task.reason = text; task.restarted = false;
    task.route = state === 'ready' ? route ? cloneRoute(route) : task.route : undefined;
    this.changed(task); return true;
  }
  /** Keep previously computed geometry so increasing the limit can restore it without new loading. */
  setDirect(key: string, reason = 'Straight line: road calculation distance limit.'): boolean {
    const task = this.tasks.get(key);
    if (!task) return false;
    const text = reasonText(reason);
    if (task.state === 'direct' && task.reason === text) return true;
    if (task.state !== 'direct') {
      task.distancePreviousState = task.state;
      task.distancePreviousReason = task.reason;
    }
    task.state = 'direct'; task.reason = text; task.restarted = false;
    this.changed(task); return true;
  }

  /** Re-enable a formerly excluded connection; uncalculated empty plans are rebuilt lazily. */
  restoreDirect(key: string, areas?: readonly TripArea[]): boolean {
    const task = this.tasks.get(key);
    if (!task || task.state !== 'direct' || areas !== undefined && !areas.every(validArea)) return false;
    const previousState = task.distancePreviousState, previousReason = task.distancePreviousReason;
    if (task.route) { task.state = 'ready'; task.reason = previousReason; task.restarted = false; }
    else if (previousState === 'no-path' || previousState === 'unavailable' || previousState === 'paused') {
      // A setting edit must not discard an earlier completed outcome or user pause.
      task.state = previousState; task.reason = previousReason; task.restarted = false;
    } else {
      task.state = 'queued'; task.nextArea = 0; task.reason = undefined; task.restarted = true;
      if (areas) task.areas = areas.map(cloneArea);
      if (!task.areas.length) task.areas = planTripConnection(task.from, task.to).areas;
    }
    delete task.distancePreviousState; delete task.distancePreviousReason;
    this.changed(task); return true;
  }

  pause(key: string, reason?: string): boolean {
    const task = this.tasks.get(key);
    if (!task || RESULTS.has(task.state)) return false;
    const text = reasonText(reason);
    if (task.state === 'paused' && task.reason === text) return true;
    task.state = 'paused'; task.reason = text; this.changed(task); return true;
  }
  /** Retry one task, or all paused tasks. Road geometry is rebuilt for that task only. */
  resume(key?: string): void {
    let changed = false;
    for (const task of key ? this.selected([key]) : this.tasks.values()) {
      if (task.state !== 'paused') continue;
      task.state = 'queued'; task.nextArea = 0; task.reason = undefined; task.restarted = true; task.updatedAt = this.now(); changed = true;
    }
    if (changed) this.onChange();
  }
  retry(key: string): boolean {
    const task = this.tasks.get(key);
    if (!task || task.state === 'direct') return false;
    if (task.state === 'queued' && task.nextArea === 0 && !task.reason) return true;
    task.state = 'queued'; task.nextArea = 0; task.reason = undefined; task.route = undefined; task.restarted = true;
    delete task.distancePreviousState; delete task.distancePreviousReason;
    this.changed(task); return true;
  }
  snapshot(keys?: readonly string[]): TripQueueSnapshot {
    const result: TripQueueSnapshot = { total: 0, processed: 0, ready: 0, noPath: 0, unavailable: 0, paused: 0, queued: 0, preparing: 0, percentComplete: 100, percentRemaining: 0, areasProcessed: 0, areasTotal: 0, direct: 0, eligible: 0 };
    for (const task of this.selected(keys)) {
      result.total++;
      if (task.state === 'direct') { result.direct = (result.direct ?? 0) + 1; continue; }
      result.eligible = (result.eligible ?? 0) + 1;
      result.areasTotal += task.areas.length; result.areasProcessed += task.nextArea;
      if (RESULTS.has(task.state)) result.processed++;
      if (task.state === 'no-path') result.noPath++;
      else result[task.state]++;
    }
    if (result.eligible) {
      const rounded = Math.round(result.processed / result.eligible * 1000) / 10;
      result.percentComplete = result.processed < result.eligible ? Math.min(99.9, rounded) : 100;
      result.percentRemaining = Math.round((100 - result.percentComplete) * 10) / 10;
    }
    return result;
  }
  serialize(): TripQueueData { return { version: 1, tasks: [...this.tasks.values()].map(cloneTask) }; }
  private *selected(keys?: readonly string[]): IterableIterator<TripTask> {
    if (!keys) { yield* this.tasks.values(); return; }
    const seen = new Set<string>();
    for (const key of keys) { if (seen.has(key)) continue; seen.add(key); const task = this.tasks.get(key); if (task) yield task; }
  }
  private changed(task: TripTask): void { task.updatedAt = this.now(); this.onChange(); }
}

/**
 * Adaptive per-connection coverage. A long connection gets a regional overview,
 * a finer corridor and street-detail endpoints, never an endpoint-only silent skip.
 * A failed coarse attempt must be reported as insufficient regional detail rather
 * than proof that no real walking path exists.
 */
export function planTripConnection(from: RoadCoordinate, to: RoadCoordinate): TripConnectionPlan {
  if (!point(from) || !point(to)) return { areas: [], distanceMeters: 0, overviewZoom: 14, detailedCoverage: false };
  const a = project(cleanPoint(from)), b = project(cleanPoint(to));
  b[0] = a[0] + normalize(to[0] - from[0]) * RAD * EARTH;
  const spanX = Math.max(200, Math.abs(b[0] - a[0])), spanY = Math.max(200, Math.abs(b[1] - a[1]));
  const overviewZoom = Math.max(0, Math.min(14, Math.floor(Math.log2(Math.min(WIDTH / (spanX * 1.4), HEIGHT / (spanY * 1.4)) * WORLD / TILE))));
  const corridorZoom = overviewZoom >= 11 ? 14 : Math.min(14, overviewZoom + 2);
  const areas: TripArea[] = [];
  const add = (center: RoadCoordinate, zoom: number, stage: TripArea['stage']): void => {
    const threshold = WORLD / TILE / 2 ** zoom * Math.min(WIDTH, HEIGHT) * 0.18;
    if (areas.some(area => area.zoom === zoom && roadDistance(area.center, center) / Math.max(0.08, Math.cos(center[1] * RAD)) < threshold)) return;
    areas.push({ center: cleanPoint(center), zoom, stage });
  };
  add(unproject([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]), overviewZoom, 'overview');
  add(cleanPoint(from), 14, 'endpoint'); add(cleanPoint(to), 14, 'endpoint');
  const step = WORLD / TILE / 2 ** corridorZoom * Math.min(WIDTH, HEIGHT) * 0.5;
  const count = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
  for (let index = 0; index <= count; index++) add(unproject([a[0] + (b[0] - a[0]) * index / count, a[1] + (b[1] - a[1]) * index / count]), corridorZoom, 'corridor');
  return { areas, distanceMeters: roadDistance(cleanPoint(from), cleanPoint(to)), overviewZoom, detailedCoverage: corridorZoom === 14 };
}

/** Four smaller views cover one dense view while preserving overlap. */
export function subdivideTripArea(area: TripArea): TripArea[] {
  if (!validArea(area) || area.zoom >= 16) return [];
  const center = project(area.center), metersPerPixel = WORLD / TILE / 2 ** area.zoom;
  return [-1, 1].flatMap(x => [-1, 1].map(y => ({
    center: unproject([center[0] + x * WIDTH * metersPerPixel / 4, Math.max(-WORLD / 2, Math.min(WORLD / 2, center[1] + y * HEIGHT * metersPerPixel / 4))]),
    zoom: area.zoom + 1, stage: area.stage,
  })));
}
