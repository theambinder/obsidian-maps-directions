import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDirections, shortestSegment } from '../src/geometry';
import type { MapsMarker } from '../src/contracts';

function marker(path: string, latitude: number, longitude: number, sequence: unknown, route?: string): MapsMarker {
  const values: Record<string, unknown> = { sequence, route };
  return {
    coordinates: [latitude, longitude],
    entry: { file: { path }, getValue: property => values[property] == null ? null : { toString: () => String(values[property]) } },
  };
}

test('sorts numerically including zero, keeps stable path ties, and skips missing sequences', () => {
  const result = buildDirections([
    marker('ten.md', 10, 10, 10), marker('b.md', 2, 2, '2'),
    marker('missing.md', 3, 3, undefined), marker('a.md', 1, 1, 2),
    marker('zero.md', 0, 0, 0), marker('empty.md', 4, 4, ' '),
    marker('invalid.md', 5, 5, 'not a number'), marker('infinite.md', 6, 6, Infinity),
  ], 'sequence', null);
  assert.deepEqual(result.features.map(f => [f.properties.from, f.properties.to]), [
    ['zero.md', 'a.md'], ['a.md', 'b.md'], ['b.md', 'ten.md'],
  ]);
  assert.deepEqual(result.features[0].geometry.coordinates, [[0, 0], [1, 1]]);
  assert.equal(result.features[0].properties.fromSequence, 0);
});

test('groups are independent routes, including an empty route value', () => {
  const result = buildDirections([
    marker('a1.md', 1, 1, 1, 'A'), marker('b2.md', 4, 4, 2, 'B'),
    marker('a2.md', 2, 2, 2, 'A'), marker('b1.md', 3, 3, 1, 'B'),
    marker('none1.md', 5, 5, 1), marker('none2.md', 6, 6, 2),
  ], 'sequence', 'route');
  assert.deepEqual(result.features.map(f => [f.properties.route, f.properties.from, f.properties.to]), [
    ['', 'none1.md', 'none2.md'], ['A', 'a1.md', 'a2.md'], ['B', 'b1.md', 'b2.md'],
  ]);
});

test('each adjacent pair is a separate feature and zero-length segments are omitted', () => {
  const result = buildDirections([
    marker('one.md', 1, 1, 1), marker('same.md', 1, 1, 2),
    marker('three.md', 3, 3, 3), marker('four.md', 4, 4, 4),
  ], 'sequence', null);
  assert.equal(result.features.length, 2);
  assert.deepEqual(result.features.map(f => f.geometry.coordinates), [[[1, 1], [3, 3]], [[3, 3], [4, 4]]]);
  assert.equal(result.features[0].properties.from, 'same.md');
});

test('crosses the antimeridian by the shortest longitude difference in either direction', () => {
  assert.deepEqual(shortestSegment([10, 179], [11, -179]), [[179, 10], [181, 11]]);
  assert.deepEqual(shortestSegment([11, -179], [10, 179]), [[-179, 11], [-181, 10]]);
  assert.deepEqual(shortestSegment([0, 540], [1, -179]), [[-180, 0], [-179, 1]]);
  assert.equal(shortestSegment([2, 180], [2, -180]), null);
});

test('invalid coordinate values are not added to GeoJSON', () => {
  const result = buildDirections([
    marker('valid.md', 10, 10, 1), marker('invalid.md', 91, 15, 2),
    marker('nan.md', 10, NaN, 3), marker('end.md', 20, 20, 4),
  ], 'sequence', null);
  assert.equal(result.features.length, 1);
  assert.equal(result.features[0].properties.to, 'end.md');
});
