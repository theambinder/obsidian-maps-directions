import type { MapLike, MapsViewLike, OverlayLike } from './contracts';
import { directionSettings } from './settings';
import type { BackgroundMapFactory } from './background-roads';

export interface AdapterStatus {
  state: 'ready' | 'waiting' | 'incompatible';
  message: string;
}

type Callable = (this: unknown, ...args: unknown[]) => unknown;
type RecordLike = Record<string, unknown>;
interface Registration extends RecordLike { factory: Callable; options: Callable }
interface RegistrationBinding {
  registration: Registration;
  plugin: unknown;
  factory: Callable;
  options: Callable;
  wrappedFactory: Callable;
  wrappedOptions: Callable;
  active: boolean;
}
interface ViewBinding {
  view: MapsViewLike;
  owner: RegistrationBinding;
  original: Callable;
  wrapped: Callable;
  overlay: OverlayLike;
  active: boolean;
}

const record = (value: unknown): RecordLike | null =>
  value !== null && typeof value === 'object' ? value as RecordLike : null;
const callable = (value: unknown): value is Callable => typeof value === 'function';
const MAP_METHODS = [
  'isStyleLoaded', 'getSource', 'addSource', 'removeSource', 'getLayer', 'addLayer',
  'removeLayer', 'hasImage', 'addImage', 'removeImage', 'on', 'off',
];

/**
 * The only bridge to undocumented Bases/Maps internals. The official registration,
 * view, marker updater, and renderer retain their ownership and return values.
 */
export class MapsAdapter {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private detachChanges: (() => void) | null = null;
  private binding: RegistrationBinding | null = null;
  private readonly views = new Set<ViewBinding>();
  private readonly pendingViews = new WeakSet<object>();
  private failedViews = new WeakSet<object>();
  private problem: string | null = null;
  private lastStatus = '';

  constructor(
    private readonly app: unknown,
    private readonly createOverlay: (view: MapsViewLike) => OverlayLike,
    private readonly onStatus: (status: AdapterStatus) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.listenForChanges();
    this.reconcile();
    // Plugin events do not cover every Bases registration replacement. This
    // bounded check also handles Maps reloads without touching its registration.
    this.timer = setInterval(() => this.reconcile(), 1500);
    const timer = this.timer as unknown as { unref?: () => void };
    if (typeof timer.unref === 'function') timer.unref();
  }

  getRoutingStatuses(): string[] {
    return [...this.views].filter(binding => binding.active)
      .map(binding => binding.overlay.getRoutingStatus?.()).filter((status): status is string => !!status);
  }

  refreshViews(): void { for (const binding of this.views) this.update(binding); }

  retryRoadRoutes(): void {
    for (const binding of this.views) {
      const host = binding.view.map?.getContainer?.();
      if (binding.active && host?.isConnected && host.getBoundingClientRect().width > 0 && host.getBoundingClientRect().height > 0) void binding.overlay.prepareRoadRoutes?.();
    }
  }

  reconcile(): void {
    if (!this.running) return;
    try {
      const app = record(this.app);
      const plugins = record(app?.plugins);
      const internalPlugins = record(app?.internalPlugins);
      const maps = callable(plugins?.getPlugin) ? plugins.getPlugin.call(plugins, 'maps') : null;
      if (!maps) {
        this.unbind();
        this.report('waiting', 'Enable the official Maps plugin to use directions.');
        return;
      }
      const bases = callable(internalPlugins?.getEnabledPluginById)
        ? record(internalPlugins.getEnabledPluginById.call(internalPlugins, 'bases')) : null;
      if (!bases) {
        this.unbind();
        this.report('waiting', 'Enable the Bases core plugin to use directions.');
        return;
      }
      const candidate = callable(bases.getRegistration)
        ? record(bases.getRegistration.call(bases, 'map')) : null;
      if (!candidate) {
        this.unbind();
        this.report('waiting', 'Waiting for Maps to register the Map layout.');
        return;
      }
      if (!callable(candidate.factory) || !callable(candidate.options)) {
        this.unbind();
        this.report('incompatible', 'This Maps registration is not compatible. The original Map layout remains available.');
        return;
      }
      const current = this.binding;
      if (!current || current.registration !== candidate || current.plugin !== maps
        || candidate.factory !== current.wrappedFactory || candidate.options !== current.wrappedOptions) {
        this.unbind();
        this.bind(candidate as Registration, maps);
      }
      if (this.binding) this.attachExistingViews(this.binding);
      if (this.problem) {
        this.report('incompatible', this.problem);
      } else if (this.binding) {
        const version = this.mapsVersion(plugins, maps);
        this.report('ready', version === '0.2.2'
          ? 'Connected to Maps 0.2.2. Directions settings are available in the Map layout.'
          : `Connected to Maps${version ? ` ${version}` : ''}. Compatibility is checked at runtime; tested with Maps 0.2.2.`);
      }
    } catch {
      this.unbind();
      this.report('incompatible', 'The Maps integration could not be initialized. The original Map layout remains available.');
    }
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    try { this.detachChanges?.(); } catch { /* A reloaded event source may already be gone. */ }
    this.detachChanges = null;
    this.unbind();
  }

  private bind(registration: Registration, plugin: unknown): void {
    const adapter = this;
    const binding: RegistrationBinding = {
      registration, plugin, factory: registration.factory, options: registration.options,
      wrappedFactory: function () {}, wrappedOptions: function () {}, active: true,
    };
    binding.wrappedFactory = function (this: unknown, ...args: unknown[]): unknown {
      // Never catch errors from the official factory or substitute its result.
      const view = binding.factory.apply(this, args);
      if (binding.active) adapter.attach(view, binding, true);
      return view;
    };
    binding.wrappedOptions = function (this: unknown, ...args: unknown[]): unknown {
      const options = binding.options.apply(this, args);
      if (!binding.active) return options;
      if (!Array.isArray(options)) {
        adapter.fail('Maps returned an unsupported settings format. The original Map settings remain available.');
        return options;
      }
      try {
        const config = record(args[0]);
        const get = config?.get;
        const reader = callable(get) ? { get: (key: string): unknown => get.call(config, key) } : undefined;
        return [...options, ...directionSettings(reader)];
      }
      catch {
        adapter.fail('Directions settings could not be added. The original Map settings remain available.');
        return options;
      }
    };
    this.binding = binding;
    try {
      registration.factory = binding.wrappedFactory;
      registration.options = binding.wrappedOptions;
    } catch {
      this.unbind();
      this.report('incompatible', 'The Maps registration cannot be extended. The original Map layout remains available.');
    }
  }

  private attach(value: unknown, owner: RegistrationBinding, deferConfig = false): void {
    const candidate = record(value);
    if (!candidate) {
      this.fail('Maps returned an unsupported view. The original Map view remains available.');
      return;
    }
    if (this.failedViews.has(candidate)) return;
    if ([...this.views].some(binding => binding.view === value)) return;
    try {
      // Bases assigns view.config immediately AFTER its factory returns and
      // addChild() loads the new component (verified in Obsidian 1.14.4).
      // Only that exact incomplete state gets a deferred attempt. All other
      // members still have to match the official Maps boundary.
      if (candidate.config == null && this.hasMapsCore(candidate)) {
        if (deferConfig) this.deferUntilConfigured(candidate, owner);
        return;
      }
      if (!this.isMapsView(candidate)) {
        this.failedViews.add(candidate);
        this.fail('This Maps view is not compatible with directions. The original Map view remains available.');
        return;
      }
      const view = candidate as unknown as MapsViewLike;
      const overlay = this.createOverlay(view);
      if (!overlay || typeof overlay.update !== 'function' || typeof overlay.destroy !== 'function') {
        // A partially constructed overlay is still given a chance to clean up.
        try { overlay?.destroy?.(); } catch { /* Only addon resources are affected. */ }
        throw new Error('Unsupported directions overlay');
      }
      const adapter = this;
      const binding: ViewBinding = {
        view, owner, original: view.markerManager.updateMarkers,
        wrapped: function () {}, overlay, active: true,
      };
      binding.wrapped = function (this: unknown, ...args: unknown[]): unknown {
        // Let original synchronous errors and promise rejections propagate. Only
        // a successful original update schedules the additional direction layer.
        const result = binding.original.apply(this, args);
        const promise = record(result);
        if (promise && callable(promise.then)) {
          return promise.then.call(result, (value: unknown) => {
            adapter.update(binding);
            return value;
          });
        }
        adapter.update(binding);
        return result;
      };
      this.views.add(binding);
      try {
        view.markerManager.updateMarkers = binding.wrapped;
        view.register(() => this.detachView(binding));
      } catch (error) {
        this.detachView(binding);
        throw error;
      }
      // Existing views have already completed their last marker update.
      this.update(binding);
    } catch {
      this.failedViews.add(candidate);
      this.fail('Directions could not attach to this Maps view. The original Map view remains available.');
    }
  }

  private deferUntilConfigured(candidate: RecordLike, owner: RegistrationBinding): void {
    if (this.pendingViews.has(candidate)) return;
    this.pendingViews.add(candidate);
    let alive = true;
    try {
      (candidate.register as Callable).call(candidate, () => {
        alive = false;
        this.pendingViews.delete(candidate);
      });
    } catch (error) {
      this.pendingViews.delete(candidate);
      throw error;
    }
    queueMicrotask(() => {
      this.pendingViews.delete(candidate);
      if (alive && this.running && owner.active) this.attach(candidate, owner);
      // If a future Bases version takes longer to configure the view, normal
      // bounded reconciliation can attach it later through the component tree.
    });
  }

  private update(binding: ViewBinding): void {
    if (!binding.active || !binding.owner.active) return;
    try { binding.overlay.update(); }
    catch {
      this.failedViews.add(binding.view);
      this.detachView(binding);
      this.fail('Directions were disabled for a Map view after an error. The original Map view remains available.');
    }
  }

  private detachView(binding: ViewBinding): void {
    if (!binding.active) return;
    binding.active = false;
    this.views.delete(binding);
    try {
      if (binding.view.markerManager.updateMarkers === binding.wrapped) {
        binding.view.markerManager.updateMarkers = binding.original;
      }
    } catch { /* Do not interfere with a view that Maps has already destroyed. */ }
    try { binding.overlay.destroy(); } catch { /* Cleanup must never break Maps unload. */ }
  }

  private unbind(): void {
    const binding = this.binding;
    this.binding = null;
    if (binding) {
      binding.active = false;
      try {
        if (binding.registration.factory === binding.wrappedFactory) binding.registration.factory = binding.factory;
      } catch { /* A replaced registration belongs to its new owner. */ }
      try {
        if (binding.registration.options === binding.wrappedOptions) binding.registration.options = binding.options;
      } catch { /* A replaced registration belongs to its new owner. */ }
    }
    for (const view of [...this.views]) this.detachView(view);
    this.problem = null;
    this.failedViews = new WeakSet<object>();
  }

  private isMapsView(value: RecordLike): boolean {
    const config = record(value.config);
    return !!config && callable(config.get) && callable(config.getAsPropertyId)
      && this.hasMapsCore(value);
  }

  private hasMapsCore(value: RecordLike): boolean {
    const manager = record(value.markerManager);
    const map = record(value.map);
    return value.type === 'map' && callable(value.register)
      && !!manager && Array.isArray(manager.markers) && callable(manager.updateMarkers)
      && (value.map === null || !!map && MAP_METHODS.every(method => callable(map[method])));
  }

  private attachExistingViews(owner: RegistrationBinding): void {
    const workspace = record(record(this.app)?.workspace);
    if (!callable(workspace?.iterateAllLeaves)) return;
    // Verified in Obsidian 1.14.4: Bases controllers and embedded Bases renders
    // are Component children. Traverse that lifecycle tree, not arbitrary fields.
    const visited = new Set<object>();
    const visit = (value: unknown): void => {
      const component = record(value);
      if (!component || visited.has(component) || visited.size >= 10000) return;
      visited.add(component);
      if (component.type === 'map' && 'markerManager' in component
        && (!('plugin' in component) || component.plugin === owner.plugin)) this.attach(component, owner);
      if (Array.isArray(component._children)) {
        for (const child of component._children) visit(child);
      }
    };
    try {
      workspace.iterateAllLeaves.call(workspace, (leaf: unknown) => visit(record(leaf)?.view));
    } catch {
      // New views still attach through the factory if the workspace API changes.
    }
  }

  private listenForChanges(): void {
    const plugins = record(record(this.app)?.plugins);
    if (!callable(plugins?.on)) return;
    const listener = () => this.reconcile();
    try {
      const ref = plugins.on.call(plugins, 'changed', listener);
      this.detachChanges = () => {
        if (callable(plugins.offref) && ref != null) plugins.offref.call(plugins, ref);
        else {
          const source = record(record(ref)?.e);
          if (callable(source?.offref)) source.offref.call(source, ref);
          else if (callable(plugins.off)) plugins.off.call(plugins, 'changed', listener);
        }
      };
    } catch { /* Polling is sufficient when plugin events are unavailable. */ }
  }

  private mapsVersion(plugins: RecordLike | null, plugin: unknown): string | null {
    const manifest = record(record(plugins?.manifests)?.maps) ?? record(record(plugin)?.manifest);
    return typeof manifest?.version === 'string' ? manifest.version : null;
  }

  private fail(message: string): void {
    this.problem = message;
    this.report('incompatible', message);
  }

  private report(state: AdapterStatus['state'], message: string): void {
    const key = `${state}:${message}`;
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    try { this.onStatus({ state, message }); } catch { /* Status UI cannot affect Maps. */ }
  }
}

/** Reuse the installed renderer only when its public map operations are available. */
export function getBackgroundMapFactory(map: MapLike): BackgroundMapFactory | null {
  const constructor = map.constructor;
  if (typeof constructor !== 'function' || constructor === Object) return null;
  const prototype = constructor.prototype as Record<string, unknown> | undefined;
  if (!prototype || !['on', 'off', 'jumpTo', 'remove', 'getStyle', 'getZoom', 'querySourceFeatures'].every(key => typeof prototype[key] === 'function')) return null;
  return options => Reflect.construct(constructor, [options]);
}
