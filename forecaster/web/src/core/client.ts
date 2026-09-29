/**
 * The one place that talks to the engine.
 *
 * Every call goes through `request`, which turns a failure into a typed error
 * carrying a message written for a person. The engine deliberately answers a
 * forecast it will not make with 409 and an explanation — "only 12 minutes of
 * market history are available" — and that sentence is far more useful to show
 * than "request failed", so it is preserved rather than flattened.
 */

import type {
  ForecastResponse,
  Health,
  HistoryRow,
  Price,
  StatsResponse,
} from '@/core/types';

export class EngineError extends Error {
  readonly status: number;
  readonly isRefusal: boolean;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'EngineError';
    this.status = status;
    // 409 means the engine declined to forecast and said why. That is a normal
    // state to render, not an error to apologise for.
    this.isRefusal = status === 409;
  }
}

const BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      cache: 'no-store',
    });
  } catch {
    throw new EngineError('Cannot reach the forecasting engine. Is it running?', 0);
  }
  if (!response.ok) {
    let detail = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (typeof body.detail === 'string') detail = body.detail;
      else if (Array.isArray(body.detail) && body.detail.length > 0) {
        const first = body.detail[0] as { msg?: string };
        if (first?.msg) detail = first.msg;
      }
    } catch {
      // A non-JSON error body is not worth a second failure mode.
    }
    throw new EngineError(detail, response.status);
  }
  return (await response.json()) as T;
}

export function getHealth(): Promise<Health> {
  return request<Health>('/api/health');
}

export function getPrice(symbol: string): Promise<Price> {
  return request<Price>(`/api/price/${encodeURIComponent(symbol)}`);
}

export function postForecast(input: {
  symbol: string;
  target: number;
  horizons: number[];
  save?: boolean;
}): Promise<ForecastResponse> {
  return request<ForecastResponse>('/api/forecast', {
    method: 'POST',
    body: JSON.stringify({ save: true, ...input }),
  });
}

export function getHistory(limit = 50): Promise<{ predictions: HistoryRow[] }> {
  return request<{ predictions: HistoryRow[] }>(`/api/history?limit=${limit}`);
}

export function getStats(): Promise<StatsResponse> {
  return request<StatsResponse>('/api/stats');
}
