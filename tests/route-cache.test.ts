import assert from 'node:assert/strict';
import test from 'node:test';
import { RoadRouteCache } from '../src/route-cache';
import type { RoadRoute } from '../src/routing-protocol';

const key = (index = 0): string => JSON.stringify([[139 + index / 100, 35], [139.001 + index / 100, 35]]);
const route = (vertices = 2): RoadRoute => ({ distance: 100, coordinates: Array.from({ length: vertices }, (_, i) => [139 + i / 100000, 35]) });

test('saved road paths survive serialization without exposing mutable cache state', () => {
  let changes = 0;
  const cache = new RoadRouteCache(undefined, () => changes++);
  const original = route();
  assert.equal(cache.set(key(), original), true);
  original.coordinates[0][0] = 0;
  assert.equal(cache.get(key())!.coordinates[0][0], 139);
  const saved = cache.serialize();
  const restored = new RoadRouteCache(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(restored.get(key()), cache.get(key()));
  saved.routes[0].route.coordinates[0][0] = 1;
  const read = cache.get(key())!;
  read.coordinates[0][0] = 2;
  assert.equal(cache.get(key())!.coordinates[0][0], 139);
  assert.equal(changes, 1);
});

test('identical paths and reads cause no save churn; only writes refresh eviction order', () => {
  let changes = 0;
  const cache = new RoadRouteCache(undefined, () => changes++, { routes: 2 });
  cache.set(key(), route()); cache.set(key(1), route());
  assert.equal(cache.set(key(), route()), false);
  cache.get(key());
  cache.set(key(2), route());
  assert.equal(cache.get(key()), undefined);
  assert.ok(cache.get(key(1))); assert.ok(cache.get(key(2)));
  assert.equal(changes, 3);
});

test('route and total geometry limits keep the saved file bounded', () => {
  const cache = new RoadRouteCache(undefined, undefined, { vertices: 5, routeVertices: 4 });
  assert.equal(cache.set(key(), route(5)), false);
  cache.set(key(), route(3)); cache.set(key(1), route(3));
  assert.equal(cache.get(key()), undefined);
  assert.equal(cache.serialize().routes.length, 1);
  assert.equal(cache.set(key(1), route(2)), true);
  cache.set(key(2), route(3));
  assert.equal(cache.serialize().routes.length, 2);
});

test('malformed versions, keys and road geometries are rejected on both load and write', () => {
  assert.equal(new RoadRouteCache({ version: 2, routes: [{ key: key(), route: route() }] }).serialize().routes.length, 0);
  const invalid: unknown[] = [null, {}, { distance: -1, coordinates: [[139, 35], [140, 35]] },
    { distance: 100, coordinates: [[139, 91], [140, 35]] },
    { distance: Infinity, coordinates: [[139, 35], [140, 35]] },
    { distance: 100, coordinates: [[NaN, 35], [140, 35]] },
    { distance: 100, coordinates: [[139, 35]] }];
  const cache = new RoadRouteCache({ version: 1, routes: [
    ...invalid.map(value => ({ key: key(), route: value })),
    { key: 'not endpoints', route: route() },
    { key: key(), route: route() },
  ] });
  assert.equal(cache.serialize().routes.length, 1);
  for (const value of invalid) assert.equal(cache.set(key(), value as RoadRoute), false);
  assert.equal(cache.set('not endpoints', route()), false);
  assert.equal(cache.set(JSON.stringify([[181, 35], [140, 35]]), route()), false);
});

test('unwrapped date-line paths and equal endpoint paths are valid', () => {
  const cache = new RoadRouteCache();
  const dateline = JSON.stringify([[179.99, 35], [-179.99, 35]]);
  assert.equal(cache.set(dateline, { distance: 2000, coordinates: [[179.99, 35], [180.01, 35]] }), true);
  assert.equal(new RoadRouteCache(cache.serialize()).get(dateline)?.coordinates[1][0], 180.01);
  assert.equal(cache.set(JSON.stringify([[139, 35], [139, 35]]), { distance: 0, coordinates: [[139, 35], [139, 35]] }), true);
});

test('load keeps only the newest bounded routes and does not call the save callback', () => {
  let changes = 0;
  const cache = new RoadRouteCache({ version: 1, routes: Array.from({ length: 10 }, (_, i) => ({ key: key(i), route: route() })) }, () => changes++, { routes: 2 });
  assert.equal(cache.get(key(7)), undefined);
  assert.ok(cache.get(key(8))); assert.ok(cache.get(key(9)));
  assert.equal(changes, 0);
});
