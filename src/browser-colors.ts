import { normalizeLineColor } from './route-colors';

/** Let the host browser resolve CSS names/functions beyond the small pure parser. */
export function createLineColorResolver(): (value: string) => string | null {
  let context: CanvasRenderingContext2D | null = null;
  const cache = new Map<string, string | null>();
  return (value: string): string | null => {
    const parsed = normalizeLineColor(value);
    if (parsed) return parsed;
    const input = value.trim();
    const contextual = /\b(?:var\s*\(|currentcolor\b|inherit\b)/i.test(input);
    if (!contextual && cache.has(input)) return cache.get(input)!;
    let result: string | null = null;
    try {
      if (typeof document === 'undefined') return null;
      if (!context) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        context = canvas.getContext('2d', { willReadFrequently: true });
      }
      if (!context) return null;
      let color = input;
      if (contextual) {
        const probe = document.createElement('span');
        probe.style.color = input;
        if (!probe.style.color) return null;
        probe.style.display = 'none';
        document.body.append(probe);
        try { color = getComputedStyle(probe).color; }
        finally { probe.remove(); }
      }
      // Canvas ignores invalid assignments; two sentinels distinguish them from valid colors.
      context.fillStyle = '#010203';
      context.fillStyle = color;
      const first = context.fillStyle;
      context.fillStyle = '#040506';
      context.fillStyle = color;
      if (first === context.fillStyle) {
        context.clearRect(0, 0, 1, 1);
        context.fillRect(0, 0, 1, 1);
        const pixel = context.getImageData(0, 0, 1, 1).data;
        if (pixel[3]) result = '#' + [...pixel.slice(0, 3)].map(channel => channel.toString(16).padStart(2, '0')).join('');
      }
    } catch { /* An unsupported CSS value falls back to the configured single color. */ }
    if (!contextual) {
      if (cache.size >= 256) cache.delete(cache.keys().next().value!);
      cache.set(input, result);
    }
    return result;
  };
}
