/** Local, approximate walking paths from already loaded vector road geometry. */
export type RoadCoordinate = [number, number];
export interface RoadFeature {
  geometry?: { type?: unknown; coordinates?: unknown } | null;
  properties?: Record<string, unknown> | null;
}
export interface RoadRoute { coordinates: RoadCoordinate[]; distance: number }
export interface RoadGraphStats { nodes: number; edges: number; truncated: boolean }
interface Node { point: RoadCoordinate; grade: string; endpoint: boolean; links: Link[] }
interface Link { to: number; distance: number }
interface Segment { a: number; b: number; grade: string; splits: { t: number; node: number }[] }
interface Projection { point: RoadCoordinate; t: number; distance: number }
interface Snap extends Projection { segment: Segment }

const EARTH = 6371008.8;
const RAD = Math.PI / 180;
const WORLD = 2 * Math.PI * EARTH;
const CELL = 50;
const STITCH_METERS = 1.25;
const MAX_FEATURES = 25000;
const MAX_SEGMENTS = 75000;
const MAX_NODES = 120000;
const MAX_GRID_REFERENCES = 500000;
const MAX_SEGMENT_CELLS = 1024;
const MAX_SEARCH_NODES = 120000;
const MAX_INPUT_VERTICES = 250000;
const MAX_INPUT_LINES = 50000;
const MAX_JOIN_CHECKS = 500000;
const ROAD_CLASSES = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'track', 'path',
  'residential', 'unclassified', 'living_street', 'footway', 'cycleway', 'pedestrian', 'steps',
  'bridleway', 'road', 'primary_link', 'secondary_link', 'tertiary_link', 'motorway_link', 'trunk_link',
]);
const normalize = (n: number): number => ((n + 180) % 360 + 360) % 360 - 180;
const deltaLongitude = (from: number, to: number): number => normalize(to - from);
const valid = (point: unknown): point is RoadCoordinate => Array.isArray(point) && point.length >= 2 &&
  typeof point[0] === 'number' && typeof point[1] === 'number' && Number.isFinite(point[0]) &&
  Number.isFinite(point[1]) && Math.abs(point[1]) <= 85.051129;
const mercatorY = (lat: number): number => EARTH * Math.log(Math.tan(Math.PI / 4 + lat * RAD / 2));
const clean = (p: RoadCoordinate): RoadCoordinate => [normalize(p[0]), p[1]];

/** Great-circle weights and heuristic use the same metric, keeping A* admissible. */
export function roadDistance(a: RoadCoordinate, b: RoadCoordinate): number {
  const dlat = (b[1] - a[1]) * RAD;
  const dlon = deltaLongitude(a[0], b[0]) * RAD;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dlon / 2) ** 2;
  return 2 * EARTH * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

function projection(point: RoadCoordinate, a: RoadCoordinate, b: RoadCoordinate): Projection {
  // A local tangent plane gives a stable snap; the resulting cost is still spherical.
  const cosine = Math.cos(point[1] * RAD);
  const ax = deltaLongitude(point[0], a[0]) * cosine;
  const ay = a[1] - point[1];
  const dx = deltaLongitude(a[0], b[0]) * cosine;
  const dy = b[1] - a[1];
  const denominator = dx * dx + dy * dy;
  const t = denominator ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / denominator)) : 0;
  const p: RoadCoordinate = [normalize(a[0] + deltaLongitude(a[0], b[0]) * t), a[1] + (b[1] - a[1]) * t];
  return { point: p, t, distance: roadDistance(point, p) };
}

function allowed(properties: Record<string, unknown>): boolean {
  const kind = String(properties.class ?? properties.highway ?? properties.subclass ?? '').toLowerCase();
  if (!ROAD_CLASSES.has(kind)) return false;
  if (['no', 'private'].includes(String(properties.access ?? '').toLowerCase())) return false;
  const foot = String(properties.foot ?? '').toLowerCase();
  if (foot === 'no' || foot === 'private') return false;
  if (['motorway', 'trunk', 'motorway_link', 'trunk_link'].includes(kind) &&
    !['yes', 'designated', 'permissive'].includes(foot)) return false;
  return true;
}
function grade(properties: Record<string, unknown>): string {
  const structure = ['bridge', 'tunnel'].includes(String(properties.brunnel)) ? String(properties.brunnel) : 'ground';
  return `${structure}|${String(properties.layer ?? 0)}|${String(properties.level ?? 0)}`;
}

/** A bounded segment index; tile cuts and T junctions need no all-pairs intersection sweep. */
class SegmentIndex {
  private readonly cells = new Map<string, number[]>();
  private references = 0;
  add(id: number, a: RoadCoordinate, b: RoadCoordinate): boolean {
    const x0 = a[0] * RAD * EARTH;
    const x1 = x0 + deltaLongitude(a[0], b[0]) * RAD * EARTH;
    const y0 = mercatorY(a[1]), y1 = mercatorY(b[1]);
    let x = Math.floor(x0 / CELL), y = Math.floor(y0 / CELL);
    const endX = Math.floor(x1 / CELL), endY = Math.floor(y1 / CELL);
    const count = Math.abs(endX - x) + Math.abs(endY - y) + 1;
    if (count > MAX_SEGMENT_CELLS || this.references + count > MAX_GRID_REFERENCES) return false;
    const dx = x1 - x0, dy = y1 - y0, sx = Math.sign(dx), sy = Math.sign(dy);
    let tx = sx ? ((x + (sx > 0 ? 1 : 0)) * CELL - x0) / dx : Infinity;
    let ty = sy ? ((y + (sy > 0 ? 1 : 0)) * CELL - y0) / dy : Infinity;
    const dtx = sx ? CELL / Math.abs(dx) : Infinity, dty = sy ? CELL / Math.abs(dy) : Infinity;
    for (let step = 0; step < count; step++) {
      const key = `${x},${y}`, bucket = this.cells.get(key);
      if (bucket) bucket.push(id); else this.cells.set(key, [id]);
      this.references++;
      if (x === endX && y === endY) break;
      if (tx < ty) { x += sx; tx += dtx; }
      else { y += sy; ty += dty; }
    }
    return true;
  }
  near(point: RoadCoordinate, radius: number): Set<number> {
    const result = new Set<number>();
    const y = mercatorY(point[1]);
    const projectedRadius = radius / Math.max(0.08, Math.cos(point[1] * RAD));
    const minY = Math.floor((y - projectedRadius) / CELL), maxY = Math.floor((y + projectedRadius) / CELL);
    const baseX = point[0] * RAD * EARTH;
    for (const x of [baseX, baseX - WORLD, baseX + WORLD]) {
      const minX = Math.floor((x - projectedRadius) / CELL), maxX = Math.floor((x + projectedRadius) / CELL);
      for (let ix = minX; ix <= maxX; ix++) for (let iy = minY; iy <= maxY; iy++) {
        for (const id of this.cells.get(`${ix},${iy}`) ?? []) result.add(id);
      }
    }
    return result;
  }
}

interface QueueItem { node: number; g: number; f: number }
class MinHeap {
  private items: QueueItem[] = [];
  get size(): number { return this.items.length; }
  push(item: QueueItem): void {
    let at = this.items.length;
    this.items.push(item);
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (this.items[parent].f <= item.f) break;
      this.items[at] = this.items[parent]; at = parent;
    }
    this.items[at] = item;
  }
  pop(): QueueItem {
    const first = this.items[0], last = this.items.pop()!;
    if (!this.items.length) return first;
    let at = 0;
    while (true) {
      let child = at * 2 + 1;
      if (child >= this.items.length) break;
      if (child + 1 < this.items.length && this.items[child + 1].f < this.items[child].f) child++;
      if (this.items[child].f >= last.f) break;
      this.items[at] = this.items[child]; at = child;
    }
    this.items[at] = last;
    return first;
  }
}

export class RoadGraph {
  readonly stats: RoadGraphStats;
  constructor(private readonly nodes: Node[], private readonly segments: Segment[], private readonly index: SegmentIndex, truncated: boolean) {
    this.stats = { nodes: nodes.length, edges: nodes.reduce((n, node) => n + node.links.length, 0) / 2, truncated };
  }
  route(from: RoadCoordinate, to: RoadCoordinate, maxSnapMeters = 100): RoadRoute | null {
    if (!valid(from) || !valid(to) || !Number.isFinite(maxSnapMeters)) return null;
    const radius = Math.max(0, Math.min(100, maxSnapMeters));
    const start = this.snap(clean(from), radius), end = this.snap(clean(to), radius);
    if (!start || !end) return null;
    const startAnchors = this.anchors(start), endAnchors = this.anchors(end);
    const scores = new Map<number, number>(), previous = new Map<number, number>();
    const heap = new MinHeap();
    for (const anchor of startAnchors) {
      const g = roadDistance(start.point, this.nodes[anchor].point);
      scores.set(anchor, g);
      heap.push({ node: anchor, g, f: g + roadDistance(this.nodes[anchor].point, end.point) });
    }
    let best = start.segment === end.segment ? roadDistance(start.point, end.point) : Infinity;
    let finish = -1, visited = 0;
    const targets = new Set(endAnchors);
    while (heap.size) {
      const current = heap.pop();
      if (current.g !== scores.get(current.node)) continue;
      if (current.f >= best) break;
      if (++visited > MAX_SEARCH_NODES) return null;
      if (targets.has(current.node)) {
        const total = current.g + roadDistance(this.nodes[current.node].point, end.point);
        if (total < best) { best = total; finish = current.node; }
      }
      for (const link of this.nodes[current.node].links) {
        const g = current.g + link.distance;
        if (g >= (scores.get(link.to) ?? Infinity)) continue;
        scores.set(link.to, g); previous.set(link.to, current.node);
        heap.push({ node: link.to, g, f: g + roadDistance(this.nodes[link.to].point, end.point) });
      }
    }
    if (!Number.isFinite(best)) return null;
    const points: RoadCoordinate[] = [];
    if (finish >= 0) {
      const reversed: RoadCoordinate[] = [];
      for (let node: number | undefined = finish; node !== undefined; node = previous.get(node)) {
        reversed.push(this.nodes[node].point);
      }
      points.push(...reversed.reverse());
    }
    const coordinates: RoadCoordinate[] = [];
    for (const point of [start.point, ...points, end.point]) {
      const last = coordinates[coordinates.length - 1];
      if (!last || roadDistance(last, point) > 0.005) {
        // Unwrap the output line only; the graph itself uses normalized coordinates.
        coordinates.push(last ? [last[0] + deltaLongitude(last[0], point[0]), point[1]] : [...point]);
      }
    }
    if (coordinates.length === 1) coordinates.push([...coordinates[0]]);
    return { coordinates, distance: best };
  }
  private snap(point: RoadCoordinate, radius: number): Snap | null {
    let closest: Snap | null = null;
    for (const id of this.index.near(point, radius)) {
      const segment = this.segments[id];
      const candidate = projection(point, this.nodes[segment.a].point, this.nodes[segment.b].point);
      if (candidate.distance <= radius && (!closest || candidate.distance < closest.distance)) closest = { ...candidate, segment };
    }
    return closest;
  }
  private anchors(snap: Snap): number[] {
    const splits = snap.segment.splits;
    for (let i = 1; i < splits.length; i++) if (snap.t <= splits[i].t) return [splits[i - 1].node, splits[i].node];
    return [splits[splits.length - 1].node];
  }
}

export function buildRoadGraph(features: readonly RoadFeature[]): RoadGraph {
  const nodes: Node[] = [], segments: Segment[] = [];
  const keys = new Map<string, number>(), edges = new Set<string>();
  const index = new SegmentIndex();
  let truncated = false;
  let inputVertices = 0, inputLines = 0;
  const getNode = (point: RoadCoordinate, level: string, endpoint: boolean): number => {
    const key = `${Math.round(point[0] * 1e6)},${Math.round(point[1] * 1e6)}|${level}`;
    const existing = keys.get(key);
    if (existing !== undefined) { if (endpoint) nodes[existing].endpoint = true; return existing; }
    if (nodes.length >= MAX_NODES) { truncated = true; return -1; }
    const id = nodes.length;
    nodes.push({ point, grade: level, endpoint, links: [] }); keys.set(key, id);
    return id;
  };
  featureLoop: for (let f = 0; f < features.length; f++) {
    if (f >= MAX_FEATURES) { truncated = true; break; }
    const feature = features[f];
    if (!feature || !feature.geometry || !allowed(feature.properties ?? {})) continue;
    const geometry = feature.geometry;
    const lines: unknown[] = geometry.type === 'LineString' ? [geometry.coordinates] :
      geometry.type === 'MultiLineString' && Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
    const level = grade(feature.properties ?? {});
    for (const line of lines) {
      if (++inputLines > MAX_INPUT_LINES) { truncated = true; break featureLoop; }
      if (!Array.isArray(line) || line.length < 2) continue;
      // Invalid vertices split a feature; never bridge over corrupt coordinates.
      let previous = -1;
      for (let i = 0; i < line.length; i++) {
        if (++inputVertices > MAX_INPUT_VERTICES) { truncated = true; break featureLoop; }
        if (segments.length >= MAX_SEGMENTS) { truncated = true; break featureLoop; }
        if (!valid(line[i])) { previous = -1; continue; }
        const point = clean(line[i]);
        const node = getNode(point, level, i === 0 || i === line.length - 1);
        if (node < 0) break featureLoop;
        if (previous >= 0 && previous !== node) {
          const key = `${Math.min(previous, node)},${Math.max(previous, node)}`;
          if (!edges.has(key)) {
            const segment: Segment = { a: previous, b: node, grade: level, splits: [{ t: 0, node: previous }, { t: 1, node }] };
            if (index.add(segments.length, nodes[previous].point, point)) { edges.add(key); segments.push(segment); }
            else truncated = true;
          }
        }
        previous = node;
      }
    }
  }

  const stitches: [number, number][] = [];
  const endpoints = nodes.flatMap((node, id) => node.endpoint ? [id] : []);
  let joinChecks = 0;
  endpointLoop: for (const id of endpoints) {
    const node = nodes[id];
    for (const segmentId of index.near(node.point, STITCH_METERS)) {
      if (++joinChecks > MAX_JOIN_CHECKS) { truncated = true; break endpointLoop; }
      const segment = segments[segmentId];
      if (segment.a === id || segment.b === id) continue;
      const a = nodes[segment.a], b = nodes[segment.b];
      const p = projection(node.point, a.point, b.point);
      if (p.distance > STITCH_METERS) continue;
      if (node.grade !== segment.grade) {
        // A bridge/tunnel can meet a surface road at an aligned feature endpoint.
        // It must never turn a crossing in the middle of a bridge into a junction.
        const target = roadDistance(node.point, a.point) <= STITCH_METERS ? segment.a :
          roadDistance(node.point, b.point) <= STITCH_METERS ? segment.b : -1;
        if (target < 0 || !nodes[target].endpoint || !transitionGrade(node.grade, segment.grade)) continue;
        const ownSegments = index.near(node.point, STITCH_METERS);
        let aligned = false;
        for (const ownId of ownSegments) {
          if (++joinChecks > MAX_JOIN_CHECKS) { truncated = true; break endpointLoop; }
          const own = segments[ownId];
          if (own.a !== id && own.b !== id) continue;
          const far = nodes[own.a === id ? own.b : own.a].point;
          const other = nodes[target === segment.a ? segment.b : segment.a].point;
          if (alignment(node.point, far, other) >= 0.7) { aligned = true; break; }
        }
        if (aligned) stitches.push([id, target]);
        continue;
      }
      const split = getNode(p.point, segment.grade, false);
      if (split < 0) continue;
      segment.splits.push({ t: p.t, node: split });
      if (split !== id) stitches.push([id, split]);
    }
  }
  const connected = new Set<string>();
  const connect = (a: number, b: number): void => {
    if (a === b) return;
    const key = `${Math.min(a, b)},${Math.max(a, b)}`;
    if (connected.has(key)) return;
    connected.add(key);
    const distance = roadDistance(nodes[a].point, nodes[b].point);
    nodes[a].links.push({ to: b, distance }); nodes[b].links.push({ to: a, distance });
  };
  for (const segment of segments) {
    segment.splits.sort((a, b) => a.t - b.t || a.node - b.node);
    segment.splits = segment.splits.filter((split, i, all) => i === 0 || split.node !== all[i - 1].node);
    for (let i = 1; i < segment.splits.length; i++) connect(segment.splits[i - 1].node, segment.splits[i].node);
  }
  for (const [a, b] of stitches) connect(a, b);
  return new RoadGraph(nodes, segments, index, truncated);
}

function transitionGrade(a: string, b: string): boolean {
  return a.startsWith('ground|') !== b.startsWith('ground|');
}
function alignment(origin: RoadCoordinate, a: RoadCoordinate, b: RoadCoordinate): number {
  const cosine = Math.cos(origin[1] * RAD);
  const ax = deltaLongitude(origin[0], a[0]) * cosine, ay = a[1] - origin[1];
  const bx = deltaLongitude(origin[0], b[0]) * cosine, by = b[1] - origin[1];
  const denominator = Math.hypot(ax, ay) * Math.hypot(bx, by);
  return denominator ? Math.abs((ax * bx + ay * by) / denominator) : 0;
}
