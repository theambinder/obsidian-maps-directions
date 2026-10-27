import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeatureCollection } from '../src/contracts';
import { planRoadPreparation, MAX_PREPARATION_AREAS, ROAD_PREPARATION_HEIGHT, ROAD_PREPARATION_WIDTH, ROAD_PREPARATION_ZOOM } from '../src/road-preparation-targets';
import type { RoadCoordinate } from '../src/road-graph';

const feature = (from: RoadCoordinate, to: RoadCoordinate, kind?: string): FeatureCollection['features'][number] => ({
  type: 'Feature', properties: kind ? { connectionKind: kind } : {}, geometry: { type: 'LineString', coordinates: [from, to] },
});
const data = (...features: FeatureCollection['features']): FeatureCollection => ({ type: 'FeatureCollection', features });
const WORLD = 2 * Math.PI * 6371008.8;
const project = ([longitude, latitude]: RoadCoordinate): RoadCoordinate => [longitude / 360 * WORLD, WORLD / (2 * Math.PI) * Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360))];

function covered(point: RoadCoordinate, centers: RoadCoordinate[], margin = 0): boolean {
  const pixel = WORLD / (512 * 2 ** ROAD_PREPARATION_ZOOM);
  const [x, y] = project(point);
  return centers.some(center => {
    const [cx, cy] = project(center);
    const delta = Math.abs(x - cx) % WORLD;
    return Math.min(delta, WORLD - delta) + margin <= ROAD_PREPARATION_WIDTH * pixel / 2 && Math.abs(y - cy) + margin <= ROAD_PREPARATION_HEIGHT * pixel / 2;
  });
}

test('empty, invalid and already routed connections require no preparation areas', () => {
  assert.deepEqual(planRoadPreparation(data(), [114, 22]), { centers: [], limited: false, skippedLongLegs: 0 });
  const input = data(feature([114, 22], [114.01, 22.01], 'road'), feature([114, 22], [114.01, 22.01], 'connector'), feature([NaN, 22], [114, 22]), feature([114, 90], [114.01, 22]));
  assert.equal(planRoadPreparation(input).centers.length, 0);
});

test('urban corridor views cover intermediate streets and an overlap margin', () => {
  const from: RoadCoordinate = [114.1, 22.25], to: RoadCoordinate = [114.22, 22.36];
  const plan = planRoadPreparation(data(feature(from, to, 'fallback')), from);
  assert.equal(plan.limited, false);
  assert.equal(plan.skippedLongLegs, 0);
  assert.deepEqual(plan.centers[0], from);
  assert.ok(plan.centers.length > 2 && plan.centers.length <= MAX_PREPARATION_AREAS);
  for (let index = 0; index <= 50; index++) {
    const point: RoadCoordinate = [from[0] + (to[0] - from[0]) * index / 50, from[1] + (to[1] - from[1]) * index / 50];
    assert.ok(covered(point, plan.centers, 500), `Uncovered urban corridor at ${point}`);
  }
});

test('the original map area and nearby urban legs take priority over remote destinations', () => {
  const origin: RoadCoordinate = [114.17, 22.3];
  const plan = planRoadPreparation(data(
    feature([116.4, 39.9], [116.5, 40]),
    feature([114.17, 22.3], [114.19, 22.31]),
  ), origin, { maxAreas: 3 });
  assert.deepEqual(plan.centers[0], origin);
  assert.equal(plan.limited, true);
  assert.ok(plan.centers.every(center => Math.abs(center[0] - origin[0]) < 0.1 && Math.abs(center[1] - origin[1]) < 0.1));
});

test('long transport legs get endpoint detail without filling the intercity corridor', () => {
  const from: RoadCoordinate = [114.17, 22.3], to: RoadCoordinate = [116.4, 39.9];
  const plan = planRoadPreparation(data(feature(from, to)));
  assert.equal(plan.skippedLongLegs, 1);
  assert.equal(plan.limited, false);
  assert.equal(plan.centers.length, 2);
  assert.ok(covered(from, plan.centers));
  assert.ok(covered(to, plan.centers));
  assert.equal(covered([115.2, 31], plan.centers), false);
});

test('short date-line crossings stay near the date line and use the short corridor', () => {
  const from: RoadCoordinate = [179.96, 35], to: RoadCoordinate = [-179.96, 35];
  const plan = planRoadPreparation(data(feature(from, to)), from);
  assert.equal(plan.skippedLongLegs, 0);
  assert.equal(plan.limited, false);
  assert.ok(plan.centers.every(center => Math.abs(center[0]) > 179.9));
  assert.ok(covered([180, 35], plan.centers, 500));
  assert.ok(covered(from, plan.centers)); assert.ok(covered(to, plan.centers));
});

test('area and connection limits bound large plans and report incomplete coverage', () => {
  const highLatitude = planRoadPreparation(data(feature([0, 85], [2, 85])));
  assert.equal(highLatitude.centers.length, MAX_PREPARATION_AREAS);
  assert.equal(highLatitude.limited, true);
  assert.ok(highLatitude.centers.every(center => center.every(Number.isFinite) && Math.abs(center[0]) <= 180 && Math.abs(center[1]) <= 85.051129));
  const repeated = data(...Array.from({ length: 201 }, () => feature([114, 22], [114.001, 22])));
  const limitedConnections = planRoadPreparation(repeated);
  assert.equal(limitedConnections.limited, true);
  assert.equal(limitedConnections.centers.length, 1);
  assert.ok(planRoadPreparation(repeated, null, { maxAreas: 99999 }).centers.length <= MAX_PREPARATION_AREAS);
});

test('duplicate legs reuse areas, planning is deterministic, and input data remains intact', () => {
  const input = data(feature([114.17, 22.3], [114.19, 22.31]), feature([114.17, 22.3], [114.19, 22.31]));
  const before = structuredClone(input);
  const first = planRoadPreparation(input, [114.17, 22.3]);
  assert.deepEqual(first, planRoadPreparation(input, [114.17, 22.3]));
  assert.deepEqual(first, planRoadPreparation(data(input.features[0]), [114.17, 22.3]));
  assert.deepEqual(input, before);
});
