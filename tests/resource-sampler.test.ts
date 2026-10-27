import assert from 'node:assert/strict';
import test from 'node:test';
import { createRendererResourceProbe, ResourceSampler, RESOURCE_SCOPE, type ResourceReading } from '../src/resource-sampler';

const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

test('renderer probe converts cumulative CPU and private memory without reading note data', async () => {
  let electronCpuCalls = 0;
  const process = {
    cpuUsage: () => ({ user: 2000000, system: 500000 }),
    getCPUUsage: () => { electronCpuCalls++; return { cumulativeCPUUsage: 99 }; },
    getProcessMemoryInfo: async () => ({ private: 2048, shared: 500 }),
  };
  assert.deepEqual(await createRendererResourceProbe(process)(), { cpuSeconds: 2.5, privateBytes: 2097152 });
  assert.equal(electronCpuCalls, 0);
});

test('renderer probe uses Electron cumulative fallback and tolerates unavailable or denied APIs', async () => {
  assert.deepEqual(await createRendererResourceProbe({ getCPUUsage: () => ({ cumulativeCPUUsage: 3 }) })(), { cpuSeconds: 3 });
  assert.deepEqual(await createRendererResourceProbe({ getCPUUsage: () => ({ percentCPUUsage: 70 }) })(), {});
  assert.deepEqual(await createRendererResourceProbe({ cpuUsage() { throw Error(); }, getProcessMemoryInfo() { throw Error(); } })(), {});
  assert.deepEqual(await createRendererResourceProbe(null)(), {});
});

test('sampler measures CPU over its own elapsed interval and labels process scope honestly', async () => {
  let now = 0, index = 0;
  const values: ResourceReading[] = [
    { cpuSeconds: 4, privateBytes: 100 * 1048576 },
    { cpuSeconds: 4.25, privateBytes: 120 * 1048576 },
    { cpuSeconds: 5.75, privateBytes: 110 * 1048576 },
    { cpuSeconds: 5.75, privateBytes: 105 * 1048576 },
  ];
  const sampler = new ResourceSampler({ now: () => now, probe: () => values[Math.min(index++, values.length - 1)], intervalMs: 10000 });
  sampler.start(); await sampler.sampleNow();
  assert.equal(sampler.snapshot().currentCpuPercent, null);
  now = 1000; await sampler.sampleNow();
  assert.equal(sampler.snapshot().currentCpuPercent, 25);
  now = 2000; await sampler.sampleNow();
  const sample = sampler.snapshot();
  assert.equal(sample.currentCpuPercent, 150); // Multiple process threads can exceed one core.
  assert.equal(sample.averageCpuPercent, 87.5);
  assert.equal(sample.peakCpuPercent, 150);
  assert.equal(sample.peakMemoryMb, 120);
  assert.equal(sample.memoryDeltaMb, 10);
  assert.equal(sample.scope, RESOURCE_SCOPE);
  const report = await sampler.stop();
  assert.equal(report.running, false);
  assert.equal(report.cpuTimeMs, 1750);
  assert.equal(report.elapsedMs, 2000);
  report.history[0].memoryMb = 1;
  assert.equal(sampler.report().history[0].memoryMb, 100);
});

test('unavailable samples stay unavailable rather than becoming zero or isolated plugin usage', async () => {
  let now = 0;
  const sampler = new ResourceSampler({ now: () => now, probe: () => ({}) });
  sampler.start(); await sampler.sampleNow();
  now = 1000; await sampler.sampleNow();
  const value = await sampler.stop();
  assert.equal(value.averageCpuPercent, null);
  assert.equal(value.currentMemoryMb, null);
  assert.equal(value.cpuTimeMs, null);
  assert.equal(value.samples, 3);
});

test('overlapping asynchronous sampling is deduplicated and reporting failures never interrupt work', async () => {
  let resolve!: (reading: ResourceReading) => void;
  let calls = 0;
  const sampler = new ResourceSampler({ probe: () => { calls++; return new Promise(done => { resolve = done; }); }, onChange: () => { throw Error('UI'); } });
  sampler.start(); await flush();
  const first = sampler.sampleNow(), second = sampler.sampleNow();
  assert.equal(first, second);
  assert.equal(calls, 1);
  resolve({ privateBytes: 1048576 }); await first;
  const stop = sampler.stop(); await flush(); resolve({ privateBytes: 1048576 }); await stop;
  assert.equal(sampler.snapshot().currentMemoryMb, 1);
});

test('probe rejections and invalid counters are harmless and CPU reset cannot create a negative load', async () => {
  let now = 0, index = 0;
  const sampler = new ResourceSampler({ now: () => now, probe: () => {
    const values = [{ cpuSeconds: 5 }, { cpuSeconds: 2, privateBytes: NaN }, { cpuSeconds: 3 }];
    return values[Math.min(index++, values.length - 1)];
  } });
  sampler.start(); await sampler.sampleNow();
  now = 1000; await sampler.sampleNow();
  assert.equal(sampler.snapshot().currentCpuPercent, null);
  now = 2000; await sampler.sampleNow();
  assert.equal(sampler.snapshot().currentCpuPercent, 100);
  await sampler.stop();
  const failing = new ResourceSampler({ probe: () => Promise.reject(Error('Unsupported')) });
  failing.start(); await failing.sampleNow(); await failing.stop();
  assert.equal(failing.snapshot().samples, 0);
});


test('short final samples do not manufacture CPU peaks and stopped reporting is explicit', async () => {
  let now = 0, cpu = 0;
  const states: boolean[] = [];
  const sampler = new ResourceSampler({ now: () => now, probe: () => ({ cpuSeconds: cpu }), onChange: value => states.push(value.running) });
  sampler.start(); await sampler.sampleNow();
  now = 1000; cpu = 0.25; await sampler.sampleNow();
  now = 1000.01; cpu = 0.2501;
  const report = await sampler.stop();
  assert.equal(report.peakCpuPercent, 25);
  assert.equal(report.currentCpuPercent, 25);
  assert.equal(states.at(-1), false);
  assert.ok(report.averageCpuPercent! > 25 && report.averageCpuPercent! < 26);
});

test('sample history is bounded while aggregate counters retain the whole session and restart resets it', async () => {
  let now = 0;
  const sampler = new ResourceSampler({ now: () => now, probe: () => ({ cpuSeconds: now / 2000, privateBytes: 1048576 }), intervalMs: 10000 });
  sampler.start(); await sampler.sampleNow();
  for (let index = 1; index <= 1850; index++) { now = index * 1000; await sampler.sampleNow(); }
  const report = await sampler.stop();
  assert.equal(report.history.length, 1800);
  assert.equal(report.samples, 1852);
  assert.equal(report.elapsedMs, 1850000);
  assert.equal(report.averageCpuPercent, 50);
  sampler.start(); await sampler.sampleNow();
  assert.equal(sampler.snapshot().samples, 1);
  assert.equal(sampler.snapshot().averageCpuPercent, null);
  await sampler.stop();
});
