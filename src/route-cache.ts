import type { RoadRoute } from './routing-protocol';

export interface RouteCacheData {
  version: 1;
  routes: Array<{ key: string; route: RoadRoute }>;
}

export interface RouteCacheLimits { routes: number; vertices: number; routeVertices: number }
const DEFAULT_LIMITS: RouteCacheLimits = { routes: 500, vertices: 100000, routeVertices: 10000 };
const copyRoute = (route: RoadRoute): RoadRoute => ({
  distance: route.distance,
  coordinates: route.coordinates.map(([longitude, latitude]) => [longitude, latitude]),
});

function validKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length > 250) return false;
  try {
    const points: unknown = JSON.parse(key);
    return Array.isArray(points) && points.length === 2 && points.every(point =>
      Array.isArray(point) && point.length === 2 && typeof point[0] === 'number' &&
      typeof point[1] === 'number' && Number.isFinite(point[0]) && Number.isFinite(point[1]) &&
      Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90);
  } catch { return false; }
}

function validRoute(value: unknown, maxVertices: number): value is RoadRoute {
  if (!value || typeof value !== 'object') return false;
  const route = value as Partial<RoadRoute>;
  return typeof route.distance === 'number' && Number.isFinite(route.distance) && route.distance >= 0 &&
    Array.isArray(route.coordinates) && route.coordinates.length >= 2 && route.coordinates.length <= maxVertices &&
    route.coordinates.every(point => Array.isArray(point) && point.length === 2 &&
      typeof point[0] === 'number' && typeof point[1] === 'number' &&
      Number.isFinite(point[0]) && Number.isFinite(point[1]) &&
      // A short path crossing the date line may use unwrapped longitudes.
      Math.abs(point[0]) <= 540 && Math.abs(point[1]) <= 85.051129);
}

/** Bounded route geometry only. No marker names, groups or road database are persisted. */
export class RoadRouteCache {
  private readonly routes = new Map<string, RoadRoute>();
  private vertices = 0;
  private readonly limits: RouteCacheLimits;

  constructor(persisted?: unknown, private readonly onChange: () => void = () => {}, limits: Partial<RouteCacheLimits> = {}) {
    this.limits = Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([key, max]) => {
      const value = limits[key as keyof RouteCacheLimits];
      return [key, typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.min(max, Math.floor(value))) : max];
    })) as unknown as RouteCacheLimits;
    if (!persisted || typeof persisted !== 'object') return;
    const data = persisted as Partial<RouteCacheData>;
    if (data.version !== 1 || !Array.isArray(data.routes)) return;
    // Bounded work even when a malformed file contains an enormous routes array.
    for (const entry of data.routes.slice(-this.limits.routes)) {
      if (!entry || typeof entry !== 'object' || !validKey(entry.key) || !validRoute(entry.route, this.limits.routeVertices)) continue;
      this.insert(entry.key, copyRoute(entry.route));
    }
  }

  get(key: string): RoadRoute | undefined {
    const route = this.routes.get(key);
    return route ? copyRoute(route) : undefined;
  }

  /** Reads do not change recency, avoiding disk writes on every map idle event. */
  set(key: string, route: RoadRoute): boolean {
    if (!validKey(key) || !validRoute(route, this.limits.routeVertices) || route.coordinates.length > this.limits.vertices) return false;
    const previous = this.routes.get(key);
    if (previous && previous.distance === route.distance && previous.coordinates.length === route.coordinates.length &&
      previous.coordinates.every((point, index) => point[0] === route.coordinates[index][0] && point[1] === route.coordinates[index][1])) return false;
    this.insert(key, copyRoute(route));
    this.onChange();
    return true;
  }

  serialize(): RouteCacheData {
    return { version: 1, routes: [...this.routes].map(([key, route]) => ({ key, route: copyRoute(route) })) };
  }

  private insert(key: string, route: RoadRoute): void {
    const previous = this.routes.get(key);
    if (previous) { this.vertices -= previous.coordinates.length; this.routes.delete(key); }
    this.routes.set(key, route);
    this.vertices += route.coordinates.length;
    while (this.routes.size > this.limits.routes || this.vertices > this.limits.vertices) {
      const first = this.routes.entries().next().value as [string, RoadRoute] | undefined;
      if (!first) break;
      this.vertices -= first[1].coordinates.length;
      this.routes.delete(first[0]);
    }
  }
}
