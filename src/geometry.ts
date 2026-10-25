import type { FeatureCollection, MapsMarker } from './contracts';

interface RoutePoint {
  path: string;
  sequence: number;
  coordinates: [number, number];
  index: number;
}

/** Normalize a longitude without changing the distance to the next point. */
export function normalizeLongitude(longitude: number): number {
  return ((longitude + 180) % 360 + 360) % 360 - 180;
}

/** MapLibre accepts unwrapped longitudes, so a date-line crossing stays short. */
export function shortestSegment(from: [number, number], to: [number, number]): [number, number][] | null {
  const start = normalizeLongitude(from[1]);
  const difference = to[1] - from[1];
  let delta = normalizeLongitude(difference);
  if (delta === -180 && difference > 0) delta = 180;
  if (from[0] === to[0] && delta === 0) return null;
  return [[start, from[0]], [start + delta, to[0]]];
}

function readSequence(marker: MapsMarker, property: string): number | null {
  const value = marker.entry.getValue(property);
  if (value === null || value === undefined) return null;
  const text = value.toString().trim();
  if (!text) return null;
  const sequence = Number(text);
  return Number.isFinite(sequence) ? sequence : null;
}

/** Build only from markers already accepted by official Maps. */
export function buildDirections(markers: readonly MapsMarker[], sequenceProperty: string, groupProperty: string | null): FeatureCollection {
  const groups = new Map<string, RoutePoint[]>();
  markers.forEach((marker, index) => {
    const [latitude, longitude] = marker.coordinates;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90) return;
    const sequence = readSequence(marker, sequenceProperty);
    if (sequence === null) return;
    const group = groupProperty ? marker.entry.getValue(groupProperty)?.toString() ?? '' : '';
    const point: RoutePoint = { path: marker.entry.file.path, sequence, coordinates: marker.coordinates, index };
    const points = groups.get(group);
    if (points) points.push(point);
    else groups.set(group, [point]);
  });

  const features: FeatureCollection['features'] = [];
  for (const [group, points] of [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    points.sort((a, b) => a.sequence - b.sequence || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.index - b.index));
    for (let index = 1; index < points.length; index++) {
      const from = points[index - 1];
      const to = points[index];
      const coordinates = shortestSegment(from.coordinates, to.coordinates);
      if (!coordinates) continue;
      features.push({
        type: 'Feature',
        properties: { route: group, from: from.path, to: to.path, fromSequence: from.sequence, toSequence: to.sequence },
        geometry: { type: 'LineString', coordinates },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}
