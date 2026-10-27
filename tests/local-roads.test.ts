import assert from 'node:assert/strict';
import test from 'node:test';
import { collectLocalRoads } from '../src/local-roads';
import type { RoadFeature } from '../src/road-graph';

function map(roads: RoadFeature[], zoom = 15) {
  let queries = 0;
  return {
    getZoom: () => zoom,
    getStyle: () => ({ sources: { osm: { type: 'vector' }, pins: { type: 'geojson' } }, layers: [
      { source: 'osm', 'source-layer': 'transportation' }, { source: 'osm', 'source-layer': 'transportation' },
      { source: 'pins', 'source-layer': 'transportation' },
    ] }),
    querySourceFeatures(id: string, options: { sourceLayer: string }) {
      assert.equal(id, 'osm'); assert.equal(options.sourceLayer, 'transportation'); queries++; return roads;
    },
    get queries() { return queries; },
  };
}
const line = (longitude: number): RoadFeature => ({ geometry: { type: 'LineString', coordinates: [[longitude, 35], [longitude + 0.01, 35]] }, properties: { class: 'minor', name: 'not needed', access: 'yes' } });

test('reads existing vector roads once and drops duplicates and irrelevant metadata', () => {
  const source = map([line(139), line(139)]);
  const snapshot = collectLocalRoads(source);
  assert.equal(source.queries, 1);
  assert.equal(snapshot.state, 'ready');
  assert.equal(snapshot.features.length, 1);
  assert.equal(snapshot.features[0].properties?.name, undefined);
  assert.deepEqual(snapshot.sources, ['osm']);
});

test('road fingerprints are stable across tile query order but change with geometry', () => {
  const first = collectLocalRoads(map([line(139), line(140)]));
  assert.equal(first.key, collectLocalRoads(map([line(140), line(139)])).key);
  assert.notEqual(first.key, collectLocalRoads(map([line(141), line(139)])).key);
});

test('overview scale does not query coarse roads and raster backgrounds are unsupported', () => {
  const source = map([line(139)], 10);
  assert.equal(collectLocalRoads(source).state, 'zoom');
  assert.equal(source.queries, 0);
  assert.equal(collectLocalRoads({ getStyle: () => ({ sources: { raster: { type: 'raster' } }, layers: [] }), getZoom: () => 15, querySourceFeatures: () => [] }).state, 'unsupported');
});

test('oversized road input fails to fallback instead of building an arbitrary partial graph', () => {
  const huge = { geometry: { type: 'LineString', coordinates: Array.from({ length: 100001 }, () => [139, 35]) }, properties: { class: 'minor' } };
  assert.equal(collectLocalRoads(map([huge])).state, 'limited');
});


test('explicit preparation can read coarse roads without changing the visible-map detail requirement', () => {
  const source = map([line(139)], 7);
  assert.equal(collectLocalRoads(source).state, 'zoom');
  const coarse = collectLocalRoads(source, { minZoom: 7 });
  assert.equal(coarse.state, 'ready');
  assert.equal(source.queries, 1);
  assert.equal(collectLocalRoads(source, { minZoom: 8 }).state, 'zoom');
});

test('working feature and coordinate budgets are configurable and discard an oversized area explicitly', () => {
  const roads = [line(139), line(140)];
  assert.equal(collectLocalRoads(map(roads), { maxFeatures: 1 }).state, 'limited');
  assert.equal(collectLocalRoads(map(roads), { maxFeatures: 2, maxPositions: 4 }).state, 'ready');
  assert.equal(collectLocalRoads(map(roads), { maxPositions: 3 }).state, 'limited');
  assert.equal(collectLocalRoads(map(roads), { maxFeatures: NaN, maxPositions: Infinity }).state, 'ready');
});

test('clipping excludes outside geometry before counting feature and coordinate budgets', () => {
  const outside = Array.from({ length: 20 }, (_, index) => line(140 + index / 100));
  const source = map([...outside, line(139)]);
  const clipBounds = { west: 139.002, south: 34.9, east: 139.004, north: 35.1 };
  assert.equal(collectLocalRoads(source, { maxFeatures: 1, maxPositions: 2 }).state, 'limited');
  const clipped = collectLocalRoads(source, { maxFeatures: 1, maxPositions: 2, clipBounds });
  assert.equal(clipped.state, 'ready');
  assert.equal(clipped.features.length, 1);
  const coordinates = clipped.features[0].geometry!.coordinates as number[][];
  assert.equal(coordinates.length, 2);
  assert.ok(Math.abs(coordinates[0][0] - clipBounds.west) < 1e-9);
  assert.ok(Math.abs(coordinates[1][0] - clipBounds.east) < 1e-9);
  assert.equal(clipped.features[0].properties?.name, undefined);
  assert.equal(clipped.features[0].properties?.__mapsDirectionsEndpointFlags, '00');
  assert.equal(source.queries, 2);
  assert.equal(collectLocalRoads(map(outside), { maxFeatures: 1, maxPositions: 2, clipBounds }).state, 'empty');
});

test('road collection preserves endpoint provenance while dropping unrelated source metadata', () => {
  const original = line(139);
  original.properties = { ...original.properties, __mapsDirectionsEndpointFlags: '10' };
  const loaded = collectLocalRoads(map([original]));
  assert.equal(loaded.features[0].properties?.__mapsDirectionsEndpointFlags, '10');
  assert.equal(loaded.features[0].properties?.name, undefined);
  const clipped = collectLocalRoads(map(loaded.features), { clipBounds: { west: 138, south: 34, east: 140, north: 36 } });
  assert.equal(clipped.features[0].properties?.__mapsDirectionsEndpointFlags, '10');
  const cut = collectLocalRoads(map(loaded.features), { clipBounds: { west: 139.002, south: 34, east: 140, north: 36 } });
  assert.equal(cut.features[0].properties?.__mapsDirectionsEndpointFlags, '00');
  assert.equal(original.properties.__mapsDirectionsEndpointFlags, '10');
});
