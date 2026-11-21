import fs from "fs";
import path from "path";
import { logger } from "../../logger";

/**
 * Late-payment risk model inference (logistic regression).
 * The model is trained offline by ml/train_risk_model.py, which writes
 * backend/modules/ml/models/risk-model.json. Feature engineering here MUST match
 * `build_features` in that script.
 */
export interface RiskModel {
  name: string;
  version: string;
  features: string[];
  mean: number[];
  std: number[];
  coef: number[];
  intercept: number;
  trainedAt: string;
  dataset: { name: string; source: string; rows: number; synthetic: boolean };
  metrics: Record<string, number>;
}

export interface RiskInput {
  totalCents: number;
  termsDays: number;
  priorCount: number;
  priorLateRate: number | null;
  priorAvgDaysLate: number | null;
}

export interface RiskResult {
  /** Probability the invoice is paid late, 0..1. */
  score: number;
  band: "low" | "medium" | "high";
  model: string;
  factors: Array<{ feature: string; value: number; contribution: number }>;
}

export const FEATURE_NAMES = ["log_amount", "terms_days", "log_prior_count", "prior_late_rate", "prior_avg_days_late", "has_history"] as const;

export function buildFeatures(input: RiskInput, defaults: { priorLateRate: number; priorAvgDaysLate: number }) {
  const hasHistory = input.priorCount > 0 ? 1 : 0;
  return {
    log_amount: Math.log1p(Math.max(0, input.totalCents / 100)),
    terms_days: input.termsDays,
    log_prior_count: Math.log1p(input.priorCount),
    prior_late_rate: input.priorLateRate ?? defaults.priorLateRate,
    prior_avg_days_late: input.priorAvgDaysLate ?? defaults.priorAvgDaysLate,
    has_history: hasHistory,
  };
}

let cached: RiskModel | null | undefined;

export function modelPath() {
  return path.resolve(process.cwd(), "backend", "modules", "ml", "models", "risk-model.json");
}

export function loadRiskModel(): RiskModel | null {
  if (cached !== undefined) return cached;
  try {
    const parsed = JSON.parse(fs.readFileSync(modelPath(), "utf8")) as RiskModel & { defaults?: { priorLateRate: number; priorAvgDaysLate: number } };
    const sameFeatures = parsed.features.length === FEATURE_NAMES.length && parsed.features.every((name, i) => name === FEATURE_NAMES[i]);
    if (!sameFeatures) {
      logger.error({ features: parsed.features }, "risk model features do not match inference code; scoring disabled");
      cached = null;
    } else {
      cached = parsed;
    }
  } catch {
    cached = null; // No trained model available: invoices are shown as "not scored".
  }
  return cached;
}

export function resetRiskModelCache() {
  cached = undefined;
}

export function scoreWithModel(model: RiskModel & { defaults?: { priorLateRate: number; priorAvgDaysLate: number } }, input: RiskInput): RiskResult {
  const defaults = model.defaults ?? { priorLateRate: 0, priorAvgDaysLate: 0 };
  const features = buildFeatures(input, defaults);
  let logit = model.intercept;
  const factors = model.features.map((name, i) => {
    const value = features[name as keyof typeof features];
    const standardised = (value - model.mean[i]) / (model.std[i] || 1);
    const contribution = standardised * model.coef[i];
    logit += contribution;
    return { feature: name, value: Number(value.toFixed(4)), contribution: Number(contribution.toFixed(4)) };
  });
  const score = 1 / (1 + Math.exp(-logit));
  const band = score < 0.33 ? "low" : score < 0.66 ? "medium" : "high";
  return {
    score: Number(score.toFixed(4)),
    band,
    model: `${model.name}@${model.version}`,
    factors: factors.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)),
  };
}

export function scoreRisk(input: RiskInput): RiskResult | null {
  const model = loadRiskModel();
  return model ? scoreWithModel(model, input) : null;
}
