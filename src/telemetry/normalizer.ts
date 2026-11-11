import type { Outcome } from '../hooks/types.js';
import { asDurationMs, asId, asObject } from '../security/sanitize.js';

/**
 * Normalize standard OTLP/HTTP JSON payloads from Claude Code into the few fields AutoTune uses.
 * Only allowlisted attributes are read; identity attributes (user.email, user.id, organization.id,
 * account ids, ...) and anything unknown are ignored and never leave this module.
 */

export interface OtelToolResult {
  session_id: string;
  tool_use_id: string | null;
  prompt_id: string | null;
  event_sequence: number | null;
  tool_name: string;
  outcome: Outcome;
  duration_ms: number | null;
  observed_at: string;
}

export type Temporality = 'delta' | 'cumulative' | 'unknown';

export interface MetricPoint {
  name: string;
  series_key: string;
  start_time: string;
  time: string;
  day: string;
  temporality: Temporality;
  value: number;
}

export const ALLOWED_METRICS = ['claude_code.session.count', 'claude_code.token.usage', 'claude_code.cost.usage'] as const;
const SERIES_ATTRIBUTES = ['session.id', 'type', 'model'] as const;
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
const MIN_TIME_MS = Date.UTC(2000, 0, 1);
const MAX_TIME_MS = Date.UTC(2100, 0, 1);
const LABEL = /^[A-Za-z0-9_.:\-[\]]{1,64}$/;

type Attrs = Map<string, unknown>;

/** Decode an OTLP AnyValue into a primitive. Arrays/kvlists/bytes are not needed and ignored. */
function anyValue(v: unknown): unknown {
  const o = asObject(v);
  if (!o) return undefined;
  if (typeof o['stringValue'] === 'string') return o['stringValue'];
  if (typeof o['boolValue'] === 'boolean') return o['boolValue'];
  if (typeof o['intValue'] === 'string' || typeof o['intValue'] === 'number') return Number(o['intValue']);
  if (typeof o['doubleValue'] === 'number') return o['doubleValue'];
  return undefined;
}

function readAttrs(list: unknown, keys: readonly string[], into: Attrs = new Map()): Attrs {
  if (!Array.isArray(list)) return into;
  for (const item of list) {
    const kv = asObject(item);
    const key = kv?.['key'];
    if (typeof key !== 'string' || !keys.includes(key) || into.has(key)) continue;
    const value = anyValue(kv?.['value']);
    if (value !== undefined) into.set(key, value);
  }
  return into;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function nanosToIso(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v);
  if (!/^\d{1,20}$/.test(s)) return null;
  const ms = Number(BigInt(s) / 1_000_000n);
  // Telemetry outside 2000..2100 is a malformed clock or payload, not data.
  if (ms < MIN_TIME_MS || ms > MAX_TIME_MS) return null;
  return new Date(ms).toISOString();
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v)) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

const TOOL_RESULT_KEYS = ['event.name', 'session.id', 'prompt.id', 'event.sequence', 'event.timestamp', 'tool_name', 'tool_use_id', 'success', 'duration_ms'];

export function normalizeLogs(body: unknown): OtelToolResult[] {
  const out: OtelToolResult[] = [];
  for (const rl of arr(asObject(body)?.['resourceLogs'])) {
    const resource = asObject(asObject(rl)?.['resource']);
    for (const sl of arr(asObject(rl)?.['scopeLogs'])) {
      for (const lr of arr(asObject(sl)?.['logRecords'])) {
        const rec = asObject(lr);
        if (!rec) continue;
        const attrs = readAttrs(rec['attributes'], TOOL_RESULT_KEYS);
        readAttrs(resource?.['attributes'], TOOL_RESULT_KEYS, attrs);
        const bodyName = anyValue(rec['body']);
        if (attrs.get('event.name') !== 'tool_result' && bodyName !== 'claude_code.tool_result') continue;
        const sessionId = asId(attrs.get('session.id'));
        const toolName = attrs.get('tool_name');
        if (!sessionId || typeof toolName !== 'string' || !TOOL_NAME.test(toolName)) continue;
        const success = attrs.get('success');
        const seq = attrs.get('event.sequence');
        const observedAt = isoOrNull(attrs.get('event.timestamp')) ?? nanosToIso(rec['timeUnixNano']) ?? nanosToIso(rec['observedTimeUnixNano']);
        if (!observedAt) continue;
        out.push({
          session_id: sessionId,
          tool_use_id: asId(attrs.get('tool_use_id')),
          prompt_id: asId(attrs.get('prompt.id')),
          event_sequence: typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? seq : null,
          tool_name: toolName,
          outcome: success === 'true' || success === true ? 'success' : success === 'false' || success === false ? 'failure' : 'unknown',
          duration_ms: asDurationMs(attrs.get('duration_ms')),
          observed_at: observedAt,
        });
      }
    }
  }
  return out;
}

function temporalityOf(v: unknown): Temporality {
  if (v === 1 || v === 'AGGREGATION_TEMPORALITY_DELTA') return 'delta';
  if (v === 2 || v === 'AGGREGATION_TEMPORALITY_CUMULATIVE') return 'cumulative';
  return 'unknown';
}

export function normalizeMetrics(body: unknown): MetricPoint[] {
  const out: MetricPoint[] = [];
  for (const rm of arr(asObject(body)?.['resourceMetrics'])) {
    for (const sm of arr(asObject(rm)?.['scopeMetrics'])) {
      for (const m of arr(asObject(sm)?.['metrics'])) {
        const metric = asObject(m);
        const name = metric?.['name'];
        if (typeof name !== 'string' || !(ALLOWED_METRICS as readonly string[]).includes(name)) continue;
        const sum = asObject(metric?.['sum']);
        if (!sum) continue;
        const temporality = temporalityOf(sum['aggregationTemporality']);
        for (const dp of arr(sum['dataPoints'])) {
          const point = asObject(dp);
          if (!point) continue;
          const raw = point['asDouble'] ?? point['asInt'];
          const value = typeof raw === 'string' ? Number(raw) : raw;
          const time = nanosToIso(point['timeUnixNano']);
          const start = nanosToIso(point['startTimeUnixNano']) ?? time;
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !time || !start) continue;
          const attrs = readAttrs(point['attributes'], SERIES_ATTRIBUTES);
          const series: Record<string, string> = {};
          for (const key of SERIES_ATTRIBUTES) {
            const v = attrs.get(key);
            if (typeof v === 'string' && LABEL.test(v)) series[key] = v;
          }
          out.push({ name, series_key: JSON.stringify(series), start_time: start, time, day: time.slice(0, 10), temporality, value });
        }
      }
    }
  }
  return out;
}
