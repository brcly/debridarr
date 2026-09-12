import type { ServerResponse } from 'node:http';
import { HttpError, json } from '../../http.js';
import { BusyError } from '../../security/admission.js';
import { ConflictError } from '../../downloads/coordinator.js';
import { DownloadError, downloadErrorStatus } from '../../downloads/manager.js';
import { TransferError } from '../../application/transfers.js';
import { StoreAuthThrottle } from '../../store/access.js';

// Stable machine-readable error codes. Clients branch on `code`, never on the
// prose `message`. The numeric HTTP status is derived from the code.
export const apiErrorStatus = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  unprocessable: 422,
  rate_limited: 429,
  bad_gateway: 502,
  unavailable: 503,
  insufficient_storage: 507,
  internal: 500,
} as const;
export type ApiErrorCode = keyof typeof apiErrorStatus;

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly retryAfter: number | undefined;
  constructor(code: ApiErrorCode, message: string, retryAfter?: number) {
    super(message);
    this.code = code;
    this.status = apiErrorStatus[code];
    this.retryAfter = retryAfter;
  }
}

const byStatus: Record<number, ApiErrorCode> = {
  400: 'invalid_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found',
  405: 'method_not_allowed', 409: 'conflict', 413: 'payload_too_large',
  415: 'unsupported_media_type', 422: 'unprocessable', 429: 'rate_limited',
  502: 'bad_gateway', 503: 'unavailable', 507: 'insufficient_storage',
};

const downloadErrorCode: Partial<Record<DownloadError['code'], ApiErrorCode>> = {
  low_space: 'insufficient_storage',
  space_unknown: 'unavailable',
  no_metadata: 'unavailable',
  cache_missing: 'not_found',
  no_file: 'unprocessable',
  no_infohash: 'unprocessable',
  torrent_fetch_failed: 'invalid_request',
};

// Collapse every known error family onto an `ApiError`. Unknown errors become an
// opaque 500 so internals never leak.
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof TransferError) {
    const code: ApiErrorCode = error.code === 'not_found' ? 'not_found' : error.code === 'bad_source' ? 'invalid_request' : 'unavailable';
    return new ApiError(code, error.message);
  }
  if (error instanceof DownloadError) {
    const code = downloadErrorCode[error.code] ?? byStatus[downloadErrorStatus(error)] ?? 'bad_gateway';
    return new ApiError(code, error.message, code === 'rate_limited' ? 15 : undefined);
  }
  if (error instanceof StoreAuthThrottle) return new ApiError('rate_limited', 'Too many attempts. Retry later.', error.retryAfter);
  if (error instanceof BusyError) return new ApiError('rate_limited', error.message || 'The service is busy. Retry shortly.', 15);
  if (error instanceof ConflictError) return new ApiError('conflict', error.message);
  if (error instanceof HttpError) return new ApiError(byStatus[error.status] ?? 'internal', error.message);
  return new ApiError('internal', 'An internal error occurred.');
}

export function sendApiError(response: ServerResponse, error: ApiError): void {
  const extra = error.retryAfter !== undefined ? { 'Retry-After': String(error.retryAfter) } : {};
  const requestId = response.getHeader('X-Request-Id');
  json(response, error.status, { error: { code: error.code, message: error.message }, ...(typeof requestId === 'string' ? { requestId } : {}) }, extra);
}
