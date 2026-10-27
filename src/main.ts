import { Notice, Plugin } from 'obsidian';
import { MapsAdapter, type AdapterStatus } from './adapter';
import { DirectionsOverlay } from './directions-overlay';
import { openDirectionsDemo, openLocalRoadsDemo } from './demo';
import { RoadRouteCache } from './route-cache';
import { AutoPreparationPolicy, PreparationQueue } from './auto-preparation';
import { TripQueue } from './trip-queue';
import { ResourceSampler } from './resource-sampler';
import { readWorkloadSettings, workloadProfile, type WorkloadSettings } from './workload-settings';
import { MapsDirectionsSettingTab } from './workload-settings-tab';
import { StorageUsageTracker, refreshStorageUsage } from './storage-usage';
import { SharedHttpCacheMonitor } from './shared-http-cache';

export default class MapsDirectionsPlugin extends Plugin {
  private adapter!: MapsAdapter;
  private status: AdapterStatus = { state: 'waiting', message: 'Waiting for official Maps and Bases.' };
  private reported = new Set<string>();
  private active = false;
  private routeCache!: RoadRouteCache;
  private automaticPolicy!: AutoPreparationPolicy;
  private tripQueue!: TripQueue;
  private workload: WorkloadSettings = readWorkloadSettings(undefined);
  private readonly resources = new ResourceSampler({ onChange: () => { if (this.active && this.adapter) this.adapter.refreshViews(); } });
  private readonly preparationQueue = new PreparationQueue();
  private readonly storage = new StorageUsageTracker(() => { if (this.active && this.adapter) this.adapter.refreshViews(); });
  private readonly sharedCache = new SharedHttpCacheMonitor({ onChange: () => { if (this.active && this.adapter) this.adapter.refreshViews(); } });
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveQueue: Promise<void> = Promise.resolve();

  async onload(): Promise<void> {
    this.active = true;
    let saved: unknown;
    try { saved = await this.loadData(); } catch { /* An unreadable cache must not prevent Maps from opening. */ }
    await refreshStorageUsage(this.app.vault.adapter, this.dataFilePath(), this.storage);
    this.routeCache = new RoadRouteCache(saved, () => this.scheduleCacheSave());
    this.automaticPolicy = new AutoPreparationPolicy(saved && typeof saved === 'object' ? (saved as Record<string, unknown>).automaticAttempts : undefined, () => this.scheduleCacheSave());
    const stored = saved && typeof saved === 'object' ? saved as Record<string, unknown> : {};
    this.tripQueue = new TripQueue(stored.tripQueue, () => this.scheduleCacheSave());
    this.workload = readWorkloadSettings(stored.workload);
    this.addSettingTab(new MapsDirectionsSettingTab(this.app, this, () => this.workload, async value => {
      this.workload = readWorkloadSettings(value); this.saveCache(); this.adapter.workloadChanged();
    }, () => this.storage.snapshot(), () => this.sharedCache.snapshot()));
    this.adapter = new MapsAdapter(
      this.app,
      view => new DirectionsOverlay(view, error => this.reportOverlayError(error), undefined, this.routeCache, { policy: this.automaticPolicy, queue: this.preparationQueue, tripQueue: this.tripQueue, workload: () => workloadProfile(this.workload), resources: () => this.resources.snapshot(), storage: () => this.storage.snapshot(), sharedCache: () => this.sharedCache.snapshot() }),
      status => {
        this.status = status;
        if (status.state === 'incompatible' && !this.reported.has(status.message)) {
          this.reported.add(status.message);
          new Notice(`Maps Directions: ${status.message}`, 9000);
        }
      },
    );
    this.register(() => {
      this.active = false;
      this.adapter.stop();
      void this.resources.stop();
      this.sharedCache.stop();
      if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; this.saveCache(); }
    });
    this.resources.start();
    await this.sharedCache.start();
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.adapter.refreshViews()));
    this.app.workspace.onLayoutReady(() => { if (this.active) this.adapter.start(); });

    this.addCommand({
      id: 'open-demo', name: 'Open directions demo',
      callback: () => {
        this.adapter.reconcile();
        if (this.status.state !== 'ready') { new Notice(`Maps Directions: ${this.status.message}`, 8000); return; }
        void openDirectionsDemo(this.app).catch((error: unknown) => {
          console.error('Maps Directions: could not open demo', error);
          new Notice('Maps Directions could not open the demo. See the developer console for details.');
        });
      },
    });
    this.addCommand({
      id: 'check-integration', name: 'Check Maps integration',
      callback: () => { this.adapter.reconcile(); new Notice(`Maps Directions: ${this.status.message}`, 8000); },
    });
    this.addCommand({
      id: 'open-local-roads-demo', name: 'Open local roads demo',
      callback: () => {
        this.adapter.reconcile();
        if (this.status.state !== 'ready') { new Notice(`Maps Directions: ${this.status.message}`, 8000); return; }
        void openLocalRoadsDemo(this.app).catch((error: unknown) => {
          console.error('Maps Directions: could not open local roads demo', error);
          new Notice('Maps Directions could not open the local roads demo. See the developer console for details.');
        });
      },
    });
    this.addCommand({ id: 'retry-road-routes', name: 'Retry missing road routes', callback: () => this.adapter.retryRoadRoutes() });
    this.addCommand({
      id: 'check-local-routing', name: 'Check local routing',
      callback: () => {
        this.adapter.reconcile();
        const statuses = this.adapter.getRoutingStatuses();
        new Notice(`Maps Directions: ${statuses.length ? statuses.join('\n\n') : 'Open a Maps view to check local routing.'}`, 15000);
      },
    });
  }

  private dataFilePath(): string {
    const directory = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    return `${directory}/data.json`;
  }

  private scheduleCacheSave(): void {
    if (!this.active) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveCache(); }, 800);
  }

  private saveCache(): void {
    const data = { ...this.routeCache.serialize(), automaticAttempts: this.automaticPolicy.serialize(), tripQueue: this.tripQueue.serialize(), workload: this.workload };
    this.saveQueue = this.saveQueue.catch(() => {}).then(async () => {
      await this.saveData(data);
      await refreshStorageUsage(this.app.vault.adapter, this.dataFilePath(), this.storage);
      if (this.active) void this.sharedCache.sampleNow();
    }).catch(error => {
      console.error('Maps Directions: could not save local route cache', error);
    });
  }

  private reportOverlayError(error: unknown): void {
    console.error('Maps Directions: overlay suspended', error);
    const message = 'Directions were suspended for this map. The original Maps view remains available. See the developer console for details.';
    if (this.reported.has(message)) return;
    this.reported.add(message);
    new Notice(`Maps Directions: ${message}`, 9000);
  }
}
