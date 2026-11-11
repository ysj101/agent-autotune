/**
 * OTLP/HTTP JSON request/response helpers. Successful exports answer with an empty
 * Export*ServiceResponse (`{}`); malformed requests get a google.rpc.Status body.
 */

export const OTLP_LOGS_PATH = '/v1/logs';
export const OTLP_METRICS_PATH = '/v1/metrics';

export const OTLP_SUCCESS_BODY = '{}';

/** google.rpc.Code.INVALID_ARGUMENT */
export function otlpErrorBody(message: string): string {
  return JSON.stringify({ code: 3, message });
}

export function isJsonContentType(header: string | undefined): boolean {
  return typeof header === 'string' && /^application\/json\b/i.test(header.trim());
}
