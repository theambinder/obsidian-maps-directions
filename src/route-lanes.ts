import type { FeatureCollection } from './contracts';
import { normalizeLongitude } from './geometry';

type Point = [number, number];
type Feature = FeatureCollection['features'][number];
interface Segment {
  feature: number;
  index: number;
  identity: string;
  a: Point;
  b: Point;
  p: Point;
  q: Point;
  length: number;
  ux: number;
  uy: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  cuts: number[];
  overlaps: Array<{ start: number; end: number; other: Segment }>;
}

const RADIUS = 6378137;
const WORLD = 2 * Math.PI * RADIUS;
// Conservative tolerance: nearby parallel roads must not become a shared road.
const TOLERANCE_METERS = 0.1;
const MIN_OVERLAP_METERS = 0.05;
const MAX_DIRECTION_SINE = Math.sin(Math.PI / 180);
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function project(point: Point, referenceLongitude: number): Point {
  const longitude = referenceLongitude + normalizeLongitude(point[0] - referenceLongitude);
  const latitude = Math.max(-85.051129, Math.min(85.051129, point[1])) * Math.PI / 180;
  return [RADIUS * longitude * Math.PI / 180, RADIUS * Math.log(Math.tan(Math.PI / 4 + latitude / 2))];
}

function coordinate(segment: Segment, distance: number): Point {
  if (distance <= 0) return [...segment.a];
  if (distance >= segment.length) return [...segment.b];
  const fraction = distance / segment.length;
  const y = segment.p[1] + (segment.q[1] - segment.p[1]) * fraction;
  return [segment.a[0] + normalizeLongitude(segment.b[0] - segment.a[0]) * fraction,
    (2 * Math.atan(Math.exp(y / RADIUS)) - Math.PI / 2) * 180 / Math.PI];
}

function addOverlap(a: Segment, b: Segment, worldShift = 0): void {
  // Stored paths can round tile coordinates and insert short seam vertices.
  // Compare their position as well as direction: exact bearing equality loses
  // millimetre-close copies of the same road after a save or a new section pass.
  if (Math.abs(a.ux * b.uy - a.uy * b.ux) > MAX_DIRECTION_SINE) return;
  const dx = b.p[0] + worldShift - a.p[0], dy = b.p[1] - a.p[1];
  const ex = b.q[0] + worldShift - a.p[0], ey = b.q[1] - a.p[1];
  if (Math.abs(dx * a.uy - dy * a.ux) > TOLERANCE_METERS ||
      Math.abs(ex * a.uy - ey * a.ux) > TOLERANCE_METERS) return;
  const t0 = dx * a.ux + dy * a.uy, t1 = ex * a.ux + ey * a.uy;
  const endpointCut = (distance: number, length: number): number =>
    distance <= TOLERANCE_METERS ? 0 : length - distance <= TOLERANCE_METERS ? length : distance;
  const start = endpointCut(Math.max(0, Math.min(t0, t1)), a.length);
  const end = endpointCut(Math.min(a.length, Math.max(t0, t1)), a.length);
  if (end - start < MIN_OVERLAP_METERS) return;
  const direction = a.ux * b.ux + a.uy * b.uy;
  const first = endpointCut(Math.max(0, Math.min(b.length, (start - t0) / direction)), b.length);
  const last = endpointCut(Math.max(0, Math.min(b.length, (end - t0) / direction)), b.length);
  a.cuts.push(start, end);
  b.cuts.push(first, last);
  a.overlaps.push({ start, end, other: b });
  b.overlaps.push({ start: Math.min(first, last), end: Math.max(first, last), other: a });
}

interface Run { coordinates: Point[]; offset: number; length: number }
export interface RouteLaneDiagnostics { candidateChecks: number }
interface IndexedSegment {
  segment: Segment;
  id: number;
  entryId: number;
  shift: number;
  level: number;
  minX: number;
  maxX: number;
}

function findOverlaps(segments: Segment[], reference: number, diagnostics?: RouteLaneDiagnostics): void {
  if (diagnostics) diagnostics.candidateChecks = 0;
  if (!segments.length) return;
  const referenceX = reference * Math.PI / 180 * RADIUS;
  const left = referenceX - WORLD / 2, right = referenceX + WORLD / 2;
  const grids = new Map<number, Map<string, IndexedSegment[]>>();
  const entries: IndexedSegment[][] = [];
  let entryId = 0;
  const add = (segment: Segment, id: number, shift: number): void => {
    // A segment is at most two cells long at its own level. Even a long road
    // therefore occupies only a few cells rather than a huge dense rectangle.
    const level = Math.floor(Math.log2(Math.max(TOLERANCE_METERS * 4, segment.length)));
    const cell = 2 ** level;
    const entry: IndexedSegment = { segment, id, entryId: entryId++, shift, level,
      minX: segment.minX + shift, maxX: segment.maxX + shift };
    entries[id].push(entry);
    let grid = grids.get(level);
    if (!grid) grids.set(level, grid = new Map());
    for (let x = Math.floor(entry.minX / cell); x <= Math.floor(entry.maxX / cell); x++) {
      for (let y = Math.floor(segment.minY / cell); y <= Math.floor(segment.maxY / cell); y++) {
        const key = `${x},${y}`;
        const bucket = grid.get(key);
        if (bucket) bucket.push(entry);
        else grid.set(key, [entry]);
      }
    }
  };
  segments.forEach((segment, id) => {
    entries[id] = [];
    add(segment, id, 0);
    // A whole segment and its clipped piece can fall in different world copies
    // when their midpoints straddle the reference seam. Index only the seam
    // segments in the adjacent world too, keeping ordinary maps unchanged.
    if (segment.minX <= left + TOLERANCE_METERS) add(segment, id, WORLD);
    if (segment.maxX >= right - TOLERANCE_METERS) add(segment, id, -WORLD);
  });
  const levels = [...grids.keys()].sort((a, b) => a - b);
  entries.forEach(ownEntries => {
    const paired = new Set<number>();
    for (const entry of ownEntries) {
      const visited = new Set<number>();
      for (const level of levels) {
        // The shorter segment discovers a pair; equal levels use stable IDs.
        if (level < entry.level) continue;
        const grid = grids.get(level)!;
        const cell = 2 ** level;
        for (let x = Math.floor((entry.minX - TOLERANCE_METERS) / cell); x <= Math.floor((entry.maxX + TOLERANCE_METERS) / cell); x++) {
          for (let y = Math.floor((entry.segment.minY - TOLERANCE_METERS) / cell); y <= Math.floor((entry.segment.maxY + TOLERANCE_METERS) / cell); y++) {
            const bucket = grid.get(`${x},${y}`);
            if (!bucket) continue;
            for (const other of bucket) {
              if (other.id === entry.id || (level === entry.level && other.id < entry.id) || paired.has(other.id) || visited.has(other.entryId)) continue;
              visited.add(other.entryId);
              if (diagnostics) diagnostics.candidateChecks++;
              if (other.maxX + TOLERANCE_METERS < entry.minX || entry.maxX + TOLERANCE_METERS < other.minX ||
                  other.segment.maxY + TOLERANCE_METERS < entry.segment.minY || entry.segment.maxY + TOLERANCE_METERS < other.segment.minY) continue;
              paired.add(other.id);
              addOverlap(entry.segment, other.segment, other.shift - entry.shift);
            }
          }
        }
      }
    }
  });
}

/** Render-only screen-pixel lanes. Saved road geometry and Maps pins stay exact. */
export function separateRoadLanes(data: FeatureCollection, lineWidth: number, arrowSize: number, diagnostics?: RouteLaneDiagnostics): FeatureCollection {
  const first = data.features.find(feature => feature.properties.connectionKind === 'road')?.geometry.coordinates[0];
  const reference = first?.[0] ?? 0;
  const segments: Segment[] = [];
  const byFeature = new Map<number, Segment[]>();
  data.features.forEach((feature, featureIndex) => {
    if (feature.properties.connectionKind !== 'road') return;
    const identity = JSON.stringify([feature.properties.route ?? '', feature.properties.from ?? '', feature.properties.to ?? '',
      feature.properties.fromSequence ?? '', feature.properties.toSequence ?? '', feature.geometry.coordinates]);
    const own: Segment[] = [];
    for (let index = 1; index < feature.geometry.coordinates.length; index++) {
      const a = feature.geometry.coordinates[index - 1], b = feature.geometry.coordinates[index];
      const p = project(a, reference), q = project(b, reference);
      // Keep a date-line crossing short, including the uncommon reference seam.
      q[0] += Math.round((p[0] - q[0]) / WORLD) * WORLD;
      const shift = Math.floor(((p[0] + q[0]) / 2 - reference * Math.PI / 180 * RADIUS + WORLD / 2) / WORLD) * WORLD;
      p[0] -= shift;
      q[0] -= shift;
      const dx = q[0] - p[0], dy = q[1] - p[1], length = Math.hypot(dx, dy);
      if (!Number.isFinite(length) || length < 1e-6) continue;
      const segment: Segment = { feature: featureIndex, index, identity, a, b, p, q, length, ux: dx / length, uy: dy / length,
        minX: Math.min(p[0], q[0]), maxX: Math.max(p[0], q[0]), minY: Math.min(p[1], q[1]), maxY: Math.max(p[1], q[1]),
        cuts: [0, length], overlaps: [] };
      own.push(segment);
      segments.push(segment);
    }
    byFeature.set(featureIndex, own);
  });

  findOverlaps(segments, reference, diagnostics);

  const spacing = Math.max(3.5, lineWidth + 1.5);
  const size = Math.max(0.01, arrowSize);
  const features: Feature[] = [];
  data.features.forEach((feature, featureIndex) => {
    const own = byFeature.get(featureIndex);
    if (!own || !own.some(segment => segment.overlaps.length)) {
      features.push({ ...feature, properties: { ...feature.properties, lineOffset: 0, iconOffset: [0, 0],
        laneArrow: feature.properties.connectionKind === 'connector' ? 0 : 1 } });
      return;
    }
    const runs: Run[] = [];
    for (const segment of own) {
      const cuts = segment.cuts.sort((a, b) => a - b).filter((cut, index, sorted) => !index || cut - sorted[index - 1] >= 1e-6);
      for (let part = 1; part < cuts.length; part++) {
        const start = cuts[part - 1], end = cuts[part];
        if (end - start < 1e-6) continue;
        const midpoint = (start + end) / 2;
        const sharing = [segment, ...segment.overlaps.filter(overlap => midpoint >= overlap.start && midpoint <= overlap.end).map(overlap => overlap.other)];
        sharing.sort((a, b) => compare(a.identity, b.identity) || a.feature - b.feature || a.index - b.index);
        const lane = sharing.indexOf(segment) - (sharing.length - 1) / 2;
        // Follow the first stable traversal around bends. A compass-based sign
        // would make the lanes swap sides whenever a road turns east or west.
        const leader = sharing[0];
        const direction = segment.ux * leader.ux + segment.uy * leader.uy >= 0 ? 1 : -1;
        const offset = lane * spacing * direction;
        const a = coordinate(segment, start), b = coordinate(segment, end);
        const last = runs[runs.length - 1];
        if (last && last.offset === offset && Math.abs(last.coordinates.at(-1)![0] - a[0]) < 1e-8 && Math.abs(last.coordinates.at(-1)![1] - a[1]) < 1e-8) {
          last.coordinates.push(b);
          last.length += end - start;
        } else runs.push({ coordinates: [a, b], offset, length: end - start });
      }
    }
    // Preserve one direction arrow per connection rather than one per tiny road edge.
    let arrow = 0;
    runs.forEach((run, index) => { if (run.length > runs[arrow].length) arrow = index; });
    runs.forEach((run, index) => features.push({ ...feature,
      properties: { ...feature.properties, lineOffset: run.offset, iconOffset: [0, run.offset / size], laneArrow: index === arrow ? 1 : 0 },
      geometry: { type: 'LineString', coordinates: run.coordinates } }));
  });
  return { type: 'FeatureCollection', features };
}
