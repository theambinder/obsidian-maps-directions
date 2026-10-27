import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRoadGraph, roadDistance, type RoadFeature, type RoadCoordinate, type RoadGate, type RoadAnchor } from '../src/road-graph';
import { clipRoadFeature } from '../src/road-clipping';

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

test('alternative snapping preserves the 100 metre default and honors explicit radii up to 1000 metres', () => {
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
  assert.equal(outside.route(metricPoint(0, 0), metricPoint(500, 101)), null);
  assert.ok(outside.route(metricPoint(0, 0), metricPoint(500, 101), 250));
  const beyondMaximum = buildRoadGraph([metricRoad([[0, 1001], [500, 1001]])]);
  assert.equal(beyondMaximum.route(metricPoint(0, 0), metricPoint(500, 1001), 100000), null);
  const nearMaximum = buildRoadGraph([metricRoad([[0, 999], [500, 999]])]);
  assert.ok(nearMaximum.route(metricPoint(0, 0), metricPoint(500, 999), 1000));
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

const metricGate = (halfWidthMeters: number, maxPortals?: number): RoadGate => ({
  from: metricPoint(-100, 0), to: metricPoint(100, 0), center: metricPoint(0, 0), halfWidthMeters, maxPortals,
});

test('portals are real allowed road intersections inside the gate, including its width boundary and distinct levels', () => {
  const graph = buildRoadGraph([
    metricRoad([[-100, 0], [100, 0]]),
    metricRoad([[-100, 40], [100, 40]], { brunnel: 'bridge', layer: 1 }),
    metricRoad([[-100, -50], [100, -50]], { brunnel: 'tunnel', layer: -1 }),
    metricRoad([[-100, 50.1], [100, 50.1]]),
    metricRoad([[-100, 10], [100, 10]], { access: 'private' }),
    metricRoad([[-100, 20], [100, 20]], { foot: 'no' }),
    metricRoad([[10, 0], [20, 0]]),
  ]);
  const portals = graph.portals(metricGate(50));
  assert.equal(portals.length, 3);
  assert.deepEqual(new Set(portals.map(anchor => anchor.grade)), new Set(['ground|0|0', 'bridge|1|0', 'tunnel|-1|0']));
  for (const anchor of portals) {
    assert.ok(roadDistance(anchor.point, metricPoint(0, 0)) <= 50.000001);
    close(anchor.point[0], 0, 1e-10);
    assert.equal(anchor.bearing, 0);
  }
  assert.ok(portals.some(anchor => roadDistance(anchor.point, metricPoint(0, -50)) < 0.001));
});

test('portal discovery deduplicates shared road vertices and reversed tile fragments', () => {
  const graph = buildRoadGraph([
    metricRoad([[-100, 0], [0, 0]]), metricRoad([[0, 0], [100, 0]]),
    metricRoad([[100, 0], [0, 0]]), metricRoad([[0, 0], [-100, 0]]),
  ]);
  const portals = graph.portals(metricGate(50));
  assert.equal(portals.length, 1);
  assert.equal(portals[0].grade, 'ground|0|0');
  assert.ok(roadDistance(portals[0].point, metricPoint(0, 0)) < 0.001);
});

test('limited portal selection covers lateral alternatives instead of a cluster and obeys its default and hard maximum', () => {
  const roads: RoadFeature[] = Array.from({ length: 20 }, (_, index) => metricRoad([[-100, index * 2], [100, index * 2]]));
  roads.push(metricRoad([[-100, -80], [100, -80]]), metricRoad([[-100, 80], [100, 80]]));
  const graph = buildRoadGraph(roads), selected = graph.portals(metricGate(100, 3));
  assert.equal(selected.length, 3);
  for (const y of [0, -80, 80]) assert.ok(selected.some(anchor => roadDistance(anchor.point, metricPoint(0, y)) < 0.001));
  assert.equal(graph.portals(metricGate(100)).length, 8);
  assert.equal(graph.portals(metricGate(100, 100)).length, 12);
  assert.deepEqual(graph.portals(metricGate(100, 0)), []);
});

test('portal selection is deterministic across feature order and reversed road directions', () => {
  const roads = [-80, -20, 0, 2, 4, 30, 80].map((y, index) => metricRoad([[-100, y], [100, y]], index === 0 ? { brunnel: 'bridge', layer: 1 } : {}));
  const reversed = [...roads].reverse().map(road => ({ ...road, geometry: { ...road.geometry!, coordinates: [...road.geometry!.coordinates as RoadCoordinate[]].reverse() } }));
  const first = buildRoadGraph(roads).portals(metricGate(100, 4));
  const second = buildRoadGraph(reversed).portals(metricGate(100, 4));
  assert.deepEqual(second, first);
});

test('date-line gates return local anchors reusable on a clipped continuation of the same road', () => {
  const gate: RoadGate = { from: [179.998, 0], to: [-179.998, 0], center: [180, 0], halfWidthMeters: 200 };
  const graph = buildRoadGraph([feature([[179.999, 0], [-179.999, 0]])]);
  const portals = graph.portals(gate);
  assert.equal(portals.length, 1);
  assert.ok(roadDistance(portals[0].point, [180, 0]) < 0.001);
  const continuation = buildRoadGraph([feature([[-180, 0], [-179.999, 0]])]);
  const route = continuation.route(portals[0].point, [-179.999, 0], 100, { from: portals[0] });
  assert.ok(route);
  assert.ok(route.distance < 120);
});

test('strict seam anchors cannot use ordinary access snapping or jump to a nearby connected component', () => {
  const graph = buildRoadGraph([
    metricRoad([[-100, 0], [0, 0]]), metricRoad([[20, 0], [1000, 0]]),
  ]);
  const seam: RoadAnchor = { point: metricPoint(0, 0), grade: 'ground|0|0', bearing: 0 };
  assert.ok(graph.route(seam.point, metricPoint(1000, 0)));
  assert.equal(graph.route(seam.point, metricPoint(1000, 0), 100, { from: seam }), null);
  const line = buildRoadGraph([metricRoad([[0, 0], [1000, 0]])]);
  for (const meters of [0.06, 1, 99]) {
    const offset: RoadAnchor = { ...seam, point: metricPoint(0, meters) };
    assert.ok(line.route(offset.point, metricPoint(1000, 0)));
    assert.equal(line.route(offset.point, metricPoint(1000, 0), 100, { from: offset }), null);
  }
  const closeAnchor: RoadAnchor = { ...seam, point: metricPoint(0, 0.04) };
  assert.ok(line.route(closeAnchor.point, metricPoint(1000, 0), 100, { from: closeAnchor }));
  assert.equal(line.route(metricPoint(0, 1), metricPoint(1000, 0), 100, { from: seam }), null);
});

test('strict seam grades and bearings prevent switching to another level or perpendicular same-level road', () => {
  const seam: RoadAnchor = { point: metricPoint(0, 0), grade: 'bridge|1|0', bearing: 0 };
  const surface = buildRoadGraph([metricRoad([[-100, 0], [100, 0]])]);
  assert.equal(surface.route(seam.point, metricPoint(100, 0), 100, { from: seam }), null);
  const vertical = buildRoadGraph([metricRoad([[0, -100], [0, 100]])]);
  const ground = { ...seam, grade: 'ground|0|0' };
  assert.ok(vertical.route(ground.point, metricPoint(0, 100), 100, { from: { point: ground.point, grade: ground.grade } }));
  assert.equal(vertical.route(ground.point, metricPoint(0, 100), 100, { from: ground }), null);
  const bridge = buildRoadGraph([metricRoad([[0, 0], [100, 0]], { brunnel: 'bridge', layer: 1 })]);
  assert.ok(bridge.route(seam.point, metricPoint(100, 0), 100, { from: seam }));
  assert.ok(bridge.route(seam.point, metricPoint(100, 0), 100, { from: { ...seam, bearing: 180 } }));
  assert.equal(bridge.route(seam.point, metricPoint(100, 0), 100, { from: { ...seam, bearing: 90 } }), null);
});

test('nearby clipped tile endpoints cannot shift a road seam across the strict anchor tolerance', () => {
  const windowRoads = (side: number): RoadFeature[] => [
    metricRoad([[-100, side * 0.04], [-100, side * 5]]),
    metricRoad([[100, side * 0.04], [100, side * 5]]),
    metricRoad([[-100, 0], [100, 0]]),
  ];
  // The old 1e-6 node grid merged the main road with the first nearby endpoints:
  // opposite tile cuts moved its two snapshots 8 cm apart, rejecting a real seam.
  const previous = buildRoadGraph(windowRoads(1));
  const next = buildRoadGraph(windowRoads(-1));
  const anchor = previous.portals(metricGate(1, 1))[0];
  assert.ok(anchor);
  assert.ok(roadDistance(anchor.point, metricPoint(0, 0)) < 0.005);
  assert.ok(next.route(anchor.point, metricPoint(90, 0), 100, { from: anchor }));
  assert.deepEqual(buildRoadGraph([...windowRoads(1)].reverse()).portals(metricGate(1, 1)), [anchor]);
});

test('portals handle collinear gate roads and reject invalid gates and strict anchors', () => {
  const graph = buildRoadGraph([metricRoad([[0, -100], [0, 100]])]);
  const portal = graph.portals(metricGate(50, 1));
  assert.equal(portal.length, 1);
  assert.equal(portal[0].bearing, 90);
  assert.ok(roadDistance(portal[0].point, [0, 0]) < 0.001);
  for (const gate of [
    { ...metricGate(50), halfWidthMeters: -1 }, { ...metricGate(50), halfWidthMeters: Infinity },
    { ...metricGate(50), center: [0, NaN] as RoadCoordinate }, { ...metricGate(50), to: metricPoint(-100, 0) },
  ]) assert.deepEqual(graph.portals(gate), []);
  for (const bearing of [NaN, Infinity, -1, 181]) {
    assert.equal(graph.route([0, 0], metricPoint(0, 100), 100, { from: { point: [0, 0], grade: 'ground|0|0', bearing } }), null);
  }
});

test('artificial clipped endpoints never create bridge transitions while original bridge entrances still connect', () => {
  const bounds = { west: metricPoint(-250, 0)[0], east: metricPoint(600, 0)[0] + 1e-9, south: metricPoint(0, -250)[1], north: metricPoint(0, 450)[1] };
  const surface = metricRoad([[0, 200], [600, 0]]);
  const overpass = metricRoad([[-500, 0], [1600, 0]], { brunnel: 'bridge', layer: 1 });
  const original = buildRoadGraph([surface, overpass]);
  assert.equal(original.route(metricPoint(0, 200), metricPoint(1400, 0)), null);
  const clipped = [surface, overpass].map(road => clipRoadFeature(road, bounds)!);
  assert.equal(clipped[0].properties!.__mapsDirectionsEndpointFlags, '11');
  assert.equal(clipped[1].properties!.__mapsDirectionsEndpointFlags, '00');
  for (const roads of [clipped, [...clipped].reverse()]) {
    const graph = buildRoadGraph(roads);
    const destination: RoadAnchor = { point: metricPoint(500, 0), grade: 'bridge|1|0', bearing: 0 };
    assert.equal(graph.route(metricPoint(0, 200), destination.point, 100, { to: destination }), null);
  }
  const entranceBounds = { ...bounds, east: metricPoint(900, 0)[0] };
  const bridgeEntrance = metricRoad([[600, 0], [1600, 0]], { brunnel: 'bridge', layer: 1 });
  const legitimate = [surface, bridgeEntrance].map(road => clipRoadFeature(road, entranceBounds)!);
  assert.equal(legitimate[1].properties!.__mapsDirectionsEndpointFlags, '10');
  const graph = buildRoadGraph(legitimate);
  const destination: RoadAnchor = { point: metricPoint(800, 0), grade: 'bridge|1|0', bearing: 0 };
  assert.ok(graph.route(metricPoint(0, 200), destination.point, 100, { to: destination }));
});

test('endpoint provenance restricts cross-grade joins on both sides and rejects malformed multiline flags', () => {
  const from = metricPoint(0, 0), to = metricPoint(600, 0);
  const surface = metricRoad([[0, 0], [300, 0]]);
  const bridge = metricRoad([[300, 0], [600, 0]], { brunnel: 'bridge', layer: 1 });
  const marked = (road: RoadFeature, flags: unknown): RoadFeature => ({ ...road, properties: { ...road.properties, __mapsDirectionsEndpointFlags: flags } });
  assert.ok(buildRoadGraph([marked(surface, '11'), marked(bridge, '11')]).route(from, to));
  assert.equal(buildRoadGraph([marked(surface, '10'), marked(bridge, '11')]).route(from, to), null);
  assert.equal(buildRoadGraph([marked(surface, '11'), marked(bridge, '01')]).route(from, to), null);
  for (const flags of [null, 11, '', '1', '111', '11|00', 'x1']) {
    assert.equal(buildRoadGraph([surface, marked(bridge, flags)]).route(from, to), null);
  }
  const multiline: RoadFeature = { properties: { class: 'minor', brunnel: 'bridge', layer: 1, __mapsDirectionsEndpointFlags: '11|bad' }, geometry: {
    type: 'MultiLineString', coordinates: [[metricPoint(300, 0), metricPoint(600, 0)], [metricPoint(0, 1000), metricPoint(600, 1000)]],
  } };
  assert.equal(buildRoadGraph([surface, multiline]).route(from, to), null);
});

test('same-grade artificial clipping endpoints retain T-junction stitching', () => {
  const bounds = { west: metricPoint(-250, 0)[0], east: metricPoint(250, 0)[0], south: metricPoint(0, -250)[1], north: 0 };
  const clipped = [metricRoad([[-500, 0], [500, 0]]), metricRoad([[0, -500], [0, 500]])].map(road => clipRoadFeature(road, bounds)!);
  assert.ok(clipped.every(road => road.properties!.__mapsDirectionsEndpointFlags === '00'));
  const graph = buildRoadGraph(clipped);
  const route = graph.route(metricPoint(0, -200), metricPoint(200, 0));
  assert.ok(route);
  close(route.distance, 400);
  assert.ok(contains(route.coordinates, metricPoint(0, 0)));
});

test('exact same-grade interior crossings create real junctions without shared source vertices', () => {
  const from: RoadAnchor = { point: metricPoint(-500, 0), grade: 'ground|0|0', bearing: 0 };
  const to: RoadAnchor = { point: metricPoint(0, 500), grade: 'ground|0|0', bearing: 90 };
  const roads = [metricRoad([[-500, 0], [500, 0]]), metricRoad([[0, -500], [0, 500]])];
  for (const input of [roads, [...roads].reverse()]) {
    const graph = buildRoadGraph(input);
    const route = graph.route(from.point, to.point, 100, { from, to });
    assert.ok(route);
    assert.ok(contains(route.coordinates, metricPoint(0, 0)));
    close(route.distance, 1000);
    assert.equal(graph.stats.truncated, false);
  }
});

test('inserted interior junctions do not become original endpoints for cross-grade transitions', () => {
  const graph = buildRoadGraph([
    metricRoad([[-500, 0], [500, 0]]),
    metricRoad([[0, -500], [0, 500]]),
    metricRoad([[0, 0], [0, 1500]], { brunnel: 'bridge', layer: 1 }),
  ]);
  const ground: RoadAnchor = { point: metricPoint(-500, 0), grade: 'ground|0|0', bearing: 0 };
  const onGround: RoadAnchor = { point: metricPoint(0, 400), grade: 'ground|0|0', bearing: 90 };
  const onBridge: RoadAnchor = { point: metricPoint(0, 1200), grade: 'bridge|1|0', bearing: 90 };
  assert.ok(graph.route(ground.point, onGround.point, 100, { from: ground, to: onGround }));
  assert.equal(graph.route(ground.point, onBridge.point, 1000, { from: ground, to: onBridge }), null);
});

test('exact intersection handling never joins separated parallel roads or same-location different grades', () => {
  const parallel = buildRoadGraph([
    metricRoad([[-500, 0], [500, 0]]), metricRoad([[-500, 2], [500, 2]]),
  ]);
  const from: RoadAnchor = { point: metricPoint(-500, 0), grade: 'ground|0|0', bearing: 0 };
  const to: RoadAnchor = { point: metricPoint(500, 2), grade: 'ground|0|0', bearing: 0 };
  assert.equal(parallel.route(from.point, to.point, 1000, { from, to }), null);
  for (const properties of [{ brunnel: 'bridge', layer: 1 }, { brunnel: 'tunnel', layer: -1 }, { level: 1 }]) {
    const crossing = buildRoadGraph([metricRoad([[-500, 0], [500, 0]]), metricRoad([[0, -500], [0, 500]], properties)]);
    assert.equal(crossing.route(metricPoint(-500, 0), metricPoint(0, 500)), null);
  }
});

test('exact interior intersections remain local across the date line', () => {
  const graph = buildRoadGraph([
    feature([[179.999, 0], [-179.999, 0]]), feature([[-180, -0.001], [-180, 0.001]]),
  ]);
  const from: RoadAnchor = { point: [179.999, 0], grade: 'ground|0|0', bearing: 0 };
  const to: RoadAnchor = { point: [-180, 0.001], grade: 'ground|0|0', bearing: 90 };
  const route = graph.route(from.point, to.point, 100, { from, to });
  assert.ok(route);
  close(route.distance, roadDistance(from.point, [-180, 0]) + roadDistance([-180, 0], to.point));
  assert.ok(Math.abs(route.coordinates[0][0] - route.coordinates.at(-1)![0]) < 0.01);
});

test('dense exact-intersection work stops at the shared join budget instead of checking every pair', () => {
  const roads = Array.from({ length: 1100 }, (_, index) => {
    const angle = index / 1100 * Math.PI;
    const x = Math.cos(angle) * 10, y = Math.sin(angle) * 10;
    return metricRoad([[-x, -y], [x, y]]);
  });
  const graph = buildRoadGraph(roads);
  assert.equal(graph.stats.truncated, true);
  assert.ok(graph.stats.nodes <= 3300);
  assert.ok(graph.stats.edges <= 5500);
});
