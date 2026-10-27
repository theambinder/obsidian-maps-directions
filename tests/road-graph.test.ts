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

const metricPoint = (x: number, y: number): RoadCoordinate => {
  const degreesPerMeter = 180 / (Math.PI * 6371008.8);
  return [x * degreesPerMeter, y * degreesPerMeter];
};
const metricRoad = (points: Array<[number, number]>, properties: Record<string, unknown> = {}): RoadFeature =>
  feature(points.map(([x, y]) => metricPoint(x, y)), properties);

test('recovers a route on a nearby street when the closest fragment is disconnected', () => {
  const graph = buildRoadGraph([
    metricRoad([[0, 0], [20, 0]]),
    metricRoad([[0, 25], [500, 25]]),
  ]);
  const route = graph.route(metricPoint(0, 0), metricPoint(500, 25));
  assert.ok(route);
  assert.ok(contains(route.coordinates, metricPoint(0, 25)));
  assert.ok(contains(route.coordinates, metricPoint(500, 25)));
  assert.ok(!contains(route.coordinates, metricPoint(20, 0)));
  // Access is drawn separately by the overlay and must not inflate road length.
  close(route.distance, 500, 0.02);
});

test('many closer isolated fragments cannot crowd out the one nearby connected street', () => {
  const features: RoadFeature[] = [];
  for (let i = 0; i < 25; i++) {
    features.push(metricRoad([[0, i * 2], [5, i * 2]]));
    features.push(metricRoad([[500, i * 2], [505, i * 2]]));
  }
  features.push(metricRoad([[0, 80], [500, 80]]));
  const graph = buildRoadGraph(features);
  const route = graph.route(metricPoint(0, 0), metricPoint(500, 0));
  assert.ok(route);
  assert.ok(contains(route.coordinates, metricPoint(0, 80)));
  assert.ok(contains(route.coordinates, metricPoint(500, 80)));
  close(route.distance, 500, 0.02);
});

test('keeps an existing nearest-road route instead of taking a distant access shortcut', () => {
  const graph = buildRoadGraph([
    metricRoad([[0, 0], [0, -500], [500, -500], [500, 0]]),
    metricRoad([[0, 30], [500, 30]]),
  ]);
  const route = graph.route(metricPoint(0, 0), metricPoint(500, 0));
  assert.ok(route);
  assert.ok(contains(route.coordinates, metricPoint(0, -500)));
  assert.ok(!contains(route.coordinates, metricPoint(0, 30)));
  close(route.distance, 1500, 0.02);
});

test('alternative snapping never bridges a missing internal section of road', () => {
  const graph = buildRoadGraph([
    metricRoad([[0, 0], [250, 0]]),
    metricRoad([[270, 0], [600, 0]]),
  ]);
  assert.equal(graph.route(metricPoint(0, 0), metricPoint(600, 0)), null);
});

test('alternative snapping respects the selected radius and the hard 100 metre limit', () => {
  const nearby = buildRoadGraph([
    metricRoad([[0, 0], [20, 0]]),
    metricRoad([[0, 80], [500, 80]]),
  ]);
  assert.equal(nearby.route(metricPoint(0, 0), metricPoint(500, 80), 50), null);
  assert.ok(nearby.route(metricPoint(0, 0), metricPoint(500, 80), 100));
  const outside = buildRoadGraph([
    metricRoad([[0, 0], [20, 0]]),
    metricRoad([[0, 101], [500, 101]]),
  ]);
  assert.equal(outside.route(metricPoint(0, 0), metricPoint(500, 101), 1000), null);
});

test('nearby alternatives still exclude roads without walking access', () => {
  for (const properties of [{ class: 'motorway' }, { access: 'private' }, { foot: 'no' }]) {
    const graph = buildRoadGraph([
      metricRoad([[0, 0], [20, 0]]),
      metricRoad([[0, 25], [500, 25]], properties),
    ]);
    assert.equal(graph.route(metricPoint(0, 0), metricPoint(500, 25)), null);
  }
});

test('selects the shortest access plus road path among nearby connected alternatives', () => {
  const graph = buildRoadGraph([
    metricRoad([[0, 0], [20, 0]]),
    metricRoad([[500, 0], [520, 0]]),
    metricRoad([[0, 20], [0, 300], [500, 300], [500, 20]]),
    metricRoad([[0, -30], [500, -30]]),
  ]);
  const from = metricPoint(0, 0), to = metricPoint(500, 0);
  const route = graph.route(from, to);
  assert.ok(route);
  assert.ok(contains(route.coordinates, metricPoint(0, -30)));
  assert.ok(!contains(route.coordinates, metricPoint(0, 300)));
  close(route.distance, 500, 0.02);
  assert.deepEqual(graph.route(from, to), route);
});
