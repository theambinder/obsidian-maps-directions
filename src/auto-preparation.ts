/** Automatic retries are bounded and independent of note labels or camera position. */
export type AutoPreparationOutcome = 'no-path' | 'unavailable';
export interface AutoPreparationData {
  version: 1;
  attempts: Array<{ key: string; outcome: AutoPreparationOutcome; recordedAt: number }>;
}

export const AUTO_RETRY_NO_PATH_MS = 24 * 60 * 60 * 1000;
export const AUTO_RETRY_UNAVAILABLE_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 500;
const validKey = (key: unknown): key is string => typeof key === 'string' && /^ap1:[\da-f]{16}:[\da-f]{16}$/.test(key);
const validOutcome = (outcome: unknown): outcome is AutoPreparationOutcome => outcome === 'no-path' || outcome === 'unavailable';
const lifetime = (outcome: AutoPreparationOutcome): number => outcome === 'no-path' ? AUTO_RETRY_NO_PATH_MS : AUTO_RETRY_UNAVAILABLE_MS;

function digest(text: string): string {
  let a = 2166136261, b = 0x9e3779b9;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 16777619);
    b = Math.imul(b ^ code, 0x85ebca6b);
  }
  const mix = (value: number): number => {
    value = Math.imul(value ^ value >>> 16, 0x85ebca6b);
    value = Math.imul(value ^ value >>> 13, 0xc2b2ae35);
    return (value ^ value >>> 16) >>> 0;
  };
  return [mix(a), mix(b)].map(value => value.toString(16).padStart(8, '0')).join('');
}

/** Only fixed-size hashes are saved; coordinates, source URLs and labels are omitted. */
export function autoPreparationKey(routeEndpointKey: string, sourceContext: string): string {
  return `ap1:${digest(routeEndpointKey)}:${digest(sourceContext)}`;
}

/** Failed automatic attempts cool down across view and app restarts. */
export class AutoPreparationPolicy {
  private readonly attempts = new Map<string, { outcome: AutoPreparationOutcome; recordedAt: number }>();

  constructor(persisted?: unknown, private readonly onChange: () => void = () => {}, private readonly now: () => number = Date.now) {
    if (!persisted || typeof persisted !== 'object') return;
    const data = persisted as Partial<AutoPreparationData>;
    if (data.version !== 1 || !Array.isArray(data.attempts)) return;
    const current = this.now();
    for (const entry of data.attempts.slice(-MAX_ATTEMPTS)) {
      if (!entry || typeof entry !== 'object' || !validKey(entry.key) || !validOutcome(entry.outcome) ||
        typeof entry.recordedAt !== 'number' || !Number.isFinite(entry.recordedAt) || entry.recordedAt < 0 ||
        entry.recordedAt > current || current - entry.recordedAt >= lifetime(entry.outcome)) continue;
      this.attempts.delete(entry.key);
      this.attempts.set(entry.key, { outcome: entry.outcome, recordedAt: entry.recordedAt });
    }
  }

  shouldAttempt(key: string): boolean {
    if (!validKey(key)) return false;
    const attempt = this.attempts.get(key);
    if (!attempt) return true;
    const elapsed = this.now() - attempt.recordedAt;
    if (elapsed >= 0 && elapsed < lifetime(attempt.outcome)) return false;
    this.attempts.delete(key);
    return true;
  }

  record(key: string, outcome: AutoPreparationOutcome): void {
    if (!validKey(key) || !validOutcome(outcome)) return;
    const recordedAt = this.now();
    if (!Number.isFinite(recordedAt) || recordedAt < 0) return;
    const previous = this.attempts.get(key);
    if (previous?.outcome === outcome && previous.recordedAt === recordedAt) return;
    this.attempts.delete(key);
    this.attempts.set(key, { outcome, recordedAt });
    while (this.attempts.size > MAX_ATTEMPTS) this.attempts.delete(this.attempts.keys().next().value!);
    this.onChange();
  }

  serialize(): AutoPreparationData {
    const current = this.now();
    return { version: 1, attempts: [...this.attempts].flatMap(([key, attempt]) =>
      current >= attempt.recordedAt && current - attempt.recordedAt < lifetime(attempt.outcome) ? [{ key, ...attempt }] : []) };
  }
}

function aborted(): Error {
  const error = new Error('Road preparation cancelled.');
  error.name = 'AbortError';
  return error;
}
interface PreparationJob { start(): void }

/** Keep one temporary map active, including while an aborted task cleans up. */
export class PreparationQueue {
  private readonly jobs: PreparationJob[] = [];
  private running = false;

  run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(aborted());
    return new Promise<T>((resolve, reject) => {
      let started = false, settled = false;
      const settle = (callback: () => void): void => { if (!settled) { settled = true; callback(); } };
      const onAbort = (): void => {
        settle(() => reject(aborted()));
        if (started) return;
        const index = this.jobs.indexOf(job);
        if (index >= 0) this.jobs.splice(index, 1);
        signal.removeEventListener('abort', onAbort);
      };
      const job: PreparationJob = { start: () => {
        started = true;
        let operation: Promise<T>;
        try {
          if (signal.aborted) throw aborted();
          operation = Promise.resolve(task());
        } catch (error) { operation = Promise.reject(error); }
        operation.then(
          value => settle(() => resolve(value)),
          error => settle(() => reject(error)),
        ).finally(() => {
          signal.removeEventListener('abort', onAbort);
          this.running = false;
          this.advance();
        });
      } };
      signal.addEventListener('abort', onAbort, { once: true });
      this.jobs.push(job);
      this.advance();
    });
  }

  private advance(): void {
    if (this.running) return;
    const next = this.jobs.shift();
    if (!next) return;
    this.running = true;
    next.start();
  }
}
