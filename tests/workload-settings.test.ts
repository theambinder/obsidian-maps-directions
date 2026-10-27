import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_WORKLOAD_SETTINGS, readWorkloadSettings, workloadProfile } from '../src/workload-settings';

test('minimal Eco is the safe default and reading preferences does not mutate saved data', () => {
  for (const value of [undefined, null, '', [], { mode: 'unknown', pauseMs: NaN }]) {
    assert.deepEqual(readWorkloadSettings(value), DEFAULT_WORKLOAD_SETTINGS);
  }
  assert.deepEqual(workloadProfile(readWorkloadSettings(undefined)), {
    mode: 'eco', label: 'Eco', pauseMs: 1000, areasPerChunk: 2,
    viewportWidth: 768, viewportHeight: 512, tileCacheSize: 8,
    maxRoadFeatures: 6000, maxRoadPositions: 50000, workerTimeoutMs: 8000, maxDistanceKm: 30, maxAccessMeters: 300,
  });
  const value = { mode: 'balanced', pauseMs: 123.9 };
  assert.deepEqual(readWorkloadSettings(value), { mode: 'balanced', pauseMs: 124, maxDistanceKm: 30, maxAccessMeters: 300 });
  assert.equal(value.pauseMs, 123.9);
});

test('processing modes specify actual working geometry and chunk controls', () => {
  const eco = workloadProfile({ mode: 'eco', pauseMs: null });
  const balanced = workloadProfile({ mode: 'balanced', pauseMs: null });
  const maximum = workloadProfile({ mode: 'maximum', pauseMs: null });
  assert.deepEqual([eco.areasPerChunk, balanced.areasPerChunk, maximum.areasPerChunk], [2, 4, 8]);
  assert.deepEqual([eco.tileCacheSize, balanced.tileCacheSize, maximum.tileCacheSize], [8, 16, 32]);
  assert.deepEqual([eco.pauseMs, balanced.pauseMs, maximum.pauseMs], [1000, 250, 0]);
  assert.deepEqual([eco.maxRoadPositions, balanced.maxRoadPositions, maximum.maxRoadPositions], [50000, 100000, 200000]);
  assert.deepEqual([eco.workerTimeoutMs, balanced.workerTimeoutMs, maximum.workerTimeoutMs], [8000, 12000, 20000]);
  eco.maxRoadFeatures = 1;
  assert.equal(workloadProfile({ mode: 'eco', pauseMs: null }).maxRoadFeatures, 6000);
});

test('pause overrides are global finite milliseconds and cannot escape their documented range', () => {
  assert.equal(workloadProfile({ mode: 'maximum', pauseMs: 1500 }).pauseMs, 1500);
  assert.equal(readWorkloadSettings({ mode: 'eco', pauseMs: -50 }).pauseMs, 0);
  assert.equal(readWorkloadSettings({ mode: 'eco', pauseMs: 999999 }).pauseMs, 60000);
  for (const pauseMs of [null, undefined, Infinity, '250']) assert.equal(readWorkloadSettings({ mode: 'balanced', pauseMs }).pauseMs, null);
});


test('road-routing distance defaults to 30 km and permits explicit unlimited or custom distances', () => {
  assert.equal(readWorkloadSettings({ mode: 'maximum', pauseMs: 0 }).maxDistanceKm, 30);
  for (const maxDistanceKm of [0, 0.5, 30, 42.5, 50000]) {
    const settings = readWorkloadSettings({ mode: 'balanced', pauseMs: 2000, maxDistanceKm });
    assert.equal(settings.maxDistanceKm, maxDistanceKm);
    assert.equal(workloadProfile(settings).maxDistanceKm, maxDistanceKm);
    assert.equal(workloadProfile({ ...settings, mode: 'eco', pauseMs: null }).maxDistanceKm, maxDistanceKm);
  }
});

test('invalid road distance preferences cannot accidentally disable the default threshold', () => {
  for (const maxDistanceKm of [-1, NaN, Infinity, -Infinity, '30', null, undefined]) {
    assert.equal(readWorkloadSettings({ maxDistanceKm }).maxDistanceKm, 30);
  }
  const saved = { mode: 'eco', pauseMs: null, maxDistanceKm: 12.75 };
  assert.deepEqual(readWorkloadSettings(saved), { ...saved, maxAccessMeters: 300 });
});

test('pin-to-road access defaults to 300 m and finite preferences stay within the explicit 0–1000 m range', () => {
  for (const maxAccessMeters of [undefined, null, NaN, Infinity, -Infinity, '250', '', true]) {
    assert.equal(readWorkloadSettings({ maxAccessMeters }).maxAccessMeters, 300);
  }
  for (const [maxAccessMeters, expected] of [[-1, 0], [0, 0], [12.5, 12.5], [250, 250], [1000, 1000], [1001, 1000], [999999, 1000]]) {
    const settings = readWorkloadSettings({ mode: 'eco', maxAccessMeters });
    assert.equal(settings.maxAccessMeters, expected);
    assert.equal(workloadProfile(settings).maxAccessMeters, expected);
  }
});

test('pin access survives mode, pause and distance edits without mutating the saved preferences', () => {
  const saved = { mode: 'balanced', pauseMs: 2000, maxDistanceKm: 12.75, maxAccessMeters: 400 };
  assert.deepEqual(readWorkloadSettings(saved), saved);
  for (const edit of [{ mode: 'maximum' }, { pauseMs: null }, { pauseMs: 0 }, { maxDistanceKm: 0 }, { maxDistanceKm: 30 }]) {
    const settings = readWorkloadSettings({ ...readWorkloadSettings(saved), ...edit });
    assert.equal(settings.maxAccessMeters, 400);
    assert.equal(workloadProfile(settings).maxAccessMeters, 400);
  }
  assert.deepEqual(saved, { mode: 'balanced', pauseMs: 2000, maxDistanceKm: 12.75, maxAccessMeters: 400 });
});
