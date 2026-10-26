import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRoadGraph, roadDistance, type RoadFeature, type RoadCoordinate } from '../src/road-graph';

const feature = (coordinates: RoadCoordinate[], properties: Record<string, unknown> = {}): RoadFeature => ({
  geometry: { type: 'LineString', coordinates }, properties: { class: 'minor', ...properties },
});
const close = (actual: number, expected: number, tolerance = 0.02): void => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const contains = (coordinates: RoadCoordinate[], point: RoadCoordinate): boolean => coordinates.some(p => roadDistance(p, point) < 0.1);

test('follows road bends instead of joining marker endpoints directly', () => {
  const graph = buildRoadGraph([feature([[0, 0], [0.002, 0], [0.002, 0.002]])]);
  const route = graph.route([0, 0], [0.002, 0.002]);
  assert.ok(route);
  assert.ok(contains(route.coordinates, [0.002, 0]));
  close(route.distance, roadDistance([0, 0], [0.002, 0]) + roadDistance([0.002, 0], [0.002, 0.002]));
  assert.ok(route.distance > roadDistance([0, 0], [0.002, 0.002]) * 1.3);
});

test('finds the shortest weighted alternative and preserves road geometry', () => {
  const graph = buildRoadGraph([
    feature([[0, 0], [0, 0.004], [0.004, 0.004], [0.004, 0]]),
    feature([[0, 0], [0.002, 0.001], [0.004, 0]]),
  ]);
  const route = graph.route([0, 0], [0.004, 0]);
  assert.ok(route);
  assert.ok(contains(route.coordinates, [0.002, 0.001]));
  assert.ok(!contains(route.coordinates, [0, 0.004]));
});

test('snaps onto the segment interior and routes only the required subsegment', () => {
  const graph = buildRoadGraph([feature([[0, 0], [0.01, 0]])]);
  const route = graph.route([0.003, 0.0001], [0.007, -0.0001]);
  assert.ok(route);
  close(route.coordinates[0][0], 0.003, 1e-8);
  close(route.coordinates[0][1], 0, 1e-8);
  close(route.coordinates.at(-1)![0], 0.007, 1e-8);
  close(route.distance, roadDistance([0.003, 0], [0.007, 0]));
  assert.equal(graph.route([0.003, 0.002], [0.007, 0]), null);
});

test('returns null for disconnected roads without inventing a direct fallback', () => {
  const graph = buildRoadGraph([feature([[0, 0], [0.002, 0]]), feature([[0.01, 0], [0.012, 0]])]);
  assert.equal(graph.route([0, 0], [0.012, 0]), null);
});

test('joins a same-level T junction at a segment interior', () => {
  const graph = buildRoadGraph([
    feature([[0, 0], [0.004, 0]]), feature([[0.002, 0], [0.002, 0.002]]),
  ]);
  const route = graph.route([0, 0], [0.002, 0.002]);
  assert.ok(route);
  assert.ok(contains(route.coordinates, [0.002, 0]));
});

test('does not join ground and bridge at a geometric crossing, including a T endpoint', () => {
  const graph = buildRoadGraph([
    feature([[0, 0], [0.002, 0], [0.004, 0]], { brunnel: 'bridge', layer: 1 }),
    feature([[0.002, -0.002], [0.002, 0], [0.002, 0.002]]),
    feature([[0.002, 0], [0.001, -0.001]]),
  ]);
  assert.equal(graph.route([0, 0], [0.002, 0.002]), null);
  assert.equal(graph.route([0, 0], [0.001, -0.001]), null);
});

test('connects a bridge to aligned surface road endpoints', () => {
  const graph = buildRoadGraph([
    feature([[0, 0], [0.002, 0]]),
    feature([[0.002, 0], [0.004, 0]], { brunnel: 'bridge', layer: 1 }),
    feature([[0.004, 0], [0.006, 0]]),
  ]);
  const route = graph.route([0, 0], [0.006, 0]);
  assert.ok(route);
  close(route.distance, roadDistance([0, 0], [0.006, 0]));
});

test('different ground layers do not form a junction', () => {
  const graph = buildRoadGraph([
    feature([[0, 0], [0.002, 0], [0.004, 0]], { layer: 1 }),
    feature([[0.002, -0.002], [0.002, 0], [0.002, 0.002]], { layer: 0 }),
  ]);
  assert.equal(graph.route([0, 0], [0.002, 0.002]), null);
});

test('stitches duplicated, reversed and nearly coincident tile cuts', () => {
  const graph = buildRoadGraph([
    feature([[0, 0], [0.002, 0]]), feature([[0.002, 0], [0, 0]]),
    feature([[0.002002, 0], [0.004, 0]]),
  ]);
  const route = graph.route([0, 0], [0.004, 0]);
  assert.ok(route);
  close(route.distance, roadDistance([0, 0], [0.004, 0]));
  assert.ok(graph.stats.edges < 6);
});

test('accepts MultiLineString roads and excludes non-roads and denied access', () => {
  for (const properties of [{ class: 'rail' }, { class: 'ferry' }, { class: 'aerialway' },
    { class: 'minor_construction' }, { access: 'private' }, { access: 'no' }, { foot: 'no' }, { class: 'motorway' }]) {
    const graph = buildRoadGraph([feature([[0, 0], [0.004, 0]], properties)]);
    assert.equal(graph.stats.edges, 0);
    assert.equal(graph.route([0, 0], [0.004, 0]), null);
  }
  const graph = buildRoadGraph([{ geometry: { type: 'MultiLineString', coordinates: [
    [[0, 0], [0.002, 0]], [[0.002, 0], [0.004, 0]],
  ] }, properties: { class: 'path' } }]);
  assert.ok(graph.route([0, 0], [0.004, 0]));
});

test('invalid points split rather than bridge corrupted geometry', () => {
  const graph = buildRoadGraph([feature([[0, 0], [0.002, 0], [NaN, 0], [0.01, 0], [0.012, 0]])]);
  assert.equal(graph.route([0, 0], [0.012, 0]), null);
  assert.equal(graph.route([Infinity, 0], [0, 0]), null);
  assert.equal(graph.route([0, 89], [0, 0]), null);
  assert.equal(graph.route([0, 0], [0, 0], Infinity), null);
});

test('antimeridian roads remain local and output short unwrapped geometry', () => {
  const graph = buildRoadGraph([feature([[179.99, 0], [-179.99, 0]])]);
  const route = graph.route([179.995, 0], [-179.995, 0]);
  assert.ok(route);
  close(route.distance, roadDistance([179.995, 0], [-179.995, 0]));
  assert.ok(Math.abs(route.coordinates[0][0] - route.coordinates.at(-1)![0]) < 0.02);
});

test('overlapping buffered tile pieces remain connected without duplicating their path length', () => {
  const graph = buildRoadGraph([
    feature([[0, 0], [0.003, 0]]), feature([[0.002, 0], [0.005, 0]]),
  ]);
  const route = graph.route([0.0005, 0], [0.0045, 0]);
  assert.ok(route);
  close(route.distance, roadDistance([0.0005, 0], [0.0045, 0]));
});

test('bounds even degenerate input without creating a giant graph', () => {
  const graph = buildRoadGraph([feature(Array.from({ length: 250002 }, () => [0, 0]))]);
  assert.equal(graph.stats.truncated, true);
  assert.equal(graph.stats.nodes, 1);
  assert.equal(graph.stats.edges, 0);
  assert.equal(graph.route([0, 0], [0.001, 0]), null);
});

test('nearby bridge tile endpoints stitch to aligned ground endpoints', () => {
  const graph = buildRoadGraph([
    feature([[0, 0], [0.002, 0]]),
    feature([[0.002002, 0], [0.004, 0]], { brunnel: 'bridge', layer: 1 }),
  ]);
  const route = graph.route([0, 0], [0.004, 0]);
  assert.ok(route);
  close(route.distance, roadDistance([0, 0], [0.004, 0]));
});

test('dense local fragments do not starve stitching for roads later in the input', () => {
  // Rendering tiles include many small sidewalk/indoor fragments. A coarse index
  // used to spend the entire junction budget scanning unrelated nearby lines.
  const degreesPerMeter = 180 / (Math.PI * 6371008.8);
  const point = (x: number, y: number): RoadCoordinate => [x * degreesPerMeter, y * degreesPerMeter];
  const features: RoadFeature[] = [];
  for (let row = 0; row < 20; row++) for (let col = 0; col < 30; col++) {
    const x = 20 + col * 6, y = 20 + row * 8;
    features.push(feature([point(x, y), point(x + 0.5, y)]));
  }
  features.push(feature([point(210, 220), point(230, 220)]));
  features.push(feature([point(220, 220), point(220, 230)]));
  const graph = buildRoadGraph(features);
  assert.equal(graph.stats.truncated, false);
  const route = graph.route(point(210, 220), point(220, 230));
  assert.ok(route);
  close(route.distance, 20, 0.02);
});
