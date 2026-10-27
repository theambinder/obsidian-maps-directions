import type { FeatureCollection } from './contracts';

export interface RoadRouteProgress { routed: number; total: number; missing: number }
export interface RoadPreparationProgress {
  running: boolean;
  completed: number;
  total: number;
  message?: string;
}

/** Access connectors are part of a connection, not additional route legs. */
export function getRoadRouteProgress(data: FeatureCollection): RoadRouteProgress {
  let routed = 0, total = 0;
  for (const feature of data.features) {
    if (feature.properties.connectionKind === 'connector') continue;
    total++;
    if (feature.properties.connectionKind === 'road') routed++;
  }
  return { routed, total, missing: total - routed };
}

const ROAD_HELP = 'Prepare road routes loads detailed map areas in the background and saves found walking paths. Internet is needed for areas absent from Maps cache. Dashed lines may remain for disconnected paths, ferry or flight legs.';
const PREPARE_HELP = 'Load detailed map areas in the background and save found walking paths.';

/** A lightweight explanation and entry point for local road routing. */
export class RouteStatusControl {
  private host: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private count: HTMLElement | null = null;
  private button: HTMLButtonElement | null = null;
  private status: HTMLElement | null = null;
  private preparation: HTMLElement | null = null;
  private signature = '';
  private action: (() => void) | null = null;

  update(
    host: HTMLElement | null,
    data: FeatureCollection,
    local: boolean,
    status: string,
    onPrepare: (() => void) | null,
    preparation?: RoadPreparationProgress,
    onCancel?: () => void,
  ): void {
    const progress = getRoadRouteProgress(data);
    if (!host || !local || progress.total === 0) {
      this.destroy();
      return;
    }
    if (this.host !== host || !this.root) {
      this.destroy();
      this.create(host);
    }
    const running = preparation?.running === true;
    this.action = running ? onCancel ?? null : onPrepare;
    const showButton = running || progress.missing > 0 && onPrepare !== null;
    const preparationText = running
      ? `Preparing roads: ${preparation!.completed}/${preparation!.total} areas`
      : preparation?.message ?? '';
    const signature = JSON.stringify([progress, status, showButton, running, !!this.action, preparationText]);
    if (signature === this.signature) return;
    this.signature = signature;
    this.count!.textContent = `Road routes: ${progress.routed}/${progress.total}`;
    this.button!.hidden = !showButton;
    this.button!.disabled = !showButton || this.action === null;
    this.button!.textContent = running ? 'Cancel' : 'Prepare road routes';
    this.button!.title = running ? 'Cancel road preparation. Paths already found are kept.' : PREPARE_HELP;
    this.preparation!.textContent = preparationText;
    this.preparation!.hidden = preparationText.length === 0;
    this.status!.textContent = status;
    this.status!.hidden = status.length === 0;
  }

  destroy(): void {
    this.root?.remove();
    this.host = null;
    this.root = null;
    this.count = null;
    this.button = null;
    this.status = null;
    this.preparation = null;
    this.signature = '';
    this.action = null;
  }

  private create(host: HTMLElement): void {
    const doc = host.ownerDocument;
    const root = doc.createElement('div');
    root.className = 'obsidian-maps-directions-route-status';
    root.setAttribute('aria-label', 'Road routing status');
    Object.assign(root.style, {
      position: 'absolute', top: '10px', left: '10px', zIndex: '2',
      maxWidth: 'min(260px, calc(100% - 60px))', boxSizing: 'border-box', padding: '7px 10px',
      color: 'var(--text-normal, #222)', background: 'var(--background-primary, #fff)',
      border: '1px solid var(--background-modifier-border, #ddd)', borderRadius: '6px',
      boxShadow: '0 1px 4px #0003', fontSize: '12px', lineHeight: '1.4',
      pointerEvents: 'auto', userSelect: 'text',
    });
    const header = doc.createElement('div');
    Object.assign(header.style, { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px 10px' });
    const count = doc.createElement('span');
    Object.assign(count.style, { fontWeight: '600', whiteSpace: 'nowrap' });
    const button = doc.createElement('button');
    button.type = 'button';
    Object.assign(button.style, { fontSize: '11px', minHeight: '25px', height: 'auto', padding: '3px 6px', margin: '0' });
    button.addEventListener('click', () => { if (!button.disabled) this.action?.(); });
    header.append(count, button);
    const preparation = doc.createElement('div');
    preparation.className = 'obsidian-maps-directions-preparation-progress';
    preparation.setAttribute('role', 'status');
    Object.assign(preparation.style, { marginTop: '5px', overflowWrap: 'anywhere' });
    const details = doc.createElement('details');
    Object.assign(details.style, { marginTop: '5px', maxHeight: 'min(240px, 50vh)', overflowY: 'auto', overscrollBehavior: 'contain' });
    const summary = doc.createElement('summary');
    summary.textContent = 'Why dashed lines?';
    Object.assign(summary.style, { cursor: 'pointer', color: 'var(--text-muted, #666)' });
    const help = doc.createElement('p');
    help.textContent = ROAD_HELP;
    Object.assign(help.style, { margin: '7px 0 0' });
    const diagnostic = doc.createElement('p');
    diagnostic.className = 'obsidian-maps-directions-routing-detail';
    Object.assign(diagnostic.style, { margin: '7px 0 0', color: 'var(--text-muted, #666)', overflowWrap: 'anywhere' });
    details.append(summary, help, diagnostic);
    root.append(header, preparation, details);
    // Native controls and help scrolling must not drag or zoom the map.
    for (const event of ['mousedown', 'pointerdown', 'touchstart', 'wheel', 'click', 'dblclick', 'keydown']) {
      root.addEventListener(event, event => event.stopPropagation());
    }
    host.append(root);
    this.host = host;
    this.root = root;
    this.count = count;
    this.button = button;
    this.status = diagnostic;
    this.preparation = preparation;
  }
}
