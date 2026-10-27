import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FeatureCollection } from '../src/contracts';
import { getRouteLegendEntries, RouteLegend } from '../src/route-legend';

const feature = (route: string, lineColor = '#2583e8', connectionKind = 'road'): FeatureCollection['features'][number] => ({
  type: 'Feature', properties: { route, lineColor, connectionKind },
  geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
});
const collection = (...features: FeatureCollection['features']): FeatureCollection => ({ type: 'FeatureCollection', features });

test('legend deduplicates complete routes and uses their rendered colors', () => {
  const data = collection(
    feature('Day 1'), feature('Day 1', '#2583e8', 'connector'), feature('Day 1', '#2583e8', 'fallback'),
    feature('Day 2', '#ef8733', 'fallback'), feature('Day 2', '#ef8733'),
  );
  assert.deepEqual(getRouteLegendEntries(data, true), [
    { group: 'Day 1', label: 'Day 1', color: '#2583e8' },
    { group: 'Day 2', label: 'Day 2', color: '#ef8733' },
  ]);
  assert.equal(data.features[0].properties.lineColor, '#2583e8');
});

test('legend labels blank groups and hides when no grouping or connections exist', () => {
  assert.deepEqual(getRouteLegendEntries(collection(feature('')), true), [{ group: '', label: 'Ungrouped', color: '#2583e8' }]);
  assert.deepEqual(getRouteLegendEntries(collection(feature('Day 1')), false), []);
  assert.deepEqual(getRouteLegendEntries(collection(), true), []);
  assert.deepEqual(getRouteLegendEntries(collection(feature('Day 1', '#2583e8', 'connector')), true), []);
});

test('legend keeps exact group names and accepts only normalized line colors', () => {
  const label = '<img src=x onerror=alert(1)>';
  assert.deepEqual(getRouteLegendEntries(collection(feature(label, '#EF8733'), feature('Other', 'invalid')), true), [
    { group: label, label, color: '#EF8733' }, { group: 'Other', label: 'Other', color: '#7c5cff' },
  ]);
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
  constructor(readonly tag: string, readonly ownerDocument: FakeDocument) {}
  setAttribute(key: string, value: string): void { this.attributes[key] = value; }
  append(...children: FakeElement[]): void {
    for (const child of children) { child.parent = this; this.children.push(child); }
  }
  replaceChildren(): void {
    for (const child of this.children) child.parent = null;
    this.children = [];
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  addEventListener(name: string, listener: (event: { stopPropagation(): void }) => void): void { this.listeners.set(name, listener); }
}
const host = (): FakeElement => new FakeDocument().createElement('div');
const element = (host: FakeElement): HTMLElement => host as unknown as HTMLElement;

test('legend updates labels and swatches safely without resetting collapse state', () => {
  const legend = new RouteLegend();
  const container = host();
  const label = '<img src=x onerror=alert(1)>';
  legend.update(element(container), collection(feature(label)), true);
  assert.equal(container.children.length, 1);
  const root = container.children[0];
  const [summary, list] = root.children;
  assert.equal(root.tag, 'details');
  assert.equal(root.attributes['aria-label'], 'Route legend');
  assert.equal(root.open, true);
  assert.equal(summary.textContent, 'Routes (1)');
  assert.equal(list.children[0].children[1].textContent, label);
  assert.equal(list.children[0].children[0].style.borderTop, '3px solid #2583e8');
  assert.equal(list.attributes.role, 'list');
  root.open = false;
  const firstRow = list.children[0];
  legend.update(element(container), collection(feature(label)), true);
  assert.equal(list.children[0], firstRow);
  legend.update(element(container), collection(feature('Day 2', '#ef8733')), true);
  assert.equal(container.children[0], root);
  assert.equal(root.open, false);
  assert.equal(list.children[0].children[1].textContent, 'Day 2');
  assert.equal(list.children[0].children[0].style.borderTop, '3px solid #ef8733');
});

test('legend detaches on map replacement, empty data, disabled grouping, and destroy', () => {
  const legend = new RouteLegend();
  const first = host(), second = host();
  const data = collection(feature('Day 1'));
  legend.update(element(first), data, true);
  legend.update(element(second), data, true);
  assert.equal(first.children.length, 0);
  assert.equal(second.children.length, 1);
  legend.update(element(second), collection(), true);
  assert.equal(second.children.length, 0);
  legend.update(element(first), data, true);
  legend.update(element(first), data, false);
  assert.equal(first.children.length, 0);
  legend.update(element(first), data, true);
  legend.update(null, data, true);
  assert.equal(first.children.length, 0);
  legend.update(element(first), data, true);
  legend.destroy();
  legend.destroy();
  assert.equal(first.children.length, 0);
});

test('legend gestures stop before reaching map interaction handlers', () => {
  const legend = new RouteLegend();
  const container = host();
  legend.update(element(container), collection(feature('Day 1')), true);
  const root = container.children[0];
  let stopped = 0;
  for (const event of ['mousedown', 'pointerdown', 'touchstart', 'wheel', 'click', 'dblclick', 'keydown']) {
    root.listeners.get(event)!({ stopPropagation: () => stopped++ });
  }
  assert.equal(stopped, 7);
});
