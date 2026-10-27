import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeatureCollection } from '../src/contracts';
import { separateRoadLanes } from '../src/route-lanes';

type Feature = FeatureCollection['features'][number];
const road = (route: string, coordinates: [number, number][], kind = 'road'): Feature => ({
  type: 'Feature', properties: { route, from: `${route}-a`, to: `${route}-b`, connectionKind: kind, lineColor: '#123456' },
  geometry: { type: 'LineString', coordinates },
});
const lanes = (features: Feature[], width = 3, size = 1): Feature[] => separateRoadLanes({ type: 'FeatureCollection', features }, width, size).features;
const physicalOffset = (feature: Feature): number => {
  const points = feature.geometry.coordinates;
  const a = points[0], b = points.at(-1)!;
  const direction = b[0] > a[0] || (b[0] === a[0] && b[1] > a[1]) ? 1 : -1;
  return Number(feature.properties.lineOffset) * direction;
};

test('one road remains centered and input cached geometry is unchanged', () => {
  const input = [road('A', [[0, 0], [0.01, 0], [0.01, 0.01]])];
  const original = JSON.stringify(input);
  const output = lanes(input);
  assert.equal(output.length, 1);
  assert.equal(output[0].properties.lineOffset, 0);
  assert.deepEqual(output[0].properties.iconOffset, [0, 0]);
  assert.deepEqual(output[0].geometry, input[0].geometry);
  assert.equal(JSON.stringify(input), original);
});

test('opposite traversals use symmetric physical lanes and matching pixel arrow offsets', () => {
  const output = lanes([road('A', [[0, 0], [0.01, 0]]), road('B', [[0.01, 0], [0, 0]])], 3, 0.5);
  assert.deepEqual(output.map(physicalOffset), [-2.25, 2.25]);
  for (const feature of output) {
    assert.equal(feature.properties.laneArrow, 1);
    assert.deepEqual(feature.properties.iconOffset, [0, Number(feature.properties.lineOffset) / 0.5]);
  }
});

test('three and four overlapping routes occupy distinct evenly spaced lanes', () => {
  for (const count of [3, 4]) {
    const output = lanes(Array.from({ length: count }, (_, index) => road(String(index), [[0, 0], [0.01, 0]])));
    const offsets = output.map(physicalOffset);
    assert.equal(new Set(offsets).size, count);
    assert.equal(offsets.reduce((sum, value) => sum + value, 0), 0);
    for (let index = 1; index < count; index++) assert.equal(offsets[index] - offsets[index - 1], 4.5);
  }
});

test('same and reversed routes stay on their lane around a curve that changes compass direction', () => {
  const curve: [number, number][] = [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [-0.01, 0.005]];
  const input = [road('A', curve), road('B', curve), road('C', [...curve].reverse())];
  const output = lanes(input);
  assert.equal(output.length, 3, 'a continuous shared curve stays one run per traversal');
  assert.deepEqual(output.map(feature => feature.properties.lineOffset), [-4.5, 0, -4.5]);
  assert.deepEqual(output.map(feature => feature.geometry.coordinates), input.map(feature => feature.geometry.coordinates));
  assert.deepEqual(lanes([...input].reverse()).map(feature => [feature.properties.route, feature.properties.lineOffset]).reverse(),
    output.map(feature => [feature.properties.route, feature.properties.lineOffset]));
});

test('partial overlaps and different vertex subdivisions split only the shared stretch', () => {
  const output = lanes([road('A', [[0, 0], [0.03, 0]]), road('B', [[0.02, 0], [0.015, 0], [0.01, 0]])]);
  const a = output.filter(feature => feature.properties.route === 'A');
  const b = output.filter(feature => feature.properties.route === 'B');
  assert.equal(a.length, 3);
  assert.equal(b.length, 1);
  assert.deepEqual(a.map(feature => feature.properties.lineOffset), [0, -2.25, 0]);
  assert.ok(Math.abs(a[1].geometry.coordinates[0][0] - 0.01) < 1e-12);
  assert.ok(Math.abs(a[1].geometry.coordinates.at(-1)![0] - 0.02) < 1e-12);
  assert.equal(physicalOffset(b[0]), 2.25);
  assert.equal(a.filter(feature => feature.properties.laneArrow === 1).length, 1);
});

test('a route that traverses a road three times has three lanes instead of covering itself', () => {
  const output = lanes([road('A', [[0, 0], [0.01, 0], [0, 0], [0.01, 0]])]);
  assert.equal(output.length, 3);
  assert.deepEqual(output.map(physicalOffset), [-4.5, 0, 4.5]);
  assert.equal(output.filter(feature => feature.properties.laneArrow === 1).length, 1);
});

test('crossing roads, nearby parallel streets, fallback and access connectors stay centered', () => {
  const output = lanes([
    road('A', [[0, 0], [0.01, 0]]), road('B', [[0.005, -0.005], [0.005, 0.005]]),
    road('C', [[0, 0.00001], [0.01, 0.00001]]),
    road('D', [[0, 0], [0.01, 0]], 'fallback'), road('E', [[0, 0], [0.01, 0]], 'connector'),
  ]);
  assert.ok(output.every(feature => feature.properties.lineOffset === 0));
  assert.equal(output[4].properties.laneArrow, 0);
});

test('lane sides stay deterministic when feature order changes, including vertical roads', () => {
  const input = [road('B', [[1, 0.01], [1, 0]]), road('A', [[1, 0], [1, 0.01]]), road('C', [[1, 0], [1, 0.01]])];
  const offsets = (features: Feature[]) => Object.fromEntries(lanes(features).map(feature => [String(feature.properties.route), physicalOffset(feature)]));
  assert.deepEqual(offsets(input), offsets([...input].reverse()));
});

test('opposite date-line traversals share lanes even with an unrelated reference road', () => {
  const output = lanes([road('reference', [[0, 0], [0.01, 0]]),
    road('A', [[179, 1], [181, 1]]), road('B', [[-179, 1], [-181, 1]])]);
  assert.equal(output.length, 3);
  assert.equal(output[0].properties.lineOffset, 0);
  assert.equal(Math.abs(Number(output[1].properties.lineOffset)), 2.25);
  assert.equal(Math.abs(Number(output[2].properties.lineOffset)), 2.25);
});

test('a partial overlap at the reference world seam matches its longer road in the neighboring world', () => {
  const output = lanes([
    road('reference', [[0, 0], [0.01, 0]]),
    road('A', [[179.995, 1], [180.005, 1]]),
    road('B', [[179.995, 1], [180, 1]]),
  ]);
  const a = output.filter(feature => feature.properties.route === 'A');
  assert.equal(a.length, 2);
  assert.deepEqual(a.map(feature => feature.properties.lineOffset), [-2.25, 0]);
  assert.ok(output.filter(feature => feature.properties.route === 'B')
    .every(feature => Math.abs(Number(feature.properties.lineOffset)) === 2.25));
  assert.equal(output.filter(feature => feature.properties.route === 'reference')[0].properties.lineOffset, 0);
});

test('candidate work stays linear for long polylines with an unrelated distant road', () => {
  // Count comparisons instead of imposing machine-dependent timing thresholds.
  // An x-only sweep performs ~72 million comparisons for the vertical input.
  const count = 12000;
  for (const vertical of [false, true]) {
    const coordinates: [number, number][] = Array.from({ length: count + 1 }, (_, index) =>
      vertical ? [1, index * 0.00001] : [index * 0.00001, 1]);
    const diagnostics = { candidateChecks: 0 };
    const input: FeatureCollection = { type: 'FeatureCollection', features: [road('reference', [[50, 10], [51, 10]]), road('A', coordinates)] };
    const output = separateRoadLanes(input, 3, 1, diagnostics);
    assert.ok(diagnostics.candidateChecks < count * 20, `${vertical ? 'vertical' : 'horizontal'} sweep: ${diagnostics.candidateChecks} candidates`);
    assert.equal(output.features.length, 2);
    assert.ok(output.features.every(feature => feature.properties.lineOffset === 0));
    assert.deepEqual(output.features[1].geometry.coordinates, coordinates);
  }
});

test('millimetre-rounded tile paths and short seam subdivisions keep one continuous shared lane', () => {
  const exact: [number, number][] = [
    [10.1012719348, 20.2013971263],
    [10.1011839615, 20.2018753341],
    [10.1010652181, 20.2026961347],
    [10.1009874143, 20.2035143928],
  ];
  const shortSeam: [number, number] = [
    exact[1][0] * 0.006 + exact[2][0] * 0.994,
    exact[1][1] * 0.006 + exact[2][1] * 0.994,
  ];
  const rounded = [exact[0], exact[1], shortSeam, exact[2], exact[3]].map(point =>
    point.map(value => Math.round(value * 1e8) / 1e8) as [number, number]).reverse();
  const input = [road('Day A', exact), road('Day B', rounded)];
  const before = JSON.stringify(input);
  const output = lanes(input);
  assert.equal(output.length, 2, 'rounded endpoints must not create tiny centered gaps in a shared run');
  assert.deepEqual(output.map(physicalOffset), [2.25, -2.25]);
  assert.ok(output.every(feature => feature.properties.laneArrow === 1));
  assert.equal(JSON.stringify(input), before, 'saved road coordinates are immutable');
  input.forEach((feature, index) => assert.ok(feature.geometry.coordinates.every(point =>
    output[index].geometry.coordinates.some(candidate => candidate[0] === point[0] && candidate[1] === point[1])),
    'render splitting retains every original vertex in its ordered run'));
});

test('three rounded or differently subdivided group paths still receive three distinct continuous lanes', () => {
  const exact: [number, number][] = [
    [30.0012345679, 40.0012345678], [30.0011234568, 40.0021234567], [30.0010123457, 40.0030123456],
  ];
  const rounded = exact.map(point => point.map(value => Math.round(value * 1e8) / 1e8) as [number, number]);
  const reverse = [...rounded].reverse();
  const output = lanes([road('A', exact), road('B', rounded), road('C', reverse)]);
  assert.equal(output.length, 3);
  const offsets = output.map(physicalOffset);
  assert.equal(new Set(offsets).size, 3);
  assert.deepEqual(offsets.map(value => value || 0), [4.5, 0, -4.5]);
});

test('small-angle crossing roads are not interpreted as a shared long road', () => {
  const output = lanes([
    road('A', [[0, 0], [0.01, 0]]),
    road('B', [[0, -0.00001], [0.01, 0.00001]]),
  ]);
  assert.ok(output.every(feature => feature.properties.lineOffset === 0), 'different road positions still require the conservative positional match');
});
