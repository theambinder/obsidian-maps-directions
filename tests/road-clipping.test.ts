import assert from 'node:assert/strict';
import test from 'node:test';
import { clipRoadFeature, type RoadClipBounds } from '../src/road-clipping';
import { buildRoadGraph, type RoadCoordinate, type RoadFeature } from '../src/road-graph';

const bounds: RoadClipBounds = { west: -1, south: -1, east: 1, north: 1 };
const line = (coordinates: unknown[], properties: Record<string, unknown> = { class: 'minor' }): RoadFeature => ({ geometry: { type: 'LineString', coordinates }, properties });

test('clipping keeps an inside road and its level metadata without changing the source', () => {
  const original = line([[0, 0], [0.5, 0.25]], { class: 'path', brunnel: 'bridge', layer: 1, level: 2, foot: 'yes' });
  const saved = structuredClone(original);
  const clipped = clipRoadFeature(original, bounds)!;
  assert.deepEqual(clipped, { ...original, properties: { ...original.properties, __mapsDirectionsEndpointFlags: '11' } });
  assert.notEqual(clipped.geometry, original.geometry);
  assert.deepEqual(original, saved);
});

test('clipping rejects outside roads and point-only corner touches while retaining boundary roads', () => {
  assert.equal(clipRoadFeature(line([[-2, 2], [2, 2]]), bounds), null);
  assert.equal(clipRoadFeature(line([[-2, 0], [0, 2]]), bounds), null);
  assert.deepEqual(clipRoadFeature(line([[-2, 1], [2, 1]]), bounds)?.geometry, {
    type: 'LineString', coordinates: [[-1, 1], [1, 1]],
  });
});

test('a road crossing the window is clipped exactly at its entry and exit', () => {
  assert.deepEqual(clipRoadFeature(line([[-2, 0], [2, 0]]), bounds), {
    properties: { class: 'minor', __mapsDirectionsEndpointFlags: '00' },
    geometry: { type: 'LineString', coordinates: [[-1, 0], [1, 0]] },
  });
  assert.deepEqual(clipRoadFeature(line([[0, -2], [0, 2]]), bounds)?.geometry, {
    type: 'LineString', coordinates: [[0, -1], [0, 1]],
  });
});

test('leaving and reentering a window produces separate pieces without a straight shortcut outside it', () => {
  const clipped = clipRoadFeature(line([[-2, 0], [0, 0], [2, 0], [0, 0.5], [-2, 0.5]]), bounds);
  assert.deepEqual(clipped?.geometry, { type: 'MultiLineString', coordinates: [
    [[-1, 0], [0, 0], [1, 0]],
    [[1, 0.25], [0, 0.5], [-1, 0.5]],
  ] });
  assert.equal(clipped?.properties?.__mapsDirectionsEndpointFlags, '00|00');
});

test('multiline clipping discards outside pieces and never joins separate source lines', () => {
  const original: RoadFeature = { properties: { class: 'path', access: 'yes' }, geometry: { type: 'MultiLineString', coordinates: [
    [[-2, 0], [2, 0]], [[-2, 3], [2, 3]], [[0, -2], [0, 2]],
  ] } };
  assert.deepEqual(clipRoadFeature(original, bounds), { properties: { ...original.properties, __mapsDirectionsEndpointFlags: '00|00' }, geometry: { type: 'MultiLineString', coordinates: [
    [[-1, 0], [1, 0]], [[0, -1], [0, 1]],
  ] } });
});

test('corrupt vertices split a road instead of connecting valid points across missing geometry', () => {
  const clipped = clipRoadFeature(line([[-0.5, 0], [0, 0], [NaN, 0], [0, 0.5], [0.5, 0.5]]), bounds);
  assert.deepEqual(clipped?.geometry, {
    type: 'MultiLineString', coordinates: [[[-0.5, 0], [0, 0]], [[0, 0.5], [0.5, 0.5]]],
  });
  assert.equal(clipped?.properties?.__mapsDirectionsEndpointFlags, '10|01');
  assert.equal(clipRoadFeature(line([[-0.5, 0], ['invalid', 0], [0.5, 0]]), bounds), null);
  assert.equal(clipRoadFeature(line([[-0.5, 0], [0, 91], [0.5, 0]]), bounds), null);
  assert.equal(clipRoadFeature({ geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] } }, bounds), null);
});

test('each reentry piece retains only its genuine original endpoint provenance', () => {
  const clipped = clipRoadFeature(line([[0, 0], [2, 0], [2, 0.5], [0, 0.5]]), bounds)!;
  assert.deepEqual(clipped.geometry, { type: 'MultiLineString', coordinates: [
    [[0, 0], [1, 0]], [[1, 0.5], [0, 0.5]],
  ] });
  assert.equal(clipped.properties?.__mapsDirectionsEndpointFlags, '10|01');
  const repeated = clipRoadFeature(clipped, bounds)!;
  assert.equal(repeated.properties?.__mapsDirectionsEndpointFlags, '10|01');
  const remaining = clipRoadFeature(repeated, { ...bounds, south: 0.25 })!;
  assert.equal(remaining.geometry?.type, 'LineString');
  assert.equal(remaining.properties?.__mapsDirectionsEndpointFlags, '01');
});

test('repeated clipping cannot turn a cut point into an original road endpoint', () => {
  const crossing = clipRoadFeature(line([[-2, 0], [2, 0]]), bounds)!;
  for (const clip of [bounds, { west: -3, south: -3, east: 3, north: 3 }, { ...bounds, west: 0 }]) {
    const repeated = clipRoadFeature(crossing, clip)!;
    assert.equal(repeated.properties?.__mapsDirectionsEndpointFlags, '00');
  }
  const oneOriginalEnd = clipRoadFeature(line([[-0.5, 0], [0.5, 0]]), { ...bounds, west: 0 })!;
  assert.equal(oneOriginalEnd.properties?.__mapsDirectionsEndpointFlags, '01');
  assert.equal(clipRoadFeature(oneOriginalEnd, bounds)?.properties?.__mapsDirectionsEndpointFlags, '01');
  const bothCut = clipRoadFeature(oneOriginalEnd, { ...bounds, east: 0.25 })!;
  assert.equal(bothCut.properties?.__mapsDirectionsEndpointFlags, '00');
  assert.equal(clipRoadFeature(bothCut, bounds)?.properties?.__mapsDirectionsEndpointFlags, '00');
});

test('malformed inherited endpoint flags never grant original endpoint status', () => {
  for (const flags of [null, true, 11, '', '1', '111', '1x', 'true', '11|11']) {
    const original = line([[0, 0], [0.5, 0]], { class: 'minor', __mapsDirectionsEndpointFlags: flags });
    const clipped = clipRoadFeature(original, bounds)!;
    assert.equal(clipped.properties?.__mapsDirectionsEndpointFlags, '00');
    assert.equal(clipRoadFeature(clipped, bounds)?.properties?.__mapsDirectionsEndpointFlags, '00');
  }
  const malformedMulti: RoadFeature = { properties: { class: 'minor', __mapsDirectionsEndpointFlags: '11' }, geometry: {
    type: 'MultiLineString', coordinates: [[[0, 0], [0.5, 0]], [[0, 0.5], [0.5, 0.5]]],
  } };
  assert.equal(clipRoadFeature(malformedMulti, bounds)?.properties?.__mapsDirectionsEndpointFlags, '00|00');
});

test('date-line clipping follows the short road across wrapped and unwrapped window bounds', () => {
  const original = line([[179, 0], [-179, 0]]);
  for (const clip of [
    { west: 179.5, south: -1, east: -179.5, north: 1 },
    { west: 179.5, south: -1, east: 180.5, north: 1 },
  ]) {
    assert.deepEqual(clipRoadFeature(original, clip)?.geometry, { type: 'LineString', coordinates: [[179.5, 0], [180.5, 0]] });
  }
  assert.deepEqual(clipRoadFeature(line([[-179, 0], [179, 0]]), { west: 179.5, south: -1, east: -179.5, north: 1 })?.geometry, {
    type: 'LineString', coordinates: [[180.5, 0], [179.5, 0]],
  });
  assert.deepEqual(clipRoadFeature(original, { west: -180.5, south: -1, east: -179.5, north: 1 })?.geometry, {
    type: 'LineString', coordinates: [[-180.5, 0], [-179.5, 0]],
  });
  assert.deepEqual(original.geometry?.coordinates, [[179, 0], [-179, 0]]);
});

test('clipping preserves a discovered road bearing and grade for an exact internal seam', () => {
  const original = line([[-0.002, -0.001], [0.002, 0.001]], { class: 'minor', brunnel: 'bridge', layer: 1, level: 2 });
  const gate = { from: [-0.002, -0.001] as RoadCoordinate, to: [0.002, 0.001] as RoadCoordinate, center: [0, 0] as RoadCoordinate, halfWidthMeters: 50 };
  const anchor = buildRoadGraph([original]).portals(gate)[0];
  assert.ok(anchor);
  assert.equal(anchor.grade, 'bridge|1|2');
  const clipped = clipRoadFeature(original, { west: 0, south: -0.002, east: 0.002, north: 0.002 })!;
  const graph = buildRoadGraph([clipped]);
  const nextAnchor = graph.portals(gate)[0];
  assert.ok(nextAnchor);
  assert.equal(nextAnchor.grade, anchor.grade);
  assert.ok(Math.abs(nextAnchor.bearing! - anchor.bearing!) < 0.000001);
  const route = graph.route(anchor.point, [0.002, 0.001], 100, { from: anchor });
  assert.ok(route);
  assert.ok(route.coordinates.length >= 2);
});

test('invalid clip windows do not produce geometry', () => {
  const original = line([[0, 0], [0.5, 0.5]]);
  assert.equal(clipRoadFeature(original, { ...bounds, west: NaN }), null);
  assert.equal(clipRoadFeature(original, { ...bounds, north: Infinity }), null);
  assert.equal(clipRoadFeature(original, { ...bounds, south: 2 }), null);
  assert.equal(clipRoadFeature(original, { ...bounds, east: 361 }), null);
});
