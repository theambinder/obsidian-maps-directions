import type { FeatureCollection } from './contracts';
import type { TripQueueSnapshot } from './trip-queue';
import type { ResourceSnapshot } from './resource-sampler';
import { formatStorageBytes, formatStorageDelta, type StorageSnapshot } from './storage-usage';
import type { SharedHttpCacheSnapshot } from './shared-http-cache';

export interface RoadRouteProgress { routed: number; total: number; missing: number }
export interface RoadPreparationProgress {
  running: boolean;
  completed: number;
  total: number;
  message?: string;
  unit?: 'areas' | 'sections';
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
const AUTOMATIC_ROAD_HELP = 'Saved paths appear immediately. Missing walking paths are prepared automatically in the background when the map opens. Internet is needed for areas absent from Maps cache. Dashed lines may remain for disconnected paths, ferry or flight legs.';
const QUEUE_HELP = 'Progress counts eligible connection tasks, including paths not found or unavailable data. It does not mean every route was found. Connections above the distance limit are excluded from progress and shown separately as skipped. Paused connections remain unfinished. Pin-to-road access is shown dashed and is not a verified walking path. Completed tasks are saved; an interrupted connection may reload its temporary roads after reopening.';
const RESOURCE_HELP = 'Obsidian window process, includes other plugins; GPU excluded. CPU 100% means one logical core.';
const measured = (value: number | null | undefined, decimals = 0): string => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? String(Number(value.toFixed(decimals))) : '—';
const queueNumber = (value: number): number => Number.isFinite(value) ? Math.max(0, value) : 0;
const PREPARE_HELP = 'Load detailed map areas in the background and save found walking paths.';

/** A lightweight explanation and entry point for local road routing. */
export class RouteStatusControl {
  private host: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private count: HTMLElement | null = null;
  private button: HTMLButtonElement | null = null;
  private status: HTMLElement | null = null;
  private help: HTMLElement | null = null;
  private preparation: HTMLElement | null = null;
  private queueSummary: HTMLElement | null = null;
  private queueCounts: HTMLElement | null = null;
  private resources: HTMLElement | null = null;
  private storage: HTMLElement | null = null;
  private sharedCache: HTMLElement | null = null;
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
    automatic = false,
    queueProgress?: TripQueueSnapshot,
    resources?: ResourceSnapshot,
    workloadLabel?: string,
    storage?: StorageSnapshot,
    sharedCache?: SharedHttpCacheSnapshot,
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
    const eligible = queueProgress ? queueNumber(queueProgress.eligible ?? queueProgress.total - (queueProgress.direct ?? 0)) : progress.total;
    const ready = queueProgress ? queueNumber(queueProgress.ready) : progress.routed;
    const remaining = queueProgress ? Math.max(0, eligible - queueNumber(queueProgress.processed)) : progress.missing;
    const resumable = !!queueProgress && queueProgress.paused > 0 && remaining > 0 && !running;
    this.action = running ? onCancel ?? null : resumable ? onPrepare : automatic ? null : onPrepare;
    const manualMissing = queueProgress ? remaining : progress.missing;
    const showButton = running || resumable && onPrepare !== null || !automatic && manualMissing > 0 && onPrepare !== null;
    const preparationText = running
      ? preparation!.unit === 'sections' ? preparation!.message ?? `Preparing smaller road sections: ${preparation!.completed}/${preparation!.total}` : `Preparing roads: ${preparation!.completed}/${preparation!.total} areas`
      : preparation?.message ?? (queueProgress?.paused ? `${queueProgress.paused} connections paused. Open details for the reason.` : '');
    const queueText = queueProgress
      ? `Processed ${queueNumber(queueProgress.processed)}/${eligible} eligible connections (${measured(Math.min(100, queueNumber(queueProgress.percentComplete)), 1)}%) · Remaining: ${remaining} (${measured(Math.min(100, queueNumber(queueProgress.percentRemaining)), 1)}%) · Skipped by distance: ${queueNumber(queueProgress.direct ?? 0)}`
      : '';
    const queueCounts = queueProgress
      ? `Eligible: ${eligible} · Queued: ${queueNumber(queueProgress.queued)} · Preparing: ${queueNumber(queueProgress.preparing)} · Ready: ${queueNumber(queueProgress.ready)} · Skipped by distance: ${queueNumber(queueProgress.direct ?? 0)} · No path: ${queueNumber(queueProgress.noPath)} · Data unavailable: ${queueNumber(queueProgress.unavailable)} · Paused: ${queueNumber(queueProgress.paused)}`
      : '';
    const showResources = !!resources || !!queueProgress && !!workloadLabel;
    const resourceText = showResources
      ? `${workloadLabel ? `${workloadLabel} · ` : ''}Window CPU ${measured(resources?.currentCpuPercent, 1)}${measured(resources?.currentCpuPercent, 1) === '—' ? '' : '%'} · Window RAM ${measured(resources?.currentMemoryMb)}${measured(resources?.currentMemoryMb) === '—' ? '' : ' MiB'}`
      : '';
    const storageText = storage ? `Saved data ${formatStorageBytes(storage.dataBytes)} · ${formatStorageDelta(storage.sessionDeltaBytes)} this session` : '';
    const sharedCacheText = sharedCache ? `Shared HTTP cache ${formatStorageBytes(sharedCache.bytes)} · ${formatStorageDelta(sharedCache.sessionDeltaBytes)} this session` : '';
    const signature = JSON.stringify([progress, eligible, ready, status, showButton, running, resumable, !!this.action, preparationText, automatic, queueText, queueCounts, resourceText, storageText, sharedCacheText]);
    if (signature === this.signature) return;
    this.signature = signature;
    this.count!.textContent = `Road routes: ${ready}/${eligible}${queueProgress ? ' eligible' : ''}`;
    this.button!.hidden = !showButton;
    // Themes can override the browser's hidden rule for native buttons.
    this.button!.style.display = showButton ? '' : 'none';
    this.button!.disabled = !showButton || this.action === null;
    this.button!.textContent = running ? queueProgress ? 'Pause' : 'Cancel' : resumable ? 'Resume' : 'Prepare road routes';
    this.button!.title = running ? queueProgress ? 'Pause preparation. Completed connections and queue progress are saved.' : 'Cancel road preparation. Paths already found are kept.' : resumable ? 'Continue the saved queue with the current workload settings.' : PREPARE_HELP;
    this.preparation!.textContent = preparationText;
    this.preparation!.hidden = preparationText.length === 0;
    this.help!.textContent = `${automatic ? AUTOMATIC_ROAD_HELP : ROAD_HELP}${queueProgress ? ` ${QUEUE_HELP}` : ''}`;
    this.queueSummary!.textContent = queueText;
    this.queueSummary!.hidden = !queueProgress;
    this.queueSummary!.style.display = queueProgress ? '' : 'none';
    this.queueCounts!.textContent = queueCounts;
    this.queueCounts!.hidden = !queueProgress;
    this.queueCounts!.style.display = queueProgress ? '' : 'none';
    this.resources!.textContent = resourceText;
    this.resources!.hidden = !showResources;
    this.resources!.style.display = showResources ? '' : 'none';
    this.storage!.textContent = storageText;
    this.storage!.hidden = !storage;
    this.storage!.style.display = storage ? '' : 'none';
    this.sharedCache!.textContent = sharedCacheText;
    this.sharedCache!.hidden = !sharedCache;
    this.sharedCache!.style.display = sharedCache ? '' : 'none';
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
    this.help = null;
    this.preparation = null;
    this.queueSummary = null;
    this.queueCounts = null;
    this.resources = null;
    this.storage = null;
    this.sharedCache = null;
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
      maxWidth: 'min(300px, calc(100% - 60px))', boxSizing: 'border-box', padding: '7px 10px',
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
    const queueSummary = doc.createElement('span');
    queueSummary.className = 'obsidian-maps-directions-queue-progress';
    queueSummary.setAttribute('role', 'status');
    queueSummary.title = 'Progress covers connections within the distance limit only. Skipped long connections are excluded. Processed tasks include unavailable data and paths not found; paused tasks remain unfinished.';
    Object.assign(queueSummary.style, { flexBasis: '100%', fontSize: '12px', overflowWrap: 'anywhere' });
    const resources = doc.createElement('span');
    resources.className = 'obsidian-maps-directions-resource-status';
    resources.title = RESOURCE_HELP;
    Object.assign(resources.style, { flexBasis: '100%', fontSize: '11px', color: 'var(--text-muted, #666)', overflowWrap: 'anywhere' });
    const storage = doc.createElement('span');
    storage.className = 'obsidian-maps-directions-storage-status';
    storage.title = 'Logical size of the addon data.json file only. Shared browser/map HTTP cache is excluded here and shown separately when available. Change is since this plugin session started.';
    Object.assign(storage.style, { flexBasis: '100%', fontSize: '11px', color: 'var(--text-muted, #666)', overflowWrap: 'anywhere' });
    const sharedCache = doc.createElement('span');
    sharedCache.className = 'obsidian-maps-directions-shared-cache-status';
    sharedCache.title = 'Shared Obsidian HTTP cache reported by Electron for the current browser session. Includes Maps and unrelated plugins/resources; cannot be attributed to Maps Directions alone. Change is since this plugin session started. Updated about every 30 seconds when available.';
    Object.assign(sharedCache.style, { flexBasis: '100%', fontSize: '11px', color: 'var(--text-muted, #666)', overflowWrap: 'anywhere' });
    header.append(count, button, queueSummary, resources, storage, sharedCache);
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
    const queueCounts = doc.createElement('p');
    queueCounts.className = 'obsidian-maps-directions-queue-counts';
    Object.assign(queueCounts.style, { margin: '7px 0 0', color: 'var(--text-muted, #666)', overflowWrap: 'anywhere' });
    details.append(summary, help, diagnostic, queueCounts);
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
    this.help = help;
    this.preparation = preparation;
    this.queueSummary = queueSummary;
    this.queueCounts = queueCounts;
    this.resources = resources;
    this.storage = storage;
    this.sharedCache = sharedCache;
  }
}
