import type { FeatureCollection } from './contracts';

export interface RouteLegendEntry {
  group: string;
  label: string;
  color: string;
}

/** Read the rendered colors, so the legend always agrees with every color mode. */
export function getRouteLegendEntries(data: FeatureCollection, grouped: boolean): RouteLegendEntry[] {
  if (!grouped) return [];
  const entries = new Map<string, RouteLegendEntry>();
  for (const feature of data.features) {
    if (feature.properties.connectionKind === 'connector') continue;
    const group = String(feature.properties.route ?? '');
    if (entries.has(group)) continue;
    const color = String(feature.properties.lineColor ?? '');
    entries.set(group, {
      group,
      label: group.trim() ? group : 'Ungrouped',
      color: /^#[\da-f]{6}$/i.test(color) ? color : '#7c5cff',
    });
  }
  return [...entries.values()];
}

/** A small native DOM control; it never adds or changes any Maps layer. */
export class RouteLegend {
  private host: HTMLElement | null = null;
  private root: HTMLDetailsElement | null = null;
  private list: HTMLElement | null = null;
  private summary: HTMLElement | null = null;
  private signature = '';

  update(host: HTMLElement | null, data: FeatureCollection, grouped: boolean): void {
    const entries = getRouteLegendEntries(data, grouped);
    if (!host || entries.length === 0) {
      this.destroy();
      return;
    }
    if (this.host !== host || !this.root) {
      this.destroy();
      this.create(host);
    }
    const signature = JSON.stringify(entries);
    if (signature === this.signature) return;
    this.signature = signature;
    this.summary!.textContent = `Routes (${entries.length})`;
    this.list!.replaceChildren();
    for (const entry of entries) {
      const row = host.ownerDocument.createElement('div');
      row.className = 'obsidian-maps-directions-legend-row';
      row.setAttribute('role', 'listitem');
      Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', minHeight: '23px' });
      const swatch = host.ownerDocument.createElement('span');
      swatch.setAttribute('aria-hidden', 'true');
      Object.assign(swatch.style, { width: '24px', flex: '0 0 24px', borderTop: `3px solid ${entry.color}`, borderRadius: '2px' });
      const label = host.ownerDocument.createElement('span');
      label.textContent = entry.label;
      label.title = entry.label;
      Object.assign(label.style, { minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
      row.append(swatch, label);
      this.list!.append(row);
    }
  }

  destroy(): void {
    this.root?.remove();
    this.root = null;
    this.list = null;
    this.summary = null;
    this.host = null;
    this.signature = '';
  }

  private create(host: HTMLElement): void {
    const root = host.ownerDocument.createElement('details');
    root.className = 'obsidian-maps-directions-legend';
    root.open = true;
    root.setAttribute('aria-label', 'Route legend');
    Object.assign(root.style, {
      position: 'absolute', bottom: '30px', left: '10px', zIndex: '2',
      maxWidth: 'min(220px, calc(100% - 60px))', boxSizing: 'border-box',
      color: 'var(--text-normal, #222)', background: 'var(--background-primary, #fff)',
      border: '1px solid var(--background-modifier-border, #ddd)', borderRadius: '6px',
      boxShadow: '0 1px 4px #0003', fontSize: '12px', lineHeight: '1.4',
      pointerEvents: 'auto', userSelect: 'text',
    });
    const summary = host.ownerDocument.createElement('summary');
    Object.assign(summary.style, { padding: '7px 10px', cursor: 'pointer', fontWeight: '600', whiteSpace: 'nowrap' });
    const list = host.ownerDocument.createElement('div');
    list.setAttribute('role', 'list');
    Object.assign(list.style, { maxHeight: 'min(180px, 32vh)', overflowY: 'auto', overscrollBehavior: 'contain', padding: '0 10px 7px' });
    // Scrolling and selecting the legend must not move or zoom the map beneath it.
    for (const event of ['mousedown', 'pointerdown', 'touchstart', 'wheel', 'click', 'dblclick', 'keydown']) {
      root.addEventListener(event, event => event.stopPropagation());
    }
    root.append(summary, list);
    host.append(root);
    this.host = host;
    this.root = root;
    this.list = list;
    this.summary = summary;
  }
}
