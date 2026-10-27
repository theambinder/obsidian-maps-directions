import type { FeatureCollection } from './contracts';
import type { TripQueueSnapshot } from './trip-queue';
import type { ResourceSnapshot } from './resource-sampler';
import { formatStorageBytes, formatStorageDelta, type StorageSnapshot } from './storage-usage';

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
const writeText = (element: HTMLElement, text: string): void => { if (element.textContent !== text) element.textContent = text; };

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
  private skipped: HTMLElement | null = null;
  private workProgress: HTMLElement | null = null;
  private resources: HTMLElement | null = null;
  private storage: HTMLElement | null = null;
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
    const workText = running
      ? preparation!.unit === 'sections' ? preparation!.message ?? `Preparing smaller road sections: ${preparation!.completed}/${preparation!.total}` : `Preparing roads: ${preparation!.completed}/${preparation!.total} areas`
      : preparation?.message ?? (queueProgress?.paused ? `${queueProgress.paused} connections paused. Expand the progress row for the reason.` : '');
    const unresolved = queueProgress ? queueNumber(queueProgress.noPath) + queueNumber(queueProgress.unavailable) : progress.missing;
    const preparationText = running ? 'Preparing roads…'
      : resumable ? `Paused · ${queueNumber(queueProgress!.paused)} connection${queueProgress!.paused === 1 ? '' : 's'}`
      : queueProgress && remaining === 0 ? eligible === 0 ? 'No road calculation needed' : unresolved ? `Finished · ${unresolved} unresolved` : 'Finished'
      : queueProgress && automatic && remaining > 0 ? 'Waiting to prepare…'
      : preparation ? preparation.total > 0 && preparation.completed >= preparation.total ? unresolved ? `Finished · ${unresolved} unresolved` : 'Finished' : 'Preparation stopped' : '';
    const queueText = queueProgress
      ? `${queueNumber(queueProgress.processed)}/${eligible} processed · ${remaining} left (${measured(Math.min(100, queueNumber(queueProgress.percentRemaining)), 1)}%)`
      : preparation && preparation.total > 0
        ? `${Math.min(preparation.total, queueNumber(preparation.completed))}/${queueNumber(preparation.total)} map areas processed`
        : `${progress.routed}/${progress.total} road routes found`;
    const skipped = queueNumber(queueProgress?.direct ?? 0);
    const skippedText = skipped ? `${skipped} skipped (distance limit)` : '';
    const queueCounts = queueProgress
      ? `Eligible: ${eligible} · Queued: ${queueNumber(queueProgress.queued)} · Preparing: ${queueNumber(queueProgress.preparing)} · Ready: ${queueNumber(queueProgress.ready)} · Skipped by distance: ${queueNumber(queueProgress.direct ?? 0)} · No path: ${queueNumber(queueProgress.noPath)} · Data unavailable: ${queueNumber(queueProgress.unavailable)} · Paused: ${queueNumber(queueProgress.paused)}`
      : '';
    const showResources = !!resources || !!queueProgress && !!workloadLabel;
    const resourceText = showResources
      ? `${workloadLabel ? `${workloadLabel} · ` : ''}Window CPU ${measured(resources?.currentCpuPercent, 1)}${measured(resources?.currentCpuPercent, 1) === '—' ? '' : '%'} · Window RAM ${measured(resources?.currentMemoryMb)}${measured(resources?.currentMemoryMb) === '—' ? '' : ' MiB'}`
      : '';
    const storageText = storage ? `Saved data ${formatStorageBytes(storage.dataBytes)} · ${formatStorageDelta(storage.sessionDeltaBytes)} this session` : '';
    const signature = JSON.stringify([progress, eligible, ready, status, showButton, running, resumable, !!this.action, preparationText, workText, automatic, queueText, skippedText, queueCounts, resourceText, storageText]);
    if (signature === this.signature) return;
    this.signature = signature;
    writeText(this.count!, `Road routes: ${ready}/${eligible}`);
    this.button!.hidden = !showButton;
    // Themes can override the browser's hidden rule for native buttons.
    this.button!.style.display = showButton ? '' : 'none';
    this.button!.disabled = !showButton || this.action === null;
    writeText(this.button!, running ? queueProgress ? 'Pause' : 'Cancel' : resumable ? 'Resume' : 'Prepare road routes');
    this.button!.title = running ? queueProgress ? 'Pause preparation. Completed connections and queue progress are saved.' : 'Cancel road preparation. Paths already found are kept.' : resumable ? 'Continue the saved queue with the current workload settings.' : PREPARE_HELP;
    writeText(this.preparation!, preparationText);
    this.preparation!.hidden = preparationText.length === 0;
    writeText(this.help!, `${automatic ? AUTOMATIC_ROAD_HELP : ROAD_HELP}${queueProgress ? ` ${QUEUE_HELP}` : ''}`);
    writeText(this.queueSummary!, queueText);
    this.queueSummary!.title = queueProgress
      ? 'Progress covers connections within the distance limit only. Skipped long connections are excluded. Processed includes unavailable data and paths not found. Expand for route details.'
      : preparation && preparation.total > 0 ? 'Background map areas processed. Expand for found road routes and preparation details.'
      : 'Found road routes; no saved connection-processing counts are available. Expand for details.';
    writeText(this.skipped!, skippedText);
    this.skipped!.hidden = !skipped;
    this.skipped!.style.display = skipped ? '' : 'none';
    writeText(this.workProgress!, workText);
    this.workProgress!.hidden = !workText;
    this.workProgress!.style.display = workText ? '' : 'none';
    writeText(this.queueCounts!, queueCounts);
    this.queueCounts!.hidden = !queueProgress;
    this.queueCounts!.style.display = queueProgress ? '' : 'none';
    writeText(this.resources!, resourceText);
    this.resources!.hidden = !showResources;
    this.resources!.style.display = showResources ? '' : 'none';
    writeText(this.storage!, storageText);
    this.storage!.hidden = !storage;
    this.storage!.style.display = storage ? '' : 'none';
    writeText(this.status!, status);
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
    this.skipped = null;
    this.workProgress = null;
    this.resources = null;
    this.storage = null;
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
    const details = doc.createElement('details');
    details.className = 'obsidian-maps-directions-status-details';
    const summary = doc.createElement('summary');
    Object.assign(summary.style, { cursor: 'pointer', fontWeight: '600', overflowWrap: 'anywhere' });
    const body = doc.createElement('div');
    body.className = 'obsidian-maps-directions-status-body';
    Object.assign(body.style, { marginTop: '6px', maxHeight: 'min(300px, 50vh)', overflowY: 'auto', overscrollBehavior: 'contain' });
    const header = doc.createElement('div');
    header.className = 'obsidian-maps-directions-status-header';
    Object.assign(header.style, { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px 10px' });
    const count = doc.createElement('span');
    count.className = 'obsidian-maps-directions-route-count';
    Object.assign(count.style, { fontWeight: '600', whiteSpace: 'nowrap' });
    const button = doc.createElement('button');
    button.className = 'obsidian-maps-directions-status-action';
    button.type = 'button';
    Object.assign(button.style, { fontSize: '11px', minHeight: '25px', height: 'auto', padding: '3px 6px', margin: '0' });
    button.addEventListener('click', () => { if (!button.disabled) this.action?.(); });
    const queueSummary = doc.createElement('span');
    queueSummary.className = 'obsidian-maps-directions-queue-progress';
    queueSummary.setAttribute('role', 'status');
    Object.assign(queueSummary.style, { fontSize: '12px', overflowWrap: 'anywhere' });
    summary.append(queueSummary);
    const skipped = doc.createElement('span');
    skipped.className = 'obsidian-maps-directions-skipped-status';
    Object.assign(skipped.style, { flexBasis: '100%', fontSize: '11px', color: 'var(--text-muted, #666)' });
    const resources = doc.createElement('p');
    resources.className = 'obsidian-maps-directions-resource-status';
    resources.title = RESOURCE_HELP;
    Object.assign(resources.style, { margin: '7px 0 0', fontSize: '11px', color: 'var(--text-muted, #666)', overflowWrap: 'anywhere' });
    const storage = doc.createElement('p');
    storage.className = 'obsidian-maps-directions-storage-status';
    storage.title = 'Size of this addon’s saved routes, progress and settings in data.json. Change is since this plugin session started.';
    Object.assign(storage.style, { margin: '7px 0 0', fontSize: '11px', color: 'var(--text-muted, #666)', overflowWrap: 'anywhere' });
    header.append(count, button, skipped);
    const preparation = doc.createElement('div');
    preparation.className = 'obsidian-maps-directions-preparation-progress';
    preparation.setAttribute('role', 'status');
    Object.assign(preparation.style, { marginTop: '5px', overflowWrap: 'anywhere' });
    const help = doc.createElement('p');
    help.className = 'obsidian-maps-directions-routing-help';
    help.textContent = ROAD_HELP;
    Object.assign(help.style, { margin: '7px 0 0' });
    const diagnostic = doc.createElement('p');
    diagnostic.className = 'obsidian-maps-directions-routing-detail';
    Object.assign(diagnostic.style, { margin: '7px 0 0', color: 'var(--text-muted, #666)', overflowWrap: 'anywhere' });
    const queueCounts = doc.createElement('p');
    queueCounts.className = 'obsidian-maps-directions-queue-counts';
    Object.assign(queueCounts.style, { margin: '7px 0 0', color: 'var(--text-muted, #666)', overflowWrap: 'anywhere' });
    const workProgress = doc.createElement('p');
    workProgress.className = 'obsidian-maps-directions-work-detail';
    Object.assign(workProgress.style, { margin: '7px 0 0', overflowWrap: 'anywhere' });
    body.append(header, preparation, help, diagnostic, queueCounts, workProgress, resources, storage);
    details.append(summary, body);
    root.append(details);
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
    this.skipped = skipped;
    this.workProgress = workProgress;
    this.resources = resources;
    this.storage = storage;
  }
}
