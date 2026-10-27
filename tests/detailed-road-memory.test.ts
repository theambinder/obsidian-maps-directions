import assert from 'node:assert/strict';
import test from 'node:test';
import { DetailedRoadMemory } from '../src/detailed-road-memory';
import type { RoadSnapshot } from '../src/local-roads';
import type { RoadFeature } from '../src/road-graph';
import { buildRoadGraph } from '../src/road-graph';

const road = (start: number, end = start + 0.001): RoadFeature => ({ geometry: { type: 'LineString', coordinates: [[start, 35], [end, 35]] }, properties: { class: 'minor' } });
const snapshot = (features: RoadFeature[], state: RoadSnapshot['state'] = 'ready', source = 'osm'): RoadSnapshot => ({ key: 'input', features, sources: source ? [source] : [], state });

test('detailed roads from successive map areas form one traversable local network', () => {
  const memory = new DetailedRoadMemory();
  const first = memory.merge(snapshot([road(139, 139.001)]));
  const combined = memory.merge(snapshot([road(139.001, 139.002)]));
  assert.equal(first.features.length, 1);
  assert.equal(combined.features.length, 2);
  assert.ok(buildRoadGraph(combined.features).route([139, 35], [139.002, 35]));
  assert.equal(memory.merge(snapshot([], 'zoom')), combined);
  assert.equal(memory.merge(snapshot([], 'empty')), combined);
  assert.equal(memory.merge(snapshot([], 'limited')), combined);
});

test('duplicates, query order and ignored metadata do not rebuild accumulated geometry', () => {
  const memory = new DetailedRoadMemory();
  const first = memory.merge(snapshot([road(139), road(140)]));
  const duplicate = road(139);
  duplicate.properties!.name = 'ignored map label';
  assert.equal(memory.merge(snapshot([road(140), duplicate])), first);
  const other = new DetailedRoadMemory().merge(snapshot([road(140), road(139)]));
  assert.equal(other.key, first.key);
});

test('source changes, unsupported backgrounds and explicit clear discard incompatible geometry', () => {
  const memory = new DetailedRoadMemory();
  memory.merge(snapshot([road(139)]));
  const otherSource = memory.merge(snapshot([], 'zoom', 'another'));
  assert.equal(otherSource.state, 'zoom');
  memory.merge(snapshot([road(140)], 'ready', 'another'));
  assert.equal(memory.merge(snapshot([], 'unsupported', '')).state, 'unsupported');
  assert.equal(memory.merge(snapshot([], 'zoom')).state, 'zoom');
  memory.merge(snapshot([road(139)])); memory.clear();
  assert.equal(memory.merge(snapshot([], 'empty')).state, 'empty');
});

test('bounded memory evicts old detail while retaining the newest map area', () => {
  const memory = new DetailedRoadMemory({ features: 2, positions: 4 });
  memory.merge(snapshot([road(139), road(140)]));
  const combined = memory.merge(snapshot([road(141)]));
  assert.equal(combined.features.length, 2);
  const all = JSON.stringify(combined.features);
  assert.ok(!all.includes('139,'));
  assert.ok(all.includes('141,'));
});

test('at capacity a pan keeps overlapping currently loaded roads and evicts roads left behind', () => {
  const memory = new DetailedRoadMemory({ features: 2, positions: 4 });
  memory.merge(snapshot([road(139), road(140)]));
  const combined = memory.merge(snapshot([road(139), road(141)]));
  const all = JSON.stringify(combined.features);
  assert.equal(combined.features.length, 2);
  assert.ok(all.includes('139,'));
  assert.ok(all.includes('141,'));
  assert.ok(!all.includes('140,'));
  assert.equal(memory.merge(snapshot([road(141), road(139)])), combined);
  assert.equal(memory.merge(snapshot([road(139), road(141)])), combined);
});

test('later changes to source objects do not mutate captured road data', () => {
  const memory = new DetailedRoadMemory();
  const input = road(139);
  const stored = memory.merge(snapshot([input]));
  (input.geometry!.coordinates as number[][])[0][0] = 0;
  input.properties!.class = 'motorway';
  assert.equal((stored.features[0].geometry!.coordinates as number[][])[0][0], 139);
  assert.equal(stored.features[0].properties!.class, 'minor');
  assert.ok(Object.isFrozen(stored));
  assert.ok(Object.isFrozen(stored.features));
  assert.ok(Object.isFrozen(stored.features[0].geometry!.coordinates));
  assert.throws(() => { stored.features.push(road(141)); }, TypeError);
});

test('oversized and malformed road geometry cannot exceed the memory budget', () => {
  const memory = new DetailedRoadMemory({ positions: 4 });
  const current = memory.merge(snapshot([road(139)]));
  const huge: RoadFeature = { geometry: { type: 'LineString', coordinates: Array.from({ length: 5 }, () => [140, 35]) }, properties: { class: 'minor' } };
  assert.equal(memory.merge(snapshot([huge])), current);
  const invalid: RoadFeature = { geometry: { type: 'LineString', coordinates: [[140, 35], [NaN, 35]] }, properties: { class: 'minor' } };
  assert.equal(memory.merge(snapshot([invalid])), current);
  assert.equal(new DetailedRoadMemory({ positions: 4 }).merge(snapshot([huge])).state, 'empty');
});
