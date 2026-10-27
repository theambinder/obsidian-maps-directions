import type { RoadFeature } from './road-graph';

export interface RoadClipBounds { west: number; south: number; east: number; north: number }
type Point = [number, number];
const valid = (point: unknown): point is Point => Array.isArray(point) && point.length >= 2 &&
  typeof point[0] === 'number' && Number.isFinite(point[0]) && typeof point[1] === 'number' &&
  Number.isFinite(point[1]) && Math.abs(point[1]) <= 85.051129;
const near = (a: Point, b: Point): boolean => Math.abs(a[0] - b[0]) < 1e-10 && Math.abs(a[1] - b[1]) < 1e-10;

/** Clip before collection budgets: querySourceFeatures also returns roads outside the viewport. */
export function clipRoadFeature(feature: RoadFeature, bounds: RoadClipBounds): RoadFeature | null {
  if (![bounds.west, bounds.east, bounds.south, bounds.north].every(Number.isFinite) || bounds.south > bounds.north) return null;
  const west = bounds.west, east = bounds.east < west ? bounds.east + 360 : bounds.east;
  if (east - west > 360) return null;
  const middle = (west + east) / 2;
  const unwrap = (longitude: number): number => longitude + Math.round((middle - longitude) / 360) * 360;
  const geometry = feature.geometry;
  if (!geometry || !Array.isArray(geometry.coordinates)) return null;
  const lines: unknown[] = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.type === 'MultiLineString' ? geometry.coordinates : [];
  const pieces: Point[][] = [];
  const endpointFlags: Array<[boolean, boolean]> = [];
  const inherited = feature.properties?.__mapsDirectionsEndpointFlags;
  const inheritedFlags = typeof inherited === 'string' ? inherited.split('|') : [];
  for (const [lineIndex, line] of lines.entries()) {
    if (!Array.isArray(line)) continue;
    let piece: Point[] | null = null;
    let flags: [boolean, boolean] | null = null;
    const originalFlags = inherited === undefined ? '11' : inheritedFlags.length === lines.length && /^[01]{2}$/.test(inheritedFlags[lineIndex]) ? inheritedFlags[lineIndex] : '00';
    for (let index = 1; index < line.length; index++) {
      const rawA = line[index - 1], rawB = line[index];
      if (!valid(rawA) || !valid(rawB)) { piece = null; flags = null; continue; }
      const a: Point = [unwrap(rawA[0]), rawA[1]], b: Point = [unwrap(rawB[0]), rawB[1]];
      b[0] = a[0] + ((b[0] - a[0] + 540) % 360) - 180;
      const dx = b[0] - a[0], dy = b[1] - a[1];
      let low = 0, high = 1, outside = false;
      const edges = [[-dx, a[0] - west], [dx, east - a[0]], [-dy, a[1] - bounds.south], [dy, bounds.north - a[1]]];
      for (const [p, q] of edges) {
        if (p === 0) { if (q < 0) { outside = true; break; } }
        else {
          const ratio = q / p;
          if (p < 0) low = Math.max(low, ratio); else high = Math.min(high, ratio);
          if (low > high) { outside = true; break; }
        }
      }
      if (outside || high - low < 1e-12) { piece = null; flags = null; continue; }
      const from: Point = [a[0] + low * dx, a[1] + low * dy], to: Point = [a[0] + high * dx, a[1] + high * dy];
      const originalStart = index === 1 && low <= 1e-12 && originalFlags[0] === '1';
      const originalEnd = index === line.length - 1 && high >= 1 - 1e-12 && originalFlags[1] === '1';
      if (piece && flags && near(piece[piece.length - 1], from)) { piece.push(to); flags[1] = originalEnd; }
      else { piece = [from, to]; flags = [originalStart, originalEnd]; pieces.push(piece); endpointFlags.push(flags); }
      if (high < 1) { piece = null; flags = null; }
    }
  }
  if (!pieces.length) return null;
  return { properties: { ...feature.properties, __mapsDirectionsEndpointFlags: endpointFlags.map(flags => flags.map(flag => flag ? '1' : '0').join('')).join('|') },
    geometry: { type: pieces.length === 1 ? 'LineString' : 'MultiLineString', coordinates: pieces.length === 1 ? pieces[0] : pieces } };
}
