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
