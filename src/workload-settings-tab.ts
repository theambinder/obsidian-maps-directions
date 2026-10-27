import { PluginSettingTab, Setting, type App, type Plugin } from 'obsidian';
import { readWorkloadSettings, workloadProfile, type WorkloadMode, type WorkloadSettings } from './workload-settings';
import { formatStorageBytes, formatStorageDelta, type StorageSnapshot } from './storage-usage';

/** Workload preferences belong to the addon, rather than individual Bases views. */
export class MapsDirectionsSettingTab extends PluginSettingTab {
  constructor(app: App, plugin: Plugin,
    private readonly getSettings: () => WorkloadSettings,
    private readonly onChange: (settings: WorkloadSettings) => void | Promise<void>,
    private readonly getStorage?: () => StorageSnapshot,
  ) { super(app, plugin); }

  private async commit(settings: WorkloadSettings, redraw = false): Promise<void> {
    try { await this.onChange(settings); if (redraw) this.display(); }
    catch (error) { console.error('Maps Directions: could not save workload settings', error); }
  }

  display(): void {
    const container = this.containerEl;
    container.empty();
    const settings = readWorkloadSettings(this.getSettings());
    const profile = workloadProfile(settings);
    new Setting(container).setName('Road preparation').setHeading();
    new Setting(container)
      .setName('Maximum road-routing distance (km)')
      .setDesc('Measured in a straight line between consecutive stops. Longer connections use straight lines without loading roads. 0 disables the limit.')
      .addText(text => {
        text.inputEl.type = 'number';
        text.inputEl.min = '0'; text.inputEl.step = '0.1';
        text.setValue(String(settings.maxDistanceKm)).onChange(value => {
          if (!value.trim()) return;
          const distance = Number(value);
          if (!Number.isFinite(distance) || distance < 0) return;
          void this.commit({ ...readWorkloadSettings(this.getSettings()), maxDistanceKm: distance });
        });
      });
    new Setting(container)
      .setName('Connect pins to roads within (m)')
      .setDesc('If a pin is off the road, allow a dashed connection up to this distance (default 250 m; range 0–1000 m). That part is not checked for walkability: a larger value may cross a barrier or select the wrong road. 0 requires the pin to be on a road. Changing this retries unresolved routes when automatic preparation is enabled; saved routes and pauses are kept.')
      .addText(text => {
        text.inputEl.type = 'number';
        text.inputEl.min = '0'; text.inputEl.max = '1000'; text.inputEl.step = '1';
        text.setValue(String(settings.maxAccessMeters)).onChange(value => {
          if (!value.trim()) return;
          const access = Number(value);
          if (!Number.isFinite(access) || access < 0 || access > 1000) return;
          void this.commit({ ...readWorkloadSettings(this.getSettings()), maxAccessMeters: access });
        });
      });
    new Setting(container)
      .setName('Processing mode')
      .setDesc('All modes run one background job at a time. Modes control chunk size, working road data and pauses; they do not guarantee a CPU percentage or a fixed amount of RAM.')
      .addDropdown(dropdown => dropdown.addOptions({ eco: 'Eco (default)', balanced: 'Balanced', maximum: 'Maximum' })
        .setValue(settings.mode).onChange(value => {
          void this.commit({ ...readWorkloadSettings(this.getSettings()), mode: value as WorkloadMode, pauseMs: null }, true);
        }));
    new Setting(container)
      .setName('Pause between chunks (seconds)')
      .setDesc('Longer pauses reduce average activity and make preparation take longer. Changing the processing mode restores its default pause.')
      .addText(text => {
        text.inputEl.type = 'number';
        text.inputEl.min = '0'; text.inputEl.max = '60'; text.inputEl.step = '0.1';
        text.setValue(String(profile.pauseMs / 1000)).onChange(value => {
          if (!value.trim()) return;
          const seconds = Number(value);
          if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) return;
          void this.commit({ ...readWorkloadSettings(this.getSettings()), pauseMs: Math.round(seconds * 1000) });
        });
      })
      .addExtraButton(button => button.setIcon('reset').setTooltip('Use the mode default pause').onClick(() => {
        void this.commit({ ...readWorkloadSettings(this.getSettings()), pauseMs: null }, true);
      }));
    new Setting(container)
      .setName(`${profile.label} working limits`)
      .setDesc(`${profile.areasPerChunk} map areas per chunk; ${profile.viewportWidth} × ${profile.viewportHeight} background viewport; ${profile.tileCacheSize} cached tiles. Working geometry: up to ${profile.maxRoadFeatures.toLocaleString('en-US')} road lines and ${profile.maxRoadPositions.toLocaleString('en-US')} coordinates. These limits apply to one working part, not the whole trip.`);
    new Setting(container)
      .setName('Resource measurements')
      .setDesc('CPU and memory readings refer to the Obsidian window process, including other plugins. They are not the addon’s isolated resource use. GPU and other application processes are not included. Unsupported measurements are shown as unavailable.');
    const storage = this.getStorage?.();
    const size = storage?.available ? storage.dataBytes : null;
    const exactBytes = size === null ? '' : ` (${size.toLocaleString('en-US')} bytes)`;
    new Setting(container)
      .setName('Saved data file')
      .setDesc(`${formatStorageBytes(size)}${exactBytes} · ${formatStorageDelta(storage?.sessionDeltaBytes)} since plugin start. Saved routes, progress and plugin settings in data.json.`)
      .addExtraButton(button => button.setIcon('refresh-cw').setTooltip('Refresh displayed storage size').onClick(() => this.display()));
  }
}
