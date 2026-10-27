import assert from 'node:assert/strict';
import test from 'node:test';
import { createSharedHttpCacheProbe, SharedHttpCacheMonitor, SHARED_HTTP_CACHE_SCOPE, type SharedHttpCacheSnapshot } from '../src/shared-http-cache';

const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

test('native cache probe preserves Electron receivers and reads only the current session cache size', async () => {
  let calls = 0;
  const session = { async getCacheSize() { assert.equal(this, session); calls++; return 97595392; } };
  const remote = { getCurrentWebContents() { assert.equal(this, remote); return { session }; } };
  const probe = createSharedHttpCacheProbe((name: string) => { assert.equal(name, '@electron/remote'); return remote; });
  assert.equal(await probe(), 97595392);
  assert.equal(calls, 1);
});

test('native cache probe handles mobile, missing APIs and denied native access without fabricating zero', async () => {
  for (const load of [null, {}, () => undefined, () => ({}), () => ({ getCurrentWebContents: () => null }),
    () => ({ getCurrentWebContents: () => ({ session: {} }) }), () => { throw Error('Unavailable'); },
    () => ({ getCurrentWebContents: () => { throw Error('Denied'); } }),
    () => ({ getCurrentWebContents: () => ({ session: { getCacheSize: () => Promise.reject(Error('Unavailable')) } }) })]) {
    assert.equal(await createSharedHttpCacheProbe(load)(), null);
  }
});

test('native cache probe accepts zero and rejects negative, fractional, overflowing and nonnumeric counters', async () => {
  for (const value of [0, 1234, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, '12', null, undefined]) {
    const load = () => ({ getCurrentWebContents: () => ({ session: { getCacheSize: () => value } }) });
    assert.equal(await createSharedHttpCacheProbe(load)(), value === 0 || value === 1234 ? value : null);
  }
});

test('cache readings retain a session baseline and report growth and eviction separately from addon file bytes', async () => {
  let now = 0, bytes = 1024;
  const states: SharedHttpCacheSnapshot[] = [];
  const monitor = new SharedHttpCacheMonitor({ now: () => now, probe: () => bytes, onChange: value => states.push(value) });
  assert.equal(monitor.snapshot().available, false);
  assert.equal(monitor.snapshot().bytes, null);
  await monitor.sampleNow();
  assert.equal(monitor.snapshot().scope, SHARED_HTTP_CACHE_SCOPE);
  assert.equal(monitor.snapshot().sessionDeltaBytes, 0);
  now = 30000; bytes = 4096; await monitor.sampleNow();
  assert.equal(monitor.snapshot().sessionDeltaBytes, 3072);
  now = 60000; bytes = 0; await monitor.sampleNow();
  assert.equal(monitor.snapshot().available, true);
  assert.equal(monitor.snapshot().sessionDeltaBytes, -1024);
  assert.equal(monitor.snapshot().baselineBytes, 1024);
  assert.equal(states.length, 3);
});

test('cache probes are throttled for frequent chunk saves, including failures; force refreshes on demand', async () => {
  let now = 0, calls = 0;
  const monitor = new SharedHttpCacheMonitor({ now: () => now, probe: () => { calls++; throw Error('Unsupported'); } });
  await monitor.sampleNow();
  for (let i = 0; i < 100; i++) { now++; await monitor.sampleNow(); }
  assert.equal(calls, 1);
  assert.equal(monitor.snapshot().bytes, null);
  await monitor.sampleNow(true);
  assert.equal(calls, 2);
  now += 30000; await monitor.sampleNow();
  assert.equal(calls, 3);
});

test('temporary cache read failures remain unknown and recovery preserves the first baseline', async () => {
  let value: number | null = 1000;
  const monitor = new SharedHttpCacheMonitor({ probe: () => value });
  await monitor.sampleNow(true);
  value = null; await monitor.sampleNow(true);
  assert.equal(monitor.snapshot().available, false);
  assert.equal(monitor.snapshot().sessionDeltaBytes, null);
  assert.equal(monitor.snapshot().baselineBytes, 1000);
  value = 900; await monitor.sampleNow(true);
  assert.equal(monitor.snapshot().sessionDeltaBytes, -100);
});

test('overlapping cache reads are deduplicated, equal sizes do not redraw and UI errors are harmless', async () => {
  let resolve!: (bytes: number) => void;
  let calls = 0, changes = 0;
  const monitor = new SharedHttpCacheMonitor({ probe: () => { calls++; return new Promise<number>(done => { resolve = done; }); },
    onChange: () => { changes++; throw Error('UI'); } });
  const first = monitor.sampleNow(true), second = monitor.sampleNow(true);
  assert.equal(first, second);
  await flush(); assert.equal(calls, 1);
  resolve(200); await first;
  const next = monitor.sampleNow(true); await flush(); resolve(200); await next;
  assert.equal(changes, 1);
  assert.equal(monitor.snapshot().bytes, 200);
});

test('stop discards late native reads, and restarting cannot let an old completion clear a new pending read', async () => {
  const resolvers: ((value: number) => void)[] = [];
  let changes = 0;
  const monitor = new SharedHttpCacheMonitor({ probe: () => new Promise<number>(done => resolvers.push(done)), onChange: () => { changes++; } });
  const first = monitor.start(); await flush();
  monitor.stop();
  const ignored = await monitor.sampleNow(true);
  assert.equal(ignored.bytes, null);
  const restarted = monitor.start(); await flush();
  resolvers[0](500); await first;
  assert.equal(changes, 0);
  assert.equal(monitor.sampleNow(true), restarted);
  resolvers[1](600); await restarted;
  assert.equal(changes, 1);
  assert.equal(monitor.snapshot().baselineBytes, 600);
  monitor.stop();
});

test('start samples immediately then every 30 seconds and stop removes the timer', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  let now = 0, calls = 0;
  const monitor = new SharedHttpCacheMonitor({ now: () => now, probe: () => ++calls });
  await monitor.start();
  await monitor.start();
  assert.equal(calls, 1);
  now = 29999; context.mock.timers.tick(29999); await flush();
  assert.equal(calls, 1);
  now = 30000; context.mock.timers.tick(1); await flush();
  assert.equal(calls, 2);
  monitor.stop();
  now = 90000; context.mock.timers.tick(60000); await flush();
  assert.equal(calls, 2);
});
