/** Small validators for untrusted input. Kept dependency-free because the hook process loads them. */

export const MAX_EVENT_BYTES = 256 * 1024;

const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Parse JSON only if it fits the size limit and is a plain object. */
export function parseJsonObject(raw: string | Buffer, maxBytes = MAX_EVENT_BYTES): Record<string, unknown> | null {
  const size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length;
  if (size === 0 || size > maxBytes) return null;
  try {
    const v: unknown = JSON.parse(raw.toString());
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function asId(v: unknown): string | null {
  return typeof v === 'string' && ID.test(v) ? v : null;
}

export function asAbsolutePath(v: unknown): string | null {
  return typeof v === 'string' && v.startsWith('/') && v.length <= 4096 && !v.includes('\0') ? v : null;
}

export function asDurationMs(v: unknown): number | null {
  const n = typeof v === 'string' && /^\d{1,10}(\.\d+)?$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1e9 ? Math.round(n) : null;
}

export function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
