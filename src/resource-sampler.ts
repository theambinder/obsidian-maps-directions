export const RESOURCE_SCOPE = 'Obsidian window process (includes other plugins)';
export interface ResourceReading { cpuSeconds?: number; privateBytes?: number }
export type ResourceProbe = () => ResourceReading | Promise<ResourceReading>;
export interface ResourceSample { elapsedMs: number; cpuPercent: number | null; memoryMb: number | null }
export interface ResourceSnapshot {
  scope: string;
  running: boolean;
  elapsedMs: number;
  samples: number;
  currentCpuPercent: number | null;
  averageCpuPercent: number | null;
  peakCpuPercent: number | null;
  currentMemoryMb: number | null;
  baselineMemoryMb: number | null;
  peakMemoryMb: number | null;
  memoryDeltaMb: number | null;
  cpuTimeMs: number | null;
}
export interface ResourceReport extends ResourceSnapshot { history: ResourceSample[] }
export interface ResourceSamplerOptions {
  probe?: ResourceProbe;
  now?: () => number;
  intervalMs?: number;
  onChange?: (snapshot: ResourceSnapshot) => void;
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object';

/** Probe the current renderer process only, without accessing note contents. */
export function createRendererResourceProbe(processObject: unknown = (globalThis as { process?: unknown }).process): ResourceProbe {
  return async () => {
    if (!record(processObject)) return {};
    const result: ResourceReading = {};
    try {
      // Node's cumulative counters avoid resetting Electron's shared sample interval.
      if (typeof processObject.cpuUsage === 'function') {
        const cpu: unknown = processObject.cpuUsage();
        if (record(cpu) && finite(cpu.user) && finite(cpu.system)) result.cpuSeconds = (cpu.user + cpu.system) / 1000000;
      } else if (typeof processObject.getCPUUsage === 'function') {
        const cpu: unknown = processObject.getCPUUsage();
        if (record(cpu) && finite(cpu.cumulativeCPUUsage)) result.cpuSeconds = cpu.cumulativeCPUUsage;
      }
    } catch { /* Unsupported process APIs are reported as unavailable. */ }
    try {
      if (typeof processObject.getProcessMemoryInfo === 'function') {
        const memory: unknown = await processObject.getProcessMemoryInfo();
        if (record(memory) && finite(memory.private)) result.privateBytes = memory.private * 1024;
      }
    } catch { /* A memory reading must never interrupt routing. */ }
    return result;
  };
}

/** Bounded local telemetry. Values include the rest of the current window process. */
export class ResourceSampler {
  private readonly probe: ResourceProbe;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly onChange?: ResourceSamplerOptions['onChange'];
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<ResourceSnapshot> | null = null;
  private generation = 0;
  private running = false;
  private startedAt = 0;
  private endedAt = 0;
  private count = 0;
  private firstCpu: number | null = null;
  private firstCpuAt = 0;
  private previousCpu: number | null = null;
  private previousCpuAt = 0;
  private currentCpu: number | null = null;
  private peakCpu: number | null = null;
  private cumulativeCpuMs = 0;
  private measuredCpuMs = 0;
  private memory: number | null = null;
  private baselineMemory: number | null = null;
  private peakMemory: number | null = null;
  private readonly history: ResourceSample[] = [];

  constructor(options: ResourceSamplerOptions = {}) {
    this.probe = options.probe ?? createRendererResourceProbe();
    this.now = options.now ?? (() => performance.now());
    this.intervalMs = finite(options.intervalMs) ? Math.max(250, Math.min(10000, options.intervalMs)) : 1000;
    this.onChange = options.onChange;
  }

  start(): void {
    if (this.running) return;
    this.generation++;
    this.running = true;
    this.startedAt = this.endedAt = this.now();
    this.count = 0; this.firstCpu = this.previousCpu = this.currentCpu = this.peakCpu = null;
    this.firstCpuAt = this.previousCpuAt = this.startedAt;
    this.cumulativeCpuMs = this.measuredCpuMs = 0;
    this.memory = this.baselineMemory = this.peakMemory = null;
    this.history.length = 0;
    void this.sampleNow();
    this.timer = setInterval(() => { void this.sampleNow(); }, this.intervalMs);
  }

  sampleNow(): Promise<ResourceSnapshot> {
    if (!this.running) return Promise.resolve(this.snapshot());
    if (this.pending) return this.pending;
    const generation = this.generation, sampledAt = this.now();
    const operation = Promise.resolve().then(() => this.probe()).then(reading => {
      if (!this.running || generation !== this.generation) return this.snapshot();
      this.count++;
      if (finite(reading.cpuSeconds)) {
        if (this.firstCpu === null) { this.firstCpu = reading.cpuSeconds; this.firstCpuAt = sampledAt; }
        if (this.previousCpu !== null && sampledAt > this.previousCpuAt && reading.cpuSeconds >= this.previousCpu) {
          const elapsed = sampledAt - this.previousCpuAt, cpuMs = (reading.cpuSeconds - this.previousCpu) * 1000;
          // Very short final reads contribute to the average, but cannot create
          // a misleading instantaneous peak from timer/counter resolution.
          if (elapsed >= 250) {
            this.currentCpu = cpuMs / elapsed * 100;
            this.peakCpu = Math.max(this.peakCpu ?? 0, this.currentCpu);
          }
          this.cumulativeCpuMs += cpuMs;
          this.measuredCpuMs += elapsed;
        } else if (this.previousCpu === null || reading.cpuSeconds < this.previousCpu) this.currentCpu = null;
        this.previousCpu = reading.cpuSeconds; this.previousCpuAt = sampledAt;
      } else this.currentCpu = null;
      if (finite(reading.privateBytes)) {
        this.memory = reading.privateBytes / 1048576;
        this.baselineMemory ??= this.memory;
        this.peakMemory = Math.max(this.peakMemory ?? this.memory, this.memory);
      } else this.memory = null;
      this.endedAt = sampledAt;
      this.history.push({ elapsedMs: Math.max(0, sampledAt - this.startedAt), cpuPercent: this.currentCpu, memoryMb: this.memory });
      if (this.history.length > 1800) this.history.shift();
      const snapshot = this.snapshot();
      try { this.onChange?.(snapshot); } catch { /* UI reporting cannot interrupt routing. */ }
      return snapshot;
    }, () => this.snapshot()).finally(() => { if (this.pending === operation) this.pending = null; });
    this.pending = operation;
    return operation;
  }

  snapshot(): ResourceSnapshot {
    return {
      scope: RESOURCE_SCOPE, running: this.running,
      elapsedMs: Math.max(0, (this.running ? this.now() : this.endedAt) - this.startedAt), samples: this.count,
      currentCpuPercent: this.currentCpu,
      averageCpuPercent: this.measuredCpuMs > 0 ? this.cumulativeCpuMs / this.measuredCpuMs * 100 : null,
      peakCpuPercent: this.peakCpu, currentMemoryMb: this.memory,
      baselineMemoryMb: this.baselineMemory, peakMemoryMb: this.peakMemory,
      memoryDeltaMb: this.memory !== null && this.baselineMemory !== null ? this.memory - this.baselineMemory : null,
      cpuTimeMs: this.firstCpu !== null && this.previousCpu !== null ? this.cumulativeCpuMs : null,
    };
  }

  async stop(): Promise<ResourceReport> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.running) {
      if (this.pending) await this.pending;
      await this.sampleNow();
      this.endedAt = this.now(); this.running = false;
      this.generation++;
    }
    try { this.onChange?.(this.snapshot()); } catch { /* UI reporting cannot interrupt cleanup. */ }
    return this.report();
  }

  report(): ResourceReport { return { ...this.snapshot(), history: this.history.map(sample => ({ ...sample })) }; }
}
