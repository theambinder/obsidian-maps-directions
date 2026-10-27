import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FeatureCollection } from '../src/contracts';
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
  textContent = '';
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
  assert.equal(button.disabled, true);
  button.click();
  assert.equal(clicks, 0);
  control.update(element(container), data('fallback'), true, '', null);
  assert.equal(button.hidden, true);
  control.update(element(container), data('fallback'), true, '', () => clicks++);
  assert.equal(button.hidden, false);
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
  button.click();
  assert.equal(starts, 1);
});
