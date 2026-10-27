import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FeatureCollection } from '../src/contracts';
import type { TripQueueSnapshot } from '../src/trip-queue';
import type { ResourceSnapshot } from '../src/resource-sampler';
import type { StorageSnapshot } from '../src/storage-usage';
import type { SharedHttpCacheSnapshot } from '../src/shared-http-cache';
import { getRoadRouteProgress, RouteStatusControl } from '../src/route-status-control';

const feature = (connectionKind?: string): FeatureCollection['features'][number] => ({
  type: 'Feature', properties: connectionKind ? { connectionKind } : {},
  geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
});
const data = (...kinds: Array<string | undefined>): FeatureCollection => ({ type: 'FeatureCollection', features: kinds.map(feature) });

test('road progress counts connection legs without counting access connectors', () => {
  assert.deepEqual(getRoadRouteProgress(data('road', 'connector', 'connector', 'fallback', undefined)), { routed: 1, total: 3, missing: 2 });
  assert.deepEqual(getRoadRouteProgress(data('road', 'connector')), { routed: 1, total: 1, missing: 0 });
  assert.deepEqual(getRoadRouteProgress(data()), { routed: 0, total: 0, missing: 0 });
});

class FakeDocument {
  createElement(tag: string): FakeElement { return new FakeElement(tag, this); }
}
class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  listeners = new Map<string, (event: { stopPropagation(): void }) => void>();
  className = '';
  private text = '';
  textWrites = 0;
  get textContent(): string { return this.text; }
  set textContent(value: string) { this.text = value; this.textWrites++; }
  title = '';
  open = false;
  hidden = false;
  disabled = false;
  type = '';
  constructor(readonly tag: string, readonly ownerDocument: FakeDocument) {}
  setAttribute(key: string, value: string): void { this.attributes[key] = value; }
  append(...children: FakeElement[]): void {
    for (const child of children) { child.parent = this; this.children.push(child); }
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  addEventListener(name: string, listener: (event: { stopPropagation(): void }) => void): void { this.listeners.set(name, listener); }
  click(): void { this.listeners.get('click')?.({ stopPropagation() {} }); }
}
const host = (): FakeElement => new FakeDocument().createElement('div');
const element = (host: FakeElement): HTMLElement => host as unknown as HTMLElement;

test('status control starts compact and shows safe diagnostics only inside collapsed help', () => {
  const control = new RouteStatusControl();
  const container = host();
  const status = '<img src=x onerror=alert(1)>';
  control.update(element(container), data('road', 'fallback'), true, status, () => {});
  const root = container.children[0];
  const [header, preparation, details] = root.children;
  assert.equal(root.className, 'obsidian-maps-directions-route-status');
  assert.equal(root.attributes['aria-label'], 'Road routing status');
  assert.equal(header.children[0].textContent, 'Road routes: 1/2');
  assert.equal(header.children[1].textContent, 'Prepare road routes');
  assert.equal(header.children[1].title, 'Load detailed map areas in the background and save found walking paths.');
  assert.equal(details.open, false);
  assert.equal(preparation.hidden, true);
  assert.equal(details.children[0].textContent, 'Why dashed lines?');
  assert.match(details.children[1].textContent, /loads detailed map areas in the background/);
  assert.match(details.children[1].textContent, /Internet is needed for areas absent from Maps cache/);
  assert.match(details.children[1].textContent, /ferry or flight legs/);
  assert.equal(details.children[2].textContent, status);
});

test('status control refreshes callbacks without rebuilding or resetting expanded help', () => {
  const control = new RouteStatusControl();
  const container = host();
  let oldClicks = 0, newClicks = 0;
  control.update(element(container), data('fallback'), true, 'Waiting.', () => oldClicks++);
  const root = container.children[0];
  const button = root.children[0].children[1];
  const details = root.children[2];
  details.open = true;
  button.click();
  control.update(element(container), data('fallback'), true, 'Waiting.', () => newClicks++);
  button.click();
  assert.equal(oldClicks, 1);
  assert.equal(newClicks, 1);
  assert.equal(container.children[0], root);
  assert.equal(root.children[2], details);
  assert.equal(details.open, true);
  control.update(element(container), data('road', 'fallback'), true, 'Updated.', () => newClicks++);
  assert.equal(root.children[0].children[0].textContent, 'Road routes: 1/2');
  assert.equal(details.children[2].textContent, 'Updated.');
  assert.equal(details.open, true);
});

test('prepare button hides without missing legs or preparation capability and stale actions are released', () => {
  const control = new RouteStatusControl();
  const container = host();
  let clicks = 0;
  control.update(element(container), data('fallback'), true, '', () => clicks++);
  const root = container.children[0], button = root.children[0].children[1];
  control.update(element(container), data('road'), true, '', () => clicks++);
  assert.equal(button.hidden, true);
  assert.equal(button.style.display, 'none');
  assert.equal(button.disabled, true);
  button.click();
  assert.equal(clicks, 0);
  control.update(element(container), data('fallback'), true, '', null);
  assert.equal(button.hidden, true);
  assert.equal(button.style.display, 'none');
  control.update(element(container), data('fallback'), true, '', () => clicks++);
  assert.equal(button.hidden, false);
  assert.equal(button.style.display, '');
  button.click();
  assert.equal(clicks, 1);
  control.destroy();
  button.click();
  assert.equal(clicks, 1);
});

test('status control hides for straight mode, empty data, missing map, and cleans old map hosts', () => {
  const control = new RouteStatusControl();
  const first = host(), second = host();
  control.update(element(first), data('fallback'), true, '', () => {});
  control.update(element(second), data('fallback'), true, '', () => {});
  assert.equal(first.children.length, 0);
  assert.equal(second.children.length, 1);
  control.update(element(second), data('fallback'), false, '', () => {});
  assert.equal(second.children.length, 0);
  control.update(element(first), data('fallback'), true, '', () => {});
  control.update(element(first), data('connector'), true, '', () => {});
  assert.equal(first.children.length, 0);
  control.update(element(first), data('fallback'), true, '', () => {});
  control.update(null, data('fallback'), true, '', () => {});
  assert.equal(first.children.length, 0);
  control.destroy();
});

test('status control gestures stay separate from map pan and zoom', () => {
  const control = new RouteStatusControl();
  const container = host();
  control.update(element(container), data('fallback'), true, '', null);
  const root = container.children[0];
  let stopped = 0;
  for (const name of ['mousedown', 'pointerdown', 'touchstart', 'wheel', 'click', 'dblclick', 'keydown']) root.listeners.get(name)!({ stopPropagation: () => stopped++ });
  assert.equal(stopped, 7);
});


test('preparation shows area progress and switches the single action to cancellation', () => {
  const control = new RouteStatusControl();
  const container = host();
  let starts = 0, cancels = 0;
  const start = () => starts++, cancel = () => cancels++;
  control.update(element(container), data('fallback'), true, 'Ready.', start);
  const root = container.children[0], button = root.children[0].children[1], progress = root.children[1], details = root.children[2];
  details.open = true;
  button.click();
  assert.equal(starts, 1);
  control.update(element(container), data('road', 'fallback'), true, 'Preparing.', start, { running: true, completed: 3, total: 10 }, cancel);
  assert.equal(button.textContent, 'Cancel');
  assert.equal(button.hidden, false);
  assert.equal(button.style.display, '');
  assert.equal(button.disabled, false);
  assert.equal(progress.hidden, false);
  assert.equal(progress.textContent, 'Preparing roads: 3/10 areas');
  assert.equal(progress.attributes.role, 'status');
  assert.equal(root.children[0].children[0].textContent, 'Road routes: 1/2');
  button.click();
  assert.equal(starts, 1);
  assert.equal(cancels, 1);
  control.update(element(container), data('road'), true, 'Done.', start, { running: false, completed: 10, total: 10, message: 'Prepared. 1/1 connections follow roads.' });
  assert.equal(button.hidden, true);
  assert.equal(button.style.display, 'none');
  assert.equal(progress.textContent, 'Prepared. 1/1 connections follow roads.');
  assert.equal(details.open, true);
  assert.equal(container.children[0], root);
});

test('running preparation keeps cancellation available when all paths have been found and refreshes callbacks', () => {
  const control = new RouteStatusControl();
  const container = host();
  let cancels = 0;
  const preparation = { running: true, completed: 3, total: 10 };
  control.update(element(container), data('road'), true, '', null, preparation);
  const button = container.children[0].children[0].children[1];
  assert.equal(button.textContent, 'Cancel');
  assert.equal(button.hidden, false);
  assert.equal(button.style.display, '');
  assert.equal(button.disabled, true);
  control.update(element(container), data('road'), true, '', null, preparation, () => cancels++);
  assert.equal(button.disabled, false);
  button.click();
  assert.equal(cancels, 1);
  control.update(element(container), data('road'), true, '', null, preparation, () => cancels += 2);
  button.click();
  assert.equal(cancels, 3);
  control.destroy();
  button.click();
  assert.equal(cancels, 3);
});

test('automatic section work shows its saved section progress while keeping Pause available', () => {
  const control = new RouteStatusControl(), container = host();
  const message = 'Preparing smaller sections: 4/12 saved (attempt 2/3).';
  control.update(element(container), data('fallback'), true, '', () => {},
    { running: true, completed: 4, total: 12, unit: 'sections', message }, () => {}, true, tripSnapshot());
  const root = container.children[0];
  assert.equal(root.children[1].textContent, message);
  assert.equal(root.children[0].children[1].textContent, 'Pause');
});

test('completed preparation message is safe text and normal preparation can be retried', () => {
  const control = new RouteStatusControl();
  const container = host();
  let starts = 0;
  const message = '<img src=x onerror=alert(1)>';
  control.update(element(container), data('fallback'), true, 'Details.', () => starts++, { running: false, completed: 2, total: 2, message });
  const root = container.children[0], button = root.children[0].children[1];
  assert.equal(root.children[1].textContent, message);
  assert.equal(button.textContent, 'Prepare road routes');
  assert.equal(button.hidden, false);
  assert.equal(button.style.display, '');
  button.click();
  assert.equal(starts, 1);
});

test('automatic mode shows saved progress immediately without requiring a prepare button', () => {
  const control = new RouteStatusControl();
  const container = host();
  let starts = 0;
  control.update(element(container), data('road', 'fallback'), true, 'Saved paths restored.', () => starts++, undefined, undefined, true);
  const root = container.children[0], button = root.children[0].children[1], details = root.children[2];
  assert.equal(root.children[0].children[0].textContent, 'Road routes: 1/2');
  assert.equal(button.hidden, true);
  assert.equal(button.style.display, 'none');
  assert.equal(button.disabled, true);
  button.click();
  assert.equal(starts, 0);
  assert.match(details.children[1].textContent, /Saved paths appear immediately/);
  assert.match(details.children[1].textContent, /prepared automatically in the background/);
  assert.match(details.children[1].textContent, /Internet is needed for areas absent from Maps cache/);
});

test('automatic mode keeps progress and cancellation while work runs and hides preparation after it ends', () => {
  const control = new RouteStatusControl();
  const container = host();
  let starts = 0, cancels = 0;
  const start = () => starts++;
  control.update(element(container), data('road', 'fallback'), true, 'Preparing.', start,
    { running: true, completed: 3, total: 8 }, () => cancels++, true);
  const root = container.children[0], button = root.children[0].children[1];
  assert.equal(button.hidden, false);
  assert.equal(button.style.display, '');
  assert.equal(button.textContent, 'Cancel');
  assert.equal(root.children[1].textContent, 'Preparing roads: 3/8 areas');
  button.click();
  assert.equal(cancels, 1);
  assert.equal(starts, 0);
  control.update(element(container), data('road', 'fallback'), true, 'Done.', start,
    { running: false, completed: 8, total: 8, message: 'Prepared. Missing connections remain dashed.' }, undefined, true);
  assert.equal(button.hidden, true);
  assert.equal(button.style.display, 'none');
  assert.equal(button.disabled, true);
  assert.equal(root.children[1].textContent, 'Prepared. Missing connections remain dashed.');
  button.click();
  assert.equal(starts, 0);
});

test('switching automatic preparation off restores the manual action without rebuilding the control', () => {
  const control = new RouteStatusControl();
  const container = host();
  let starts = 0;
  const start = () => starts++;
  control.update(element(container), data('fallback'), true, 'Waiting.', start, undefined, undefined, true);
  const root = container.children[0], details = root.children[2], button = root.children[0].children[1];
  details.open = true;
  control.update(element(container), data('fallback'), true, 'Waiting.', start, undefined, undefined, false);
  assert.equal(container.children[0], root);
  assert.equal(details.open, true);
  assert.equal(button.hidden, false);
  assert.equal(button.style.display, '');
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Prepare road routes');
  assert.match(details.children[1].textContent, /^Prepare road routes loads/);
  button.click();
  assert.equal(starts, 1);
  control.update(element(container), data('fallback'), true, 'Waiting.', start, undefined, undefined, true);
  button.click();
  assert.equal(starts, 1);
});


const tripSnapshot = (changes: Partial<TripQueueSnapshot> = {}): TripQueueSnapshot => ({
  total: 10, processed: 7, ready: 2, noPath: 3, unavailable: 2,
  paused: 0, queued: 2, preparing: 1, percentComplete: 70,
  percentRemaining: 30, areasProcessed: 8, areasTotal: 20, ...changes,
});
const resourceSnapshot = (changes: Partial<ResourceSnapshot> = {}): ResourceSnapshot => ({
  scope: 'Obsidian window process (includes other plugins)', running: true, elapsedMs: 4000,
  samples: 4, currentCpuPercent: 143.25, averageCpuPercent: 120, peakCpuPercent: 164,
  currentMemoryMb: 1024.4, baselineMemoryMb: 900, peakMemoryMb: 1100,
  memoryDeltaMb: 124.4, cpuTimeMs: 4800, ...changes,
});

test('durable queue percentage measures processed connections independently from road routes found', () => {
  const control = new RouteStatusControl(), container = host();
  control.update(element(container), data('road', 'road', ...Array(8).fill('fallback')), true, 'Processing.', null,
    { running: true, completed: 2, total: 4 }, () => {}, true, tripSnapshot(), resourceSnapshot(), 'Eco');
  const root = container.children[0], header = root.children[0], details = root.children[2];
  assert.equal(header.children[0].textContent, 'Road routes: 2/10 eligible');
  assert.equal(header.children[2].textContent, 'Processed 7/10 eligible connections (70%) · Remaining: 3 (30%) · Skipped by distance: 0');
  assert.equal(header.children[2].attributes.role, 'status');
  assert.equal(root.children[1].textContent, 'Preparing roads: 2/4 areas');
  assert.match(details.children[1].textContent, /does not mean every route was found/);
  assert.match(details.children[3].textContent, /Queued: 2/);
  assert.match(details.children[3].textContent, /Preparing: 1/);
  assert.match(details.children[3].textContent, /Ready: 2/);
  assert.match(details.children[3].textContent, /No path: 3/);
  assert.match(details.children[3].textContent, /Data unavailable: 2/);
  assert.match(details.children[3].textContent, /Paused: 0/);
  assert.equal(header.children[3].textContent, 'Eco · Window CPU 143.3% · Window RAM 1024 MiB');
  assert.match(header.children[3].title, /includes other plugins/);
  assert.match(header.children[3].title, /GPU excluded/);
  assert.match(header.children[3].title, /100% means one logical core/);
});

test('queue Pause and Resume preserve completed progress and work in automatic mode', () => {
  const control = new RouteStatusControl(), container = host();
  let pauses = 0, resumes = 0;
  const resume = () => resumes++, pause = () => pauses++;
  control.update(element(container), data('road', 'fallback'), true, '', resume,
    { running: true, completed: 2, total: 3 }, pause, true, tripSnapshot());
  const root = container.children[0], header = root.children[0], button = header.children[1];
  assert.equal(button.textContent, 'Pause');
  assert.match(button.title, /queue progress are saved/);
  button.click();
  assert.equal(pauses, 1);
  const paused = tripSnapshot({ preparing: 0, queued: 0, paused: 3 });
  const reason = '<b>Working data limit reached</b>';
  control.update(element(container), data('road', 'fallback'), true, '', resume,
    { running: false, completed: 2, total: 3, message: reason }, pause, true, paused);
  assert.equal(button.textContent, 'Resume');
  assert.equal(button.hidden, false);
  assert.equal(button.style.display, '');
  assert.match(button.title, /current workload settings/);
  assert.equal(root.children[1].textContent, reason);
  assert.equal(header.children[2].textContent, 'Processed 7/10 eligible connections (70%) · Remaining: 3 (30%) · Skipped by distance: 0');
  button.click();
  assert.equal(resumes, 1);
  assert.equal(pauses, 1);
  control.destroy();
  button.click();
  assert.equal(resumes, 1);
});

test('finished queue can show zero percent remaining while some routes remain unresolved', () => {
  const control = new RouteStatusControl(), container = host();
  const finished = tripSnapshot({ processed: 10, noPath: 6, queued: 0, preparing: 0, paused: 0, percentComplete: 100, percentRemaining: 0 });
  control.update(element(container), data('road', 'road', ...Array(8).fill('fallback')), true, '', () => {},
    { running: false, completed: 4, total: 4 }, undefined, true, finished, undefined, 'Eco');
  const header = container.children[0].children[0];
  assert.equal(header.children[0].textContent, 'Road routes: 2/10 eligible');
  assert.equal(header.children[2].textContent, 'Processed 10/10 eligible connections (100%) · Remaining: 0 (0%) · Skipped by distance: 0');
  assert.equal(header.children[1].hidden, true);
  assert.equal(header.children[1].style.display, 'none');
  assert.equal(header.children[3].textContent, 'Eco · Window CPU — · Window RAM —');
  control.update(element(container), data('road', 'road', ...Array(8).fill('fallback')), true, '', () => {},
    undefined, undefined, false, finished);
  assert.equal(header.children[1].hidden, true);
  assert.equal(header.children[1].style.display, 'none');
});

test('resource readings update without rebuilding the queue or mislabelling unavailable values', () => {
  const control = new RouteStatusControl(), container = host();
  control.update(element(container), data('fallback'), true, '', null, undefined, undefined, true,
    tripSnapshot(), resourceSnapshot({ currentCpuPercent: null, currentMemoryMb: null }), 'Eco');
  const root = container.children[0], header = root.children[0];
  assert.equal(header.children[3].textContent, 'Eco · Window CPU — · Window RAM —');
  const details = root.children[2]; details.open = true;
  control.update(element(container), data('fallback'), true, '', null, undefined, undefined, true,
    tripSnapshot({ percentRemaining: 29.4 }), resourceSnapshot({ currentCpuPercent: 205.05, currentMemoryMb: 1500.6 }), 'Balanced');
  assert.equal(container.children[0], root);
  assert.equal(root.children[2], details);
  assert.equal(details.open, true);
  assert.equal(header.children[2].textContent, 'Processed 7/10 eligible connections (70%) · Remaining: 3 (29.4%) · Skipped by distance: 0');
  assert.equal(header.children[3].textContent, 'Balanced · Window CPU 205.1% · Window RAM 1501 MiB');
  control.update(element(container), data('fallback'), true, '', null, undefined, undefined, true,
    tripSnapshot(), resourceSnapshot({ currentCpuPercent: NaN, currentMemoryMb: -1 }), '<img src=x>');
  assert.equal(header.children[3].textContent, '<img src=x> · Window CPU — · Window RAM —');
  control.update(element(container), data('fallback'), true, '', null);
  assert.equal(header.children[2].hidden, true);
  assert.equal(header.children[2].style.display, 'none');
  assert.equal(header.children[3].hidden, true);
  assert.equal(header.children[3].style.display, 'none');
});


const storageSnapshot = (changes: Partial<StorageSnapshot> = {}): StorageSnapshot => ({
  scope: 'Maps Directions data.json (logical file size)', available: true,
  dataBytes: 1048576, baselineBytes: 1044480, sessionDeltaBytes: 4096,
  measuredAt: 1, browserCacheBytes: null, ...changes,
});

test('saved data HUD shows own file size and growth with the shared HTTP cache explicitly excluded', () => {
  const control = new RouteStatusControl(), container = host();
  control.update(element(container), data('road'), true, '', null, undefined, undefined, true,
    tripSnapshot(), resourceSnapshot(), 'Eco', storageSnapshot());
  const root = container.children[0], header = root.children[0], saved = header.children[4];
  assert.equal(saved.textContent, 'Saved data 1.0 MiB · +4.0 KiB this session');
  assert.equal(saved.hidden, false);
  assert.equal(saved.style.display, '');
  assert.match(saved.title, /Logical size of the addon data.json file only/);
  assert.match(saved.title, /Shared browser\/map HTTP cache is excluded here/);
  assert.match(saved.title, /this plugin session started/);
  assert.equal(header.children[3].textContent, 'Eco · Window CPU 143.3% · Window RAM 1024 MiB');
});

test('unknown and shrinking saved data stay distinct from a measured zero without inserting HTML', () => {
  const control = new RouteStatusControl(), container = host();
  const update = (storage?: StorageSnapshot) => control.update(element(container), data('fallback'), true, '', null,
    undefined, undefined, true, tripSnapshot(), undefined, 'Eco', storage);
  update(storageSnapshot({ available: false, dataBytes: null, sessionDeltaBytes: null, scope: '<img src=x onerror=alert(1)>' }));
  const root = container.children[0], header = root.children[0], saved = header.children[4];
  assert.equal(saved.textContent, 'Saved data — · — this session');
  assert.equal(saved.children.length, 0);
  assert.equal(header.children.length, 6);
  update(storageSnapshot({ dataBytes: 1047552, sessionDeltaBytes: -1024 }));
  assert.equal(saved.textContent, 'Saved data 1023.0 KiB · -1.0 KiB this session');
  update(storageSnapshot({ dataBytes: 0, sessionDeltaBytes: 0 }));
  assert.equal(saved.textContent, 'Saved data 0 B · 0 B this session');
  update();
  assert.equal(saved.hidden, true);
  assert.equal(saved.style.display, 'none');
  assert.equal(saved.textContent, '');
});

test('unchanged storage bytes cause no text writes or rebuilt controls and preserve expanded help', () => {
  const control = new RouteStatusControl(), container = host();
  const update = (storage: StorageSnapshot) => control.update(element(container), data('fallback'), true, 'Waiting.', null,
    undefined, undefined, true, tripSnapshot(), resourceSnapshot(), 'Eco', storage);
  update(storageSnapshot());
  const root = container.children[0], header = root.children[0], details = root.children[2], saved = header.children[4];
  const writes = saved.textWrites;
  details.open = true;
  update(storageSnapshot({ measuredAt: 50 }));
  assert.equal(saved.textWrites, writes);
  assert.equal(container.children[0], root);
  assert.equal(root.children[0], header);
  assert.equal(header.children[4], saved);
  assert.equal(root.children[2], details);
  assert.equal(details.open, true);
  update(storageSnapshot({ dataBytes: 2097152, sessionDeltaBytes: 1052672 }));
  assert.equal(saved.textContent, 'Saved data 2.0 MiB · +1.0 MiB this session');
  assert.ok(saved.textWrites > writes);
  assert.equal(details.open, true);
});

test('distance-limited direct connections are excluded from progress without road success or a preparation action', () => {
  const control = new RouteStatusControl(), container = host();
  let clicks = 0;
  const finished = tripSnapshot({ total: 2, eligible: 0, processed: 0, ready: 0, direct: 2, noPath: 0, unavailable: 0,
    paused: 0, queued: 0, preparing: 0, percentComplete: 100, percentRemaining: 0, areasProcessed: 0, areasTotal: 0 });
  control.update(element(container), data('direct', 'direct'), true, 'Above the selected distance limit.', () => clicks++,
    undefined, undefined, false, finished, undefined, 'Eco', storageSnapshot());
  const root = container.children[0], header = root.children[0], button = header.children[1], details = root.children[2];
  assert.equal(header.children[0].textContent, 'Road routes: 0/0 eligible');
  assert.equal(header.children[2].textContent, 'Processed 0/0 eligible connections (100%) · Remaining: 0 (0%) · Skipped by distance: 2');
  assert.match(details.children[3].textContent, /Ready: 0/);
  assert.match(details.children[3].textContent, /Skipped by distance: 2/);
  assert.match(details.children[3].textContent, /No path: 0/);
  assert.match(details.children[3].textContent, /Data unavailable: 0/);
  assert.match(details.children[1].textContent, /above the distance limit are excluded from progress/);
  assert.equal(button.hidden, true);
  assert.equal(button.style.display, 'none');
  assert.equal(button.disabled, true);
  button.click();
  assert.equal(clicks, 0);
});

test('mixed distance exclusions show eligible totals, remaining work and completion independently', () => {
  const control = new RouteStatusControl(), container = host();
  const update = (queue: TripQueueSnapshot) => control.update(element(container), data('road', 'fallback', 'direct', 'direct'), true, '', () => {},
    undefined, undefined, true, queue);
  update(tripSnapshot({ total: 4, eligible: 2, direct: 2, processed: 1, ready: 1, noPath: 0, unavailable: 0,
    queued: 0, preparing: 0, paused: 1, percentComplete: 50, percentRemaining: 50 }));
  const header = container.children[0].children[0];
  assert.equal(header.children[0].textContent, 'Road routes: 1/2 eligible');
  assert.equal(header.children[2].textContent, 'Processed 1/2 eligible connections (50%) · Remaining: 1 (50%) · Skipped by distance: 2');
  assert.equal(header.children[1].textContent, 'Resume');
  assert.equal(header.children[1].hidden, false);
  update(tripSnapshot({ total: 4, eligible: 2, direct: 2, processed: 2, ready: 1, noPath: 1, unavailable: 0,
    queued: 0, preparing: 0, paused: 0, percentComplete: 100, percentRemaining: 0 }));
  assert.equal(header.children[2].textContent, 'Processed 2/2 eligible connections (100%) · Remaining: 0 (0%) · Skipped by distance: 2');
  assert.equal(header.children[1].hidden, true);
});

test('shared geometry rendered by several groups uses the same deduplicated queue count for found and eligible paths', () => {
  const control = new RouteStatusControl(), container = host();
  const queue = tripSnapshot({ total: 1, eligible: 1, processed: 1, ready: 1, direct: 0,
    noPath: 0, unavailable: 0, queued: 0, preparing: 0, paused: 0, percentComplete: 100, percentRemaining: 0 });
  control.update(element(container), data('road', 'road'), true, '', null, undefined, undefined, true, queue);
  const header = container.children[0].children[0];
  assert.equal(header.children[0].textContent, 'Road routes: 1/1 eligible');
  assert.equal(header.children[2].textContent, 'Processed 1/1 eligible connections (100%) · Remaining: 0 (0%) · Skipped by distance: 0');
  control.update(element(container), data('road', 'road'), true, '', null);
  assert.equal(header.children[0].textContent, 'Road routes: 2/2');
});

const sharedCacheSnapshot = (changes: Partial<SharedHttpCacheSnapshot> = {}): SharedHttpCacheSnapshot => ({
  scope: 'Shared Obsidian HTTP cache (includes Maps and other plugins)', available: true,
  bytes: 104857600, baselineBytes: 103809024, sessionDeltaBytes: 1048576, measuredAt: 1, ...changes,
});

test('shared HTTP cache is displayed separately with shared attribution and safe unavailable readings', () => {
  const control = new RouteStatusControl(), container = host();
  const update = (shared?: SharedHttpCacheSnapshot) => control.update(element(container), data('road'), true, '', null,
    undefined, undefined, true, tripSnapshot(), undefined, 'Eco', storageSnapshot(), shared);
  update(sharedCacheSnapshot());
  const header = container.children[0].children[0], cache = header.children[5];
  assert.equal(cache.textContent, 'Shared HTTP cache 100.0 MiB · +1.0 MiB this session');
  assert.equal(header.children[4].textContent, 'Saved data 1.0 MiB · +4.0 KiB this session');
  assert.match(cache.title, /current browser session/);
  assert.match(cache.title, /unrelated plugins\/resources/);
  assert.match(cache.title, /cannot be attributed to Maps Directions alone/);
  update(sharedCacheSnapshot({ bytes: null, sessionDeltaBytes: null, available: false }));
  assert.equal(cache.textContent, 'Shared HTTP cache — · — this session');
  update(sharedCacheSnapshot({ bytes: 0, sessionDeltaBytes: -1048576 }));
  assert.equal(cache.textContent, 'Shared HTTP cache 0 B · -1.0 MiB this session');
  update();
  assert.equal(cache.hidden, true);
  assert.equal(cache.style.display, 'none');
  assert.equal(cache.textContent, '');
});
