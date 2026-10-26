import { Notice, Plugin } from 'obsidian';
import { MapsAdapter, type AdapterStatus } from './adapter';
import { DirectionsOverlay } from './directions-overlay';
import { openDirectionsDemo, openLocalRoadsDemo } from './demo';

export default class MapsDirectionsPlugin extends Plugin {
  private adapter!: MapsAdapter;
  private status: AdapterStatus = { state: 'waiting', message: 'Waiting for official Maps and Bases.' };
  private reported = new Set<string>();
  private active = false;

  onload(): void {
    this.active = true;
    this.adapter = new MapsAdapter(
      this.app,
      view => new DirectionsOverlay(view, error => this.reportOverlayError(error)),
      status => {
        this.status = status;
        if (status.state === 'incompatible' && !this.reported.has(status.message)) {
          this.reported.add(status.message);
          new Notice(`Maps Directions: ${status.message}`, 9000);
        }
      },
    );
    this.register(() => { this.active = false; this.adapter.stop(); });
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
    this.addCommand({
      id: 'check-local-routing', name: 'Check local routing',
      callback: () => {
        this.adapter.reconcile();
        const statuses = this.adapter.getRoutingStatuses();
        new Notice(`Maps Directions: ${statuses.length ? statuses.join('\n\n') : 'Open a Maps view to check local routing.'}`, 15000);
      },
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
