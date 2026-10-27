import assert from 'node:assert/strict';
import test from 'node:test';
import { formatStorageBytes, formatStorageDelta, refreshStorageUsage, STORAGE_SCOPE, StorageUsageTracker } from '../src/storage-usage';

test('file usage starts unknown and establishes a baseline only from a valid measurement', () => {
  let time = 1;
  const tracker = new StorageUsageTracker(undefined, () => time);
  assert.deepEqual(tracker.snapshot(), { scope: STORAGE_SCOPE, available: false, dataBytes: null, baselineBytes: null, sessionDeltaBytes: null, measuredAt: null, browserCacheBytes: null });
  for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.equal(tracker.observe(value), false);
  assert.equal(tracker.snapshot().baselineBytes, null);
  assert.equal(tracker.observe(1200), true);
  assert.deepEqual(tracker.snapshot(), { scope: STORAGE_SCOPE, available: true, dataBytes: 1200, baselineBytes: 1200, sessionDeltaBytes: 0, measuredAt: 1, browserCacheBytes: null });
  time = 2;
  tracker.observe(2000);
  assert.equal(tracker.snapshot().sessionDeltaBytes, 800);
  tracker.observe(600);
  assert.equal(tracker.snapshot().sessionDeltaBytes, -600);
  assert.equal(tracker.snapshot().baselineBytes, 1200);
});

test('zero-sized or missing initial file is a real baseline and snapshots are independent', () => {
  const tracker = new StorageUsageTracker();
  tracker.observe(0);
  tracker.observe(300);
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.sessionDeltaBytes, 300);
  snapshot.dataBytes = 999;
  assert.equal(tracker.snapshot().dataBytes, 300);
  assert.equal(tracker.snapshot().baselineBytes, 0);
});

test('read failures show unavailable rather than zero and recovery retains the session baseline', () => {
  const changes: unknown[] = [];
  const tracker = new StorageUsageTracker(snapshot => changes.push(snapshot.dataBytes));
  tracker.observe(1000);
  tracker.unavailable();
  assert.equal(tracker.snapshot().available, false);
  assert.equal(tracker.snapshot().dataBytes, null);
  assert.equal(tracker.snapshot().sessionDeltaBytes, null);
  assert.equal(tracker.snapshot().baselineBytes, 1000);
  tracker.observe(1500);
  assert.equal(tracker.snapshot().sessionDeltaBytes, 500);
  assert.deepEqual(changes, [1000, null, 1500]);
});

test('identical sizes do not cause redraw churn and a failing display callback stays nonfatal', () => {
  let changes = 0, time = 0;
  const tracker = new StorageUsageTracker(() => { changes++; throw Error('Display closed.'); }, () => ++time);
  tracker.observe(100);
  tracker.observe(100);
  assert.equal(changes, 1);
  assert.equal(tracker.snapshot().measuredAt, 2);
  tracker.unavailable();
  tracker.unavailable();
  assert.equal(changes, 2);
});

test('adapter refresh stats only the specified data file and measures logical bytes', async () => {
  const requests: string[] = [];
  const tracker = new StorageUsageTracker();
  const adapter = { stat: async (path: string) => { requests.push(path); return { type: 'file', size: 1234567 }; } };
  const result = await refreshStorageUsage(adapter, '.obsidian/plugins/maps-directions/data.json', tracker);
  assert.deepEqual(requests, ['.obsidian/plugins/maps-directions/data.json']);
  assert.equal(result.dataBytes, 1234567);
  assert.equal(result.sessionDeltaBytes, 0);
  assert.equal(result.browserCacheBytes, null);
});

test('missing, malformed, folder and inaccessible files never become fabricated cache totals', async () => {
  const tracker = new StorageUsageTracker();
  assert.equal((await refreshStorageUsage({ stat: async () => null }, 'data.json', tracker)).dataBytes, 0);
  for (const stat of [{ size: NaN }, { size: -1 }, { type: 'folder', size: 9000 }]) {
    assert.equal((await refreshStorageUsage({ stat: async () => stat }, 'data.json', tracker)).available, false);
  }
  const failure = await refreshStorageUsage({ stat: async () => { throw Error('Read denied.'); } }, 'data.json', tracker);
  assert.equal(failure.dataBytes, null);
  const recovered = await refreshStorageUsage({ stat: async () => ({ type: 'file', size: 5000 }) }, 'data.json', tracker);
  assert.equal(recovered.sessionDeltaBytes, 5000);
  assert.equal(recovered.browserCacheBytes, null);
});


test('storage sizes use explicit binary units and keep missing readings unknown', () => {
  for (const value of [null, undefined, NaN, Infinity, -1, 1.5, '1024']) assert.equal(formatStorageBytes(value), '—');
  assert.equal(formatStorageBytes(0), '0 B');
  assert.equal(formatStorageBytes(1), '1 B');
  assert.equal(formatStorageBytes(1023), '1023 B');
  assert.equal(formatStorageBytes(1024), '1.0 KiB');
  assert.equal(formatStorageBytes(1536), '1.5 KiB');
  assert.equal(formatStorageBytes(1048576), '1.0 MiB');
  assert.equal(formatStorageBytes(1073741824), '1.0 GiB');
});

test('storage change formatting distinguishes growth, shrinkage and a valid zero', () => {
  assert.equal(formatStorageDelta(0), '0 B');
  assert.equal(formatStorageDelta(100), '+100 B');
  assert.equal(formatStorageDelta(2048), '+2.0 KiB');
  assert.equal(formatStorageDelta(-1024), '-1.0 KiB');
  assert.equal(formatStorageDelta(-1048576), '-1.0 MiB');
  for (const value of [null, undefined, NaN, Infinity, 1.25]) assert.equal(formatStorageDelta(value), '—');
});
