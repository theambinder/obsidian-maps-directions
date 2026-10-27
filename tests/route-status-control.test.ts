import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FeatureCollection } from '../src/contracts';
import type { TripQueueSnapshot } from '../src/trip-queue';
import type { ResourceSnapshot } from '../src/resource-sampler';
import type { StorageSnapshot } from '../src/storage-usage';
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
const part = (element: FakeElement, name: string): FakeElement => {
  const classes: Record<string, string> = {
    header: 'obsidian-maps-directions-status-header', count: 'obsidian-maps-directions-route-count',
    button: 'obsidian-maps-directions-status-action', preparation: 'obsidian-maps-directions-preparation-progress',
    details: 'obsidian-maps-directions-status-details', summary: 'obsidian-maps-directions-queue-progress',
    help: 'obsidian-maps-directions-routing-help', diagnostic: 'obsidian-maps-directions-routing-detail',
    counts: 'obsidian-maps-directions-queue-counts', work: 'obsidian-maps-directions-work-detail',
    resources: 'obsidian-maps-directions-resource-status', storage: 'obsidian-maps-directions-storage-status',
    skipped: 'obsidian-maps-directions-skipped-status', body: 'obsidian-maps-directions-status-body',
  };
  let root = element;
  while (root.parent && root.className !== 'obsidian-maps-directions-route-status') root = root.parent;
  const find = (node: FakeElement): FakeElement | undefined => node.className === classes[name] ? node : node.children.map(find).find(Boolean);
  const found = find(root);
  assert.ok(found, `Missing status part: ${name}`);
  return found;
};


test('status control starts compact and shows safe diagnostics only inside collapsed help', () => {
  const control = new RouteStatusControl();
  const container = host();
  const status = '<img src=x onerror=alert(1)>';
  control.update(element(container), data('road', 'fallback'), true, status, () => {});
  const root = container.children[0];
  const header = part(root, 'header'), preparation = part(root, 'preparation'), details = part(root, 'details');
  assert.equal(root.className, 'obsidian-maps-directions-route-status');
  assert.equal(root.attributes['aria-label'], 'Road routing status');
  assert.equal(part(header, 'count').textContent, 'Road routes: 1/2');
  assert.equal(part(header, 'button').textContent, 'Prepare road routes');
  assert.equal(part(header, 'button').title, 'Load detailed map areas in the background and save found walking paths.');
  assert.equal(details.open, false);
  assert.equal(preparation.hidden, true);
  assert.equal(part(details, 'summary').textContent, '1/2 road routes found');
  assert.match(part(details, 'help').textContent, /loads detailed map areas in the background/);
  assert.match(part(details, 'help').textContent, /Internet is needed for areas absent from Maps cache/);
  assert.match(part(details, 'help').textContent, /ferry or flight legs/);
  assert.equal(part(details, 'diagnostic').textContent, status);
});

test('status control refreshes callbacks without rebuilding or resetting expanded help', () => {
  const control = new RouteStatusControl();
  const container = host();
  let oldClicks = 0, newClicks = 0;
  control.update(element(container), data('fallback'), true, 'Waiting.', () => oldClicks++);
  const root = container.children[0];
  const button = part(root, 'button');
  const details = part(root, 'details');
  details.open = true;
  button.click();
  control.update(element(container), data('fallback'), true, 'Waiting.', () => newClicks++);
  button.click();
  assert.equal(oldClicks, 1);
  assert.equal(newClicks, 1);
  assert.equal(container.children[0], root);
  assert.equal(part(root, 'details'), details);
  assert.equal(details.open, true);
  control.update(element(container), data('road', 'fallback'), true, 'Updated.', () => newClicks++);
  assert.equal(part(root, 'count').textContent, 'Road routes: 1/2');
  assert.equal(part(details, 'diagnostic').textContent, 'Updated.');
  assert.equal(details.open, true);
});

test('prepare button hides without missing legs or preparation capability and stale actions are released', () => {
  const control = new RouteStatusControl();
  const container = host();
  let clicks = 0;
  control.update(element(container), data('fallback'), true, '', () => clicks++);
  const root = container.children[0], button = part(root, 'button');
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


test('preparation keeps a short status and shows area progress in Details while cancellation stays available', () => {
  const control = new RouteStatusControl();
  const container = host();
  let starts = 0, cancels = 0;
  const start = () => starts++, cancel = () => cancels++;
  control.update(element(container), data('fallback'), true, 'Ready.', start);
  const root = container.children[0], button = part(root, 'button'), progress = part(root, 'preparation'), details = part(root, 'details');
  details.open = true;
  button.click();
  assert.equal(starts, 1);
  control.update(element(container), data('road', 'fallback'), true, 'Preparing.', start, { running: true, completed: 3, total: 10 }, cancel);
  assert.equal(button.textContent, 'Cancel');
  assert.equal(button.hidden, false);
  assert.equal(button.style.display, '');
  assert.equal(button.disabled, false);
  assert.equal(progress.hidden, false);
  assert.equal(progress.textContent, 'Preparing roads…');
  assert.equal(part(details, 'work').textContent, 'Preparing roads: 3/10 areas');
  assert.equal(progress.attributes.role, 'status');
  assert.equal(part(root, 'count').textContent, 'Road routes: 1/2');
  button.click();
  assert.equal(starts, 1);
  assert.equal(cancels, 1);
  control.update(element(container), data('road'), true, 'Done.', start, { running: false, completed: 10, total: 10, message: 'Prepared. 1/1 connections follow roads.' });
  assert.equal(button.hidden, true);
  assert.equal(button.style.display, 'none');
  assert.equal(progress.textContent, 'Finished');
  assert.equal(part(details, 'work').textContent, 'Prepared. 1/1 connections follow roads.');
  assert.equal(details.open, true);
  assert.equal(container.children[0], root);
});

test('running preparation keeps cancellation available when all paths have been found and refreshes callbacks', () => {
  const control = new RouteStatusControl();
  const container = host();
  let cancels = 0;
  const preparation = { running: true, completed: 3, total: 10 };
  control.update(element(container), data('road'), true, '', null, preparation);
  const button = part(container.children[0], 'button');
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
  assert.equal(part(root, 'preparation').textContent, 'Preparing roads…');
  assert.equal(part(root, 'work').textContent, message);
  assert.equal(part(root, 'button').textContent, 'Pause');
});

test('completed preparation message is safe text and normal preparation can be retried', () => {
  const control = new RouteStatusControl();
  const container = host();
  let starts = 0;
  const message = '<img src=x onerror=alert(1)>';
  control.update(element(container), data('fallback'), true, 'Details.', () => starts++, { running: false, completed: 2, total: 2, message });
  const root = container.children[0], button = part(root, 'button');
  assert.equal(part(root, 'preparation').textContent, 'Finished · 1 unresolved');
  assert.equal(part(root, 'work').textContent, message);
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
  const root = container.children[0], button = part(root, 'button'), details = part(root, 'details');
  assert.equal(part(root, 'count').textContent, 'Road routes: 1/2');
  assert.equal(button.hidden, true);
  assert.equal(button.style.display, 'none');
  assert.equal(button.disabled, true);
  button.click();
  assert.equal(starts, 0);
  assert.match(part(details, 'help').textContent, /Saved paths appear immediately/);
  assert.match(part(details, 'help').textContent, /prepared automatically in the background/);
  assert.match(part(details, 'help').textContent, /Internet is needed for areas absent from Maps cache/);
});

test('automatic mode keeps progress and cancellation while work runs and hides preparation after it ends', () => {
  const control = new RouteStatusControl();
  const container = host();
  let starts = 0, cancels = 0;
  const start = () => starts++;
  control.update(element(container), data('road', 'fallback'), true, 'Preparing.', start,
    { running: true, completed: 3, total: 8 }, () => cancels++, true);
  const root = container.children[0], button = part(root, 'button');
  assert.equal(button.hidden, false);
  assert.equal(button.style.display, '');
  assert.equal(button.textContent, 'Cancel');
  assert.equal(part(root, 'preparation').textContent, 'Preparing roads…');
  assert.equal(part(root, 'work').textContent, 'Preparing roads: 3/8 areas');
  button.click();
  assert.equal(cancels, 1);
  assert.equal(starts, 0);
  control.update(element(container), data('road', 'fallback'), true, 'Done.', start,
    { running: false, completed: 8, total: 8, message: 'Prepared. Missing connections remain dashed.' }, undefined, true);
  assert.equal(button.hidden, true);
  assert.equal(button.style.display, 'none');
  assert.equal(button.disabled, true);
  assert.equal(part(root, 'preparation').textContent, 'Finished · 1 unresolved');
  assert.equal(part(root, 'work').textContent, 'Prepared. Missing connections remain dashed.');
  button.click();
  assert.equal(starts, 0);
});

test('switching automatic preparation off restores the manual action without rebuilding the control', () => {
  const control = new RouteStatusControl();
  const container = host();
  let starts = 0;
  const start = () => starts++;
  control.update(element(container), data('fallback'), true, 'Waiting.', start, undefined, undefined, true);
  const root = container.children[0], details = part(root, 'details'), button = part(root, 'button');
  details.open = true;
  control.update(element(container), data('fallback'), true, 'Waiting.', start, undefined, undefined, false);
  assert.equal(container.children[0], root);
  assert.equal(details.open, true);
  assert.equal(button.hidden, false);
  assert.equal(button.style.display, '');
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Prepare road routes');
  assert.match(part(details, 'help').textContent, /^Prepare road routes loads/);
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
  const root = container.children[0], header = part(root, 'header'), details = part(root, 'details');
  assert.equal(part(header, 'count').textContent, 'Road routes: 2/10');
  assert.equal(part(header, 'summary').textContent, '7/10 processed · 3 left (30%)');
  assert.equal(part(header, 'summary').attributes.role, 'status');
  assert.equal(part(root, 'preparation').textContent, 'Preparing roads…');
  assert.equal(part(details, 'work').textContent, 'Preparing roads: 2/4 areas');
  assert.match(part(details, 'help').textContent, /does not mean every route was found/);
  assert.match(part(details, 'counts').textContent, /Queued: 2/);
  assert.match(part(details, 'counts').textContent, /Preparing: 1/);
  assert.match(part(details, 'counts').textContent, /Ready: 2/);
  assert.match(part(details, 'counts').textContent, /No path: 3/);
  assert.match(part(details, 'counts').textContent, /Data unavailable: 2/);
  assert.match(part(details, 'counts').textContent, /Paused: 0/);
  assert.equal(part(container.children[0], 'resources').textContent, 'Eco · Window CPU 143.3% · Window RAM 1024 MiB');
  assert.match(part(container.children[0], 'resources').title, /includes other plugins/);
  assert.match(part(container.children[0], 'resources').title, /GPU excluded/);
  assert.match(part(container.children[0], 'resources').title, /100% means one logical core/);
});

test('queue Pause and Resume preserve completed progress and work in automatic mode', () => {
  const control = new RouteStatusControl(), container = host();
  let pauses = 0, resumes = 0;
  const resume = () => resumes++, pause = () => pauses++;
  control.update(element(container), data('road', 'fallback'), true, '', resume,
    { running: true, completed: 2, total: 3 }, pause, true, tripSnapshot());
  const root = container.children[0], header = part(root, 'header'), button = part(header, 'button');
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
  assert.equal(part(root, 'preparation').textContent, 'Paused · 3 connections');
  assert.equal(part(root, 'work').textContent, reason);
  assert.equal(part(header, 'summary').textContent, '7/10 processed · 3 left (30%)');
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
  const header = part(container.children[0], 'header');
  assert.equal(part(header, 'count').textContent, 'Road routes: 2/10');
  assert.equal(part(header, 'summary').textContent, '10/10 processed · 0 left (0%)');
  assert.equal(part(header, 'button').hidden, true);
  assert.equal(part(header, 'button').style.display, 'none');
  assert.equal(part(container.children[0], 'resources').textContent, 'Eco · Window CPU — · Window RAM —');
  control.update(element(container), data('road', 'road', ...Array(8).fill('fallback')), true, '', () => {},
    undefined, undefined, false, finished);
  assert.equal(part(header, 'button').hidden, true);
  assert.equal(part(header, 'button').style.display, 'none');
});

test('resource readings update without rebuilding the queue or mislabelling unavailable values', () => {
  const control = new RouteStatusControl(), container = host();
  control.update(element(container), data('fallback'), true, '', null, undefined, undefined, true,
    tripSnapshot(), resourceSnapshot({ currentCpuPercent: null, currentMemoryMb: null }), 'Eco');
  const root = container.children[0], header = part(root, 'header');
  assert.equal(part(container.children[0], 'resources').textContent, 'Eco · Window CPU — · Window RAM —');
  const details = part(root, 'details'); details.open = true;
  control.update(element(container), data('fallback'), true, '', null, undefined, undefined, true,
    tripSnapshot({ percentRemaining: 29.4 }), resourceSnapshot({ currentCpuPercent: 205.05, currentMemoryMb: 1500.6 }), 'Balanced');
  assert.equal(container.children[0], root);
  assert.equal(part(root, 'details'), details);
  assert.equal(details.open, true);
  assert.equal(part(header, 'summary').textContent, '7/10 processed · 3 left (29.4%)');
  assert.equal(part(container.children[0], 'resources').textContent, 'Balanced · Window CPU 205.1% · Window RAM 1501 MiB');
  control.update(element(container), data('fallback'), true, '', null, undefined, undefined, true,
    tripSnapshot(), resourceSnapshot({ currentCpuPercent: NaN, currentMemoryMb: -1 }), '<img src=x>');
  assert.equal(part(container.children[0], 'resources').textContent, '<img src=x> · Window CPU — · Window RAM —');
  control.update(element(container), data('fallback'), true, '', null);
  assert.equal(part(header, 'summary').hidden, false);
  assert.equal(part(header, 'summary').textContent, '0/1 road routes found');
  assert.equal(part(container.children[0], 'resources').hidden, true);
  assert.equal(part(container.children[0], 'resources').style.display, 'none');
});


const storageSnapshot = (changes: Partial<StorageSnapshot> = {}): StorageSnapshot => ({
  scope: 'Maps Directions data.json (logical file size)', available: true,
  dataBytes: 1048576, baselineBytes: 1044480, sessionDeltaBytes: 4096,
  measuredAt: 1, browserCacheBytes: null, ...changes,
});

test('saved data is available in collapsed Details without adding cache counters to the compact panel', () => {
  const control = new RouteStatusControl(), container = host();
  control.update(element(container), data('road'), true, '', null, undefined, undefined, true,
    tripSnapshot(), resourceSnapshot(), 'Eco', storageSnapshot());
  const root = container.children[0], header = part(root, 'header'), saved = part(container.children[0], 'storage');
  assert.equal(saved.textContent, 'Saved data 1.0 MiB · +4.0 KiB this session');
  assert.equal(saved.hidden, false);
  assert.equal(saved.style.display, '');
  assert.match(saved.title, /saved routes, progress and settings in data.json/);
  assert.doesNotMatch(saved.title, /HTTP|browser|cache/);
  assert.match(saved.title, /this plugin session started/);
  assert.equal(part(container.children[0], 'resources').textContent, 'Eco · Window CPU 143.3% · Window RAM 1024 MiB');
  assert.equal(part(root, 'details').open, false);
  assert.equal(saved.parent, part(root, 'body'));
  assert.equal(header.children.length, 3);
  assert.ok(header.children.every(child => !/CPU|RAM|Saved data|cache/i.test(child.textContent)));
});

test('unknown and shrinking saved data stay distinct from a measured zero without inserting HTML', () => {
  const control = new RouteStatusControl(), container = host();
  const update = (storage?: StorageSnapshot) => control.update(element(container), data('fallback'), true, '', null,
    undefined, undefined, true, tripSnapshot(), undefined, 'Eco', storage);
  update(storageSnapshot({ available: false, dataBytes: null, sessionDeltaBytes: null, scope: '<img src=x onerror=alert(1)>' }));
  const root = container.children[0], header = part(root, 'header'), saved = part(container.children[0], 'storage');
  assert.equal(saved.textContent, 'Saved data — · — this session');
  assert.equal(saved.children.length, 0);
  assert.equal(header.children.length, 3);
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
  const root = container.children[0], header = part(root, 'header'), details = part(root, 'details'), saved = part(container.children[0], 'storage');
  const writes = saved.textWrites;
  details.open = true;
  update(storageSnapshot({ measuredAt: 50 }));
  assert.equal(saved.textWrites, writes);
  assert.equal(container.children[0], root);
  assert.equal(part(root, 'header'), header);
  assert.equal(part(container.children[0], 'storage'), saved);
  assert.equal(part(root, 'details'), details);
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
  const root = container.children[0], header = part(root, 'header'), button = part(header, 'button'), details = part(root, 'details');
  assert.equal(part(header, 'count').textContent, 'Road routes: 0/0');
  assert.equal(part(header, 'summary').textContent, '0/0 processed · 0 left (0%)');
  assert.equal(part(header, 'skipped').textContent, '2 skipped (distance limit)');
  assert.equal(part(header, 'skipped').hidden, false);
  assert.equal(part(root, 'preparation').textContent, 'No road calculation needed');
  assert.match(part(details, 'counts').textContent, /Ready: 0/);
  assert.match(part(details, 'counts').textContent, /Skipped by distance: 2/);
  assert.match(part(details, 'counts').textContent, /No path: 0/);
  assert.match(part(details, 'counts').textContent, /Data unavailable: 0/);
  assert.match(part(details, 'help').textContent, /above the distance limit are excluded from progress/);
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
  const header = part(container.children[0], 'header');
  assert.equal(part(header, 'count').textContent, 'Road routes: 1/2');
  assert.equal(part(header, 'summary').textContent, '1/2 processed · 1 left (50%)');
  assert.equal(part(header, 'button').textContent, 'Resume');
  assert.equal(part(header, 'button').hidden, false);
  update(tripSnapshot({ total: 4, eligible: 2, direct: 2, processed: 2, ready: 1, noPath: 1, unavailable: 0,
    queued: 0, preparing: 0, paused: 0, percentComplete: 100, percentRemaining: 0 }));
  assert.equal(part(header, 'summary').textContent, '2/2 processed · 0 left (0%)');
  assert.equal(part(header, 'button').hidden, true);
});

test('shared geometry rendered by several groups uses the same deduplicated queue count for found and eligible paths', () => {
  const control = new RouteStatusControl(), container = host();
  const queue = tripSnapshot({ total: 1, eligible: 1, processed: 1, ready: 1, direct: 0,
    noPath: 0, unavailable: 0, queued: 0, preparing: 0, paused: 0, percentComplete: 100, percentRemaining: 0 });
  control.update(element(container), data('road', 'road'), true, '', null, undefined, undefined, true, queue);
  const header = part(container.children[0], 'header');
  assert.equal(part(header, 'count').textContent, 'Road routes: 1/1');
  assert.equal(part(header, 'summary').textContent, '1/1 processed · 0 left (0%)');
  control.update(element(container), data('road', 'road'), true, '', null);
  assert.equal(part(header, 'count').textContent, 'Road routes: 2/2');
});

test('resource updates inside Details do not rewrite or reannounce unchanged visible progress', () => {
  const control = new RouteStatusControl(), container = host();
  const update = (resources: ResourceSnapshot) => control.update(element(container), data('road', 'fallback'), true, 'Diagnostic detail.', () => {},
    { running: true, completed: 2, total: 4 }, () => {}, true, tripSnapshot(), resources, 'Eco', storageSnapshot());
  update(resourceSnapshot());
  const root = container.children[0], header = part(root, 'header'), details = part(root, 'details');
  const visible = [part(root, 'summary')];
  const writes = visible.map(child => child.textWrites);
  assert.equal(details.open, false);
  update(resourceSnapshot({ currentCpuPercent: 10, currentMemoryMb: 900 }));
  assert.deepEqual(visible.map(child => child.textWrites), writes);
  assert.equal(part(details, 'resources').textContent, 'Eco · Window CPU 10% · Window RAM 900 MiB');
  assert.equal(details.open, false);
});

test('expanded states stay short and skipped distance is omitted when no connection is excluded', () => {
  const control = new RouteStatusControl(), container = host();
  const update = (queue: TripQueueSnapshot) => control.update(element(container), data('road', 'fallback'), true,
    'A long diagnostic sentence explaining the currently loaded map network.', () => {}, undefined, undefined, true, queue);
  update(tripSnapshot());
  const root = container.children[0], header = part(root, 'header');
  assert.equal(part(root, 'preparation').textContent, 'Waiting to prepare…');
  assert.equal(part(header, 'skipped').hidden, true);
  assert.equal(part(header, 'skipped').style.display, 'none');
  assert.equal(part(header, 'skipped').textContent, '');
  update(tripSnapshot({ eligible: 8, total: 10, direct: 2, processed: 7, queued: 0, preparing: 0, paused: 1, percentRemaining: 12.5 }));
  assert.equal(part(root, 'preparation').textContent, 'Paused · 1 connection');
  assert.equal(part(header, 'summary').textContent, '7/8 processed · 1 left (12.5%)');
  assert.equal(part(header, 'skipped').textContent, '2 skipped (distance limit)');
  assert.equal(part(header, 'button').textContent, 'Resume');
  update(tripSnapshot({ eligible: 8, total: 10, direct: 2, processed: 8, ready: 7, noPath: 0, unavailable: 1, queued: 0, preparing: 0, paused: 0, percentRemaining: 0 }));
  assert.equal(part(root, 'preparation').textContent, 'Finished · 1 unresolved');
  assert.equal(part(header, 'button').hidden, true);
});



test('collapsed queue panel contains only processing progress while every result, action and diagnostic is expandable', () => {
  const control = new RouteStatusControl(), container = host();
  const queue = tripSnapshot({ total: 12, eligible: 10, direct: 2 });
  control.update(element(container), data('road', 'fallback', 'direct'), true, 'Detailed diagnostic.', () => {},
    { running: true, completed: 2, total: 4 }, () => {}, true, queue, resourceSnapshot(), 'Eco', storageSnapshot());
  const root = container.children[0], details = part(root, 'details'), body = part(root, 'body');
  assert.equal(root.children.length, 1);
  assert.equal(root.children[0], details);
  assert.equal(details.tag, 'details');
  assert.equal(details.open, false);
  assert.equal(details.children.length, 2);
  const summary = details.children[0];
  assert.equal(summary.tag, 'summary');
  assert.equal(summary.children.length, 1);
  assert.equal(summary.children[0], part(root, 'summary'));
  assert.equal(part(root, 'summary').textContent, '7/10 processed · 3 left (30%)');
  for (const name of ['count', 'button', 'preparation', 'skipped', 'counts', 'work', 'resources', 'storage', 'help', 'diagnostic']) {
    let parent = part(root, name).parent;
    while (parent && parent !== body) parent = parent.parent;
    assert.equal(parent, body, `${name} must be inside the expandable body`);
  }
  assert.equal(part(root, 'skipped').textContent, '2 skipped (distance limit)');
  assert.equal(part(root, 'button').textContent, 'Pause');
});

test('legacy background progress uses map-area counts without claiming missing paths were processed', () => {
  const control = new RouteStatusControl(), container = host();
  control.update(element(container), data('road', 'fallback'), true, '', null,
    { running: true, completed: 3, total: 8 });
  const summary = part(container.children[0], 'summary');
  assert.equal(summary.textContent, '3/8 map areas processed');
  assert.match(summary.title, /Background map areas processed/);
  control.update(element(container), data('road', 'fallback'), true, '', null);
  assert.equal(summary.textContent, '1/2 road routes found');
  assert.match(summary.title, /no saved connection-processing counts/);
});
