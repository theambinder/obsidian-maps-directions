/** Local, approximate walking paths from already loaded vector road geometry. */
export type RoadCoordinate = [number, number];
export interface RoadAnchor { point: RoadCoordinate; grade: string; bearing?: number }
/** A cross-section perpendicular to from→to, centered on the corridor. */
export interface RoadGate {
  from: RoadCoordinate;
  to: RoadCoordinate;
  center: RoadCoordinate;
  halfWidthMeters: number;
  maxPortals?: number;
}
export interface RoadFeature {
  geometry?: { type?: unknown; coordinates?: unknown } | null;
  properties?: Record<string, unknown> | null;
}
export interface RoadRoute { coordinates: RoadCoordinate[]; distance: number }
export interface RoadGraphStats { nodes: number; edges: number; truncated: boolean }
interface Node { point: RoadCoordinate; grade: string; endpoint: boolean; originalEndpoint: boolean; links: Link[] }
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
const MAX_SNAP_CANDIDATES = 12;
const STRICT_ANCHOR_METERS = 0.05;
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
const segmentBearing = (a: RoadCoordinate, b: RoadCoordinate, latitude: number): number =>
  ((Math.atan2(b[1] - a[1], deltaLongitude(a[0], b[0]) * Math.cos(latitude * RAD)) / RAD) % 180 + 180) % 180;

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
  /** Candidate crossings share a cell; callers count duplicate visits in their budget. */
  *pairs(): IterableIterator<[number, number]> {
    const worldCells = Math.floor(WORLD / CELL);
    for (const [key, bucket] of this.cells) {
      for (let left = 0; left < bucket.length; left++) {
        for (let right = left + 1; right < bucket.length; right++) yield [bucket[left], bucket[right]];
      }
      // Date-line segments may be indexed in adjacent world copies. A world
      // width is not an integer cell count, so both neighboring shifts matter.
      const [x, y] = key.split(',').map(Number);
      for (const shift of [worldCells, worldCells + 1, -worldCells, -worldCells - 1]) {
        const mirrored = this.cells.get(`${x + shift},${y}`);
        if (!mirrored) continue;
        for (const left of bucket) for (const right of mirrored) if (left !== right) yield [left, right];
      }
    }
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
  private readonly components: Int32Array;
  constructor(private readonly nodes: Node[], private readonly segments: Segment[], private readonly index: SegmentIndex, truncated: boolean) {
    this.stats = { nodes: nodes.length, edges: nodes.reduce((n, node) => n + node.links.length, 0) / 2, truncated };
    // Keep one nearby alternative per component: the closest sidewalk or indoor
    // fragment can be disconnected while a usable street is a few metres away.
    this.components = new Int32Array(nodes.length).fill(-1);
    const queue = new Uint32Array(nodes.length);
    let component = 0;
    for (let id = 0; id < nodes.length; id++) {
      if (this.components[id] !== -1) continue;
      let head = 0, tail = 1;
      queue[0] = id;
      this.components[id] = component;
      while (head < tail) {
        const node = queue[head++];
        for (const link of nodes[node].links) if (this.components[link.to] === -1) {
          this.components[link.to] = component;
          queue[tail++] = link.to;
        }
      }
      component++;
    }
  }
  /** Real road intersections with a corridor cross-section, spread across its width. */
  portals(gate: RoadGate): RoadAnchor[] {
    if (!gate || !valid(gate.from) || !valid(gate.to) || !valid(gate.center) ||
      !Number.isFinite(gate.halfWidthMeters) || gate.halfWidthMeters < 0) return [];
    const limit = Number.isFinite(gate.maxPortals) ? Math.max(0, Math.min(12, Math.floor(gate.maxPortals!))) : 8;
    if (!limit) return [];
    const cosine = Math.cos(gate.center[1] * RAD);
    const local = (point: RoadCoordinate): RoadCoordinate => [deltaLongitude(gate.center[0], point[0]) * cosine * RAD * EARTH, (point[1] - gate.center[1]) * RAD * EARTH];
    const from = local(gate.from), to = local(gate.to);
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    if (length < 0.001) return [];
    const ux = (to[0] - from[0]) / length, uy = (to[1] - from[1]) / length;
    type Portal = { anchor: RoadAnchor; lateral: number; component: number; key: string };
    const candidates = new Map<string, Portal>();
    for (const segment of this.segments) {
      const a = this.nodes[segment.a].point, b = this.nodes[segment.b].point;
      const p = local(a), q = local(b);
      const alongA = p[0] * ux + p[1] * uy, alongB = q[0] * ux + q[1] * uy;
      const denominator = alongA - alongB;
      let t: number;
      if (Math.abs(denominator) < 1e-9) {
        if (Math.abs(alongA) > 1e-6) continue;
        // A road lying on the gate contributes its nearest real point.
        const dx = q[0] - p[0], dy = q[1] - p[1], squared = dx * dx + dy * dy;
        t = squared ? Math.max(0, Math.min(1, -(p[0] * dx + p[1] * dy) / squared)) : 0;
      } else {
        t = alongA / denominator;
        if (t < -1e-10 || t > 1 + 1e-10) continue;
        t = Math.max(0, Math.min(1, t));
      }
      const x = p[0] + (q[0] - p[0]) * t, y = p[1] + (q[1] - p[1]) * t;
      const lateral = -x * uy + y * ux;
      if (Math.abs(lateral) > gate.halfWidthMeters + 1e-6) continue;
      const point: RoadCoordinate = [normalize(a[0] + deltaLongitude(a[0], b[0]) * t), a[1] + (b[1] - a[1]) * t];
      const key = `${point[0].toFixed(8)},${point[1].toFixed(8)}|${segment.grade}`;
      const candidate: Portal = { anchor: { point, grade: segment.grade, bearing: segmentBearing(a, b, point[1]) }, lateral, component: this.components[segment.a], key };
      const prior = candidates.get(key);
      if (!prior || candidate.anchor.bearing! < prior.anchor.bearing! || candidate.anchor.bearing === prior.anchor.bearing &&
        (point[0] < prior.anchor.point[0] || point[0] === prior.anchor.point[0] && point[1] < prior.anchor.point[1])) candidates.set(key, candidate);
    }
    const ordered = [...candidates.values()].sort((a, b) => Math.abs(a.lateral) - Math.abs(b.lateral) || a.key.localeCompare(b.key));
    if (!ordered.length) return [];
    const selected = [ordered.shift()!], components = new Set([selected[0].component]);
    const diversityBonus = Math.max(1, gate.halfWidthMeters * 2 / limit);
    while (selected.length < limit && ordered.length) {
      let best = 0, bestScore = -Infinity;
      for (let index = 0; index < ordered.length; index++) {
        const candidate = ordered[index];
        const spacing = Math.min(...selected.map(other => Math.abs(candidate.lateral - other.lateral)));
        const score = spacing + (components.has(candidate.component) ? 0 : diversityBonus);
        if (score > bestScore) { best = index; bestScore = score; }
      }
      const candidate = ordered.splice(best, 1)[0];
      selected.push(candidate); components.add(candidate.component);
    }
    return selected.map(candidate => candidate.anchor);
  }

  route(from: RoadCoordinate, to: RoadCoordinate, maxSnapMeters = 100, anchors?: { from?: RoadAnchor; to?: RoadAnchor }): RoadRoute | null {
    if (!valid(from) || !valid(to) || !Number.isFinite(maxSnapMeters)) return null;
    const radius = Math.max(0, Math.min(1000, maxSnapMeters));
    const origin = clean(from), destination = clean(to);
    const strict = (point: RoadCoordinate, anchor: RoadAnchor): Snap[] => !valid(anchor?.point) || typeof anchor.grade !== 'string' ||
      anchor.bearing !== undefined && (!Number.isFinite(anchor.bearing) || anchor.bearing < 0 || anchor.bearing > 180) ||
      roadDistance(point, anchor.point) > STRICT_ANCHOR_METERS ? [] : this.snapCandidates(clean(anchor.point), STRICT_ANCHOR_METERS, anchor.grade, anchor.bearing);
    let starts = anchors?.from ? strict(origin, anchors.from) : this.snapCandidates(origin, radius);
    let ends = anchors?.to ? strict(destination, anchors.to) : this.snapCandidates(destination, radius);
    if (!starts.length || !ends.length) return null;
    // Preserve the nearest-road route whenever that network is connected.
    // Alternatives only recover a route that nearest-only snapping could not find.
    if (this.components[starts[0].segment.a] === this.components[ends[0].segment.a]) {
      starts = [starts[0]];
      ends = [ends[0]];
    } else {
      const endsByComponent = new Map(ends.map(snap => [this.components[snap.segment.a], snap]));
      const pairs = starts.flatMap(start => {
        const end = endsByComponent.get(this.components[start.segment.a]);
        return end ? [{ start, end }] : [];
      }).sort((a, b) => a.start.distance + a.end.distance - b.start.distance - b.end.distance)
        .slice(0, MAX_SNAP_CANDIDATES);
      starts = pairs.map(pair => pair.start);
      ends = pairs.map(pair => pair.end);
    }
    if (!starts.length || !ends.length) return null;
    const scores = new Map<number, number>(), previous = new Map<number, number>();
    const origins = new Map<number, Snap>();
    const heap = new MinHeap();
    for (const start of starts) for (const anchor of this.anchors(start)) {
      const g = start.distance + roadDistance(start.point, this.nodes[anchor].point);
      if (g >= (scores.get(anchor) ?? Infinity)) continue;
      scores.set(anchor, g); origins.set(anchor, start);
      heap.push({ node: anchor, g, f: g + roadDistance(this.nodes[anchor].point, destination) });
    }
    const targets = new Map<number, { cost: number; snap: Snap }>();
    for (const end of ends) for (const anchor of this.anchors(end)) {
      const cost = end.distance + roadDistance(this.nodes[anchor].point, end.point);
      if (cost < (targets.get(anchor)?.cost ?? Infinity)) targets.set(anchor, { cost, snap: end });
    }
    let best = Infinity;
    let start: Snap | null = null, end: Snap | null = null;
    for (const candidateStart of starts) for (const candidateEnd of ends) {
      if (candidateStart.segment !== candidateEnd.segment) continue;
      const distance = candidateStart.distance + roadDistance(candidateStart.point, candidateEnd.point) + candidateEnd.distance;
      if (distance < best) { best = distance; start = candidateStart; end = candidateEnd; }
    }
    let finish = -1, visited = 0;
    while (heap.size) {
      const current = heap.pop();
      if (current.g !== scores.get(current.node)) continue;
      if (current.f >= best) break;
      if (++visited > MAX_SEARCH_NODES) return null;
      const target = targets.get(current.node);
      if (target) {
        const total = current.g + target.cost;
        if (total < best) { best = total; finish = current.node; start = origins.get(current.node)!; end = target.snap; }
      }
      for (const link of this.nodes[current.node].links) {
        const g = current.g + link.distance;
        if (g >= (scores.get(link.to) ?? Infinity)) continue;
        scores.set(link.to, g); previous.set(link.to, current.node); origins.set(link.to, origins.get(current.node)!);
        heap.push({ node: link.to, g, f: g + roadDistance(this.nodes[link.to].point, destination) });
      }
    }
    if (!Number.isFinite(best) || !start || !end) return null;
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
    return { coordinates, distance: Math.max(0, best - start.distance - end.distance) };
  }
  private snapCandidates(point: RoadCoordinate, radius: number, requiredGrade?: string, requiredBearing?: number): Snap[] {
    const nearest = new Map<number, { id: number; snap: Snap }>();
    for (const id of this.index.near(point, radius)) {
      const segment = this.segments[id];
      if (requiredGrade !== undefined && segment.grade !== requiredGrade) continue;
      if (requiredBearing !== undefined) {
        const difference = Math.abs(segmentBearing(this.nodes[segment.a].point, this.nodes[segment.b].point, point[1]) - requiredBearing);
        if (Math.min(difference, 180 - difference) > 0.1) continue;
      }
      const candidate = projection(point, this.nodes[segment.a].point, this.nodes[segment.b].point);
      const component = this.components[segment.a];
      const existing = nearest.get(component);
      if (candidate.distance <= radius && (!existing || candidate.distance < existing.snap.distance ||
        (candidate.distance === existing.snap.distance && id < existing.id))) {
        nearest.set(component, { id, snap: { ...candidate, segment } });
      }
    }
    return [...nearest.values()].sort((a, b) => a.snap.distance - b.snap.distance || a.id - b.id)
      .map(candidate => candidate.snap);
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
  const getNode = (point: RoadCoordinate, level: string, endpoint: boolean, originalEndpoint = false): number => {
    // Millimetre-scale canonical coordinates keep strict anchors stable between
    // clipped windows; the former 1e-6 grid could move a road by over 5 cm.
    const canonical: RoadCoordinate = [normalize(Math.round(point[0] * 1e8) / 1e8), Math.round(point[1] * 1e8) / 1e8];
    const key = `${Math.round(canonical[0] * 1e8)},${Math.round(canonical[1] * 1e8)}|${level}`;
    const existing = keys.get(key);
    if (existing !== undefined) {
      if (endpoint) nodes[existing].endpoint = true;
      if (originalEndpoint) nodes[existing].originalEndpoint = true;
      return existing;
    }
    if (nodes.length >= MAX_NODES) { truncated = true; return -1; }
    const id = nodes.length;
    nodes.push({ point: canonical, grade: level, endpoint, originalEndpoint, links: [] }); keys.set(key, id);
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
    const rawFlags = feature.properties?.__mapsDirectionsEndpointFlags;
    const flags = typeof rawFlags === 'string' ? rawFlags.split('|') : [];
    const validFlags = flags.length === lines.length && flags.every(value => /^[01]{2}$/.test(value));
    for (const [lineIndex, line] of lines.entries()) {
      if (++inputLines > MAX_INPUT_LINES) { truncated = true; break featureLoop; }
      if (!Array.isArray(line) || line.length < 2) continue;
      // Invalid vertices split a feature; never bridge over corrupt coordinates.
      let previous = -1;
      for (let i = 0; i < line.length; i++) {
        if (++inputVertices > MAX_INPUT_VERTICES) { truncated = true; break featureLoop; }
        if (segments.length >= MAX_SEGMENTS) { truncated = true; break featureLoop; }
        if (!valid(line[i])) { previous = -1; continue; }
        const point = clean(line[i]);
        const endpoint = i === 0 || i === line.length - 1;
        const originalEndpoint = endpoint && (rawFlags === undefined || validFlags &&
          (i === 0 && flags[lineIndex][0] === '1' || i === line.length - 1 && flags[lineIndex][1] === '1'));
        const node = getNode(point, level, endpoint, originalEndpoint);
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

  // Drawing tiles can cross same-level road interiors without a shared vertex.
  // Split only at an exact intersection, with the same grade on both segments.
  // Inserted junctions never gain original endpoint provenance for level changes.
  let joinChecks = 0;
  for (const [left, right] of index.pairs()) {
    if (++joinChecks > MAX_JOIN_CHECKS) { truncated = true; break; }
    const first = segments[left], second = segments[right];
    if (first.grade !== second.grade || first.a === second.a || first.a === second.b || first.b === second.a || first.b === second.b) continue;
    const a = nodes[first.a].point, b = nodes[first.b].point;
    const c = nodes[second.a].point, d = nodes[second.b].point;
    const cosine = Math.cos(a[1] * RAD);
    const rx = deltaLongitude(a[0], b[0]) * cosine * RAD * EARTH, ry = (b[1] - a[1]) * RAD * EARTH;
    const cx = deltaLongitude(a[0], c[0]) * cosine * RAD * EARTH, cy = (c[1] - a[1]) * RAD * EARTH;
    const sx = deltaLongitude(c[0], d[0]) * cosine * RAD * EARTH, sy = (d[1] - c[1]) * RAD * EARTH;
    const determinant = rx * sy - ry * sx;
    if (Math.abs(determinant) <= Math.hypot(rx, ry) * Math.hypot(sx, sy) * 1e-12) continue;
    let t = (cx * sy - cy * sx) / determinant, u = (cx * ry - cy * rx) / determinant;
    if (t < -1e-10 || t > 1 + 1e-10 || u < -1e-10 || u > 1 + 1e-10) continue;
    t = Math.max(0, Math.min(1, t)); u = Math.max(0, Math.min(1, u));
    if (!(t > 1e-9 && t < 1 - 1e-9 || u > 1e-9 && u < 1 - 1e-9)) continue;
    const point: RoadCoordinate = [normalize(a[0] + deltaLongitude(a[0], b[0]) * t), a[1] + (b[1] - a[1]) * t];
    const node = getNode(point, first.grade, false);
    if (node < 0) break;
    if (!first.splits.some(split => split.node === node)) first.splits.push({ t, node });
    if (!second.splits.some(split => split.node === node)) second.splits.push({ t: u, node });
  }

  const stitches: [number, number][] = [];
  const endpoints = nodes.flatMap((node, id) => node.endpoint ? [id] : []);
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
        if (!node.originalEndpoint || target < 0 || !nodes[target].originalEndpoint || !transitionGrade(node.grade, segment.grade)) continue;
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
