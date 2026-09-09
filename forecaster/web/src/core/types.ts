/**
 * The shapes the engine returns.
 *
 * Deliberately mirrors the Python schemas rather than inventing a friendlier
 * client-side model. One definition of what a forecast is, on both sides of the
 * wire, so a field cannot quietly mean two things.
 */

export const SYMBOLS = ['BTC-USD', 'ETH-USD'] as const;
export type Symbol = (typeof SYMBOLS)[number];

export const HORIZONS = [300, 1200] as const;
export type Horizon = (typeof HORIZONS)[number];

export type Confidence = 'low' | 'moderate' | 'high';
export type Direction = 'above' | 'below' | 'neutral';
export type DataSource = 'live' | 'replay' | 'simulated';

export interface Signal {
  name: string;
  label: string;
  direction: Direction;
  weight: number;
  detail: string;
}

export interface HorizonForecast {
  horizon_s: number;
  p_above: number;
  p_below: number;
  z: number;
  sigma: number;
  sigma_pct: number;
  range_low: number;
  range_high: number;
  range_confidence: number;
  median: number;
  confidence: Confidence;
  confidence_reasons: string[];
  as_of: string;
  expires_at: string;
  expires_in_s: number;
  model_version: string;
  model_train_source: DataSource;
  calibration_source: DataSource | null;
  prediction_id: number | null;
  signals: Signal[];
}

export interface ForecastResponse {
  symbol: string;
  spot: number;
  target: number;
  distance: number;
  distance_pct: number;
  venue: string;
  data_source: DataSource;
  service_level: string;
  is_live: boolean;
  warnings: string[];
  forecasts: HorizonForecast[];
}

export interface Price {
  symbol: string;
  price: number;
  bid: number | null;
  ask: number | null;
  spread_bps: number | null;
  as_of: string;
  age_s: number | null;
  stale: boolean;
  venue: string;
  data_source: DataSource;
  service_level: string;
}

export interface HistoryRow {
  id: number;
  created_at: string;
  expires_at: string;
  expires_in_s: number;
  symbol: string;
  horizon_s: number;
  spot: number;
  target: number;
  p_above: number;
  predicted_side: 'above' | 'below';
  confidence: Confidence;
  model_version: string;
  data_source: DataSource;
  model_train_source: DataSource;
  outcome: string | null;
  eval_price: number | null;
  correct: boolean | null;
  brier: number | null;
  resolved: boolean;
}

export interface CalibrationBucket {
  low: number;
  high: number;
  count: number;
  mean_predicted: number;
  observed_rate: number;
  ci_low: number;
  ci_high: number;
  consistent: boolean;
}

export interface GroupStats {
  symbol: string;
  horizon_s: number;
  n: number;
  brier?: number;
  log_loss?: number;
  accuracy?: number;
  ece?: number;
  base_rate?: number;
  mean_predicted?: number;
  brier_skill?: number | null;
  sample_size?: Record<string, number>;
  sample_size_note?: string;
  can_claim_calibration?: boolean;
  calibration_note?: string;
  calibration?: { ece: number; max_error: number; buckets: CalibrationBucket[] };
  probability_buckets?: Array<{
    low: number;
    high: number;
    n: number;
    predicted: number | null;
    observed: number | null;
    ci_low: number | null;
    ci_high: number | null;
  }>;
  note?: string;
}

export interface StatsResponse {
  data_source: string | null;
  total_resolved: number;
  groups: Record<string, GroupStats>;
  by_target_distance: Array<Record<string, number>>;
  by_confidence: Array<Record<string, unknown>>;
  void_analysis: Record<string, number>;
  honesty_note: string;
}

export interface Health {
  status: string;
  data_source: DataSource;
  venue: string;
  provider_connected: boolean;
  symbols: Record<string, Record<string, unknown>>;
  collector: Record<string, number | null>;
  predictions: number;
  chain_verified_rows: number | null;
  models: Array<Record<string, unknown>>;
  warnings: string[];
}
