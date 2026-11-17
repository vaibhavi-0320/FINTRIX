"""
Train and evaluate the Fintrix late-payment risk model.

Task:     predict P(invoice is paid after its due date) at listing time.
Model:    standardised logistic regression (interpretable; deployable as JSON).
Baselines: constant base rate, buyer's prior late rate, gradient boosting (capacity check).
Split:    time-based - train on invoices issued before 2025-07-01, test on later ones,
          so no future information leaks into training.
Output:   backend/modules/ml/models/risk-model.json  (served by the API)
          ml/reports/risk_model_report.json          (full metrics)
          ml/reports/parity_cases.json               (TS/Python inference parity test)

Feature engineering MUST stay identical to buildFeatures() in backend/modules/ml/risk.ts.

Usage:  python ml/train_risk_model.py [--data ml/data/synthetic_ar_ledger.csv]
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import sklearn
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, average_precision_score, brier_score_loss, log_loss, roc_auc_score
from sklearn.preprocessing import StandardScaler

FEATURES = ["log_amount", "terms_days", "log_prior_count", "prior_late_rate", "prior_avg_days_late", "has_history"]
SPLIT_DATE = "2025-07-01"
MODEL_VERSION = "1.0.0"


def buyer_history(df: pd.DataFrame) -> pd.DataFrame:
    """For each invoice, summarise the same buyer's invoices whose outcome was known
    (settled) strictly before this invoice's issue date. Leakage-safe by construction."""
    df = df.sort_values(["buyer_id", "issue_date"]).reset_index(drop=True)
    prior_count = np.zeros(len(df))
    prior_late = np.full(len(df), np.nan)
    prior_days = np.full(len(df), np.nan)
    for _, group in df.groupby("buyer_id"):
        idx = group.index.to_numpy()
        settled = group["settled_date"].to_numpy()
        late = group["is_late"].to_numpy()
        days = group["days_late"].to_numpy()
        for pos, row_index in enumerate(idx):
            known = settled < group["issue_date"].iloc[pos]
            if known.any():
                prior_count[row_index] = known.sum()
                prior_late[row_index] = late[known].mean()
                prior_days[row_index] = days[known].mean()
    out = df.copy()
    out["prior_count"] = prior_count
    out["prior_late_rate_raw"] = prior_late
    out["prior_avg_days_late_raw"] = prior_days
    return out


def build_features(df: pd.DataFrame, defaults: dict) -> pd.DataFrame:
    """Mirror of buildFeatures() in backend/modules/ml/risk.ts."""
    return pd.DataFrame(
        {
            "log_amount": np.log1p(df["amount_usd"].clip(lower=0)),
            "terms_days": df["terms_days"].astype(float),
            "log_prior_count": np.log1p(df["prior_count"]),
            "prior_late_rate": df["prior_late_rate_raw"].fillna(defaults["priorLateRate"]),
            "prior_avg_days_late": df["prior_avg_days_late_raw"].fillna(defaults["priorAvgDaysLate"]),
            "has_history": (df["prior_count"] > 0).astype(float),
        }
    )[FEATURES]


def metrics(y_true, p) -> dict:
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return {
        "roc_auc": float(roc_auc_score(y_true, p)),
        "pr_auc": float(average_precision_score(y_true, p)),
        "brier": float(brier_score_loss(y_true, p)),
        "log_loss": float(log_loss(y_true, p)),
        "accuracy_at_0_5": float(accuracy_score(y_true, p >= 0.5)),
    }


def bootstrap_auc(y, p, n=500, seed=7) -> list[float]:
    rng = np.random.default_rng(seed)
    y, p = np.asarray(y), np.asarray(p)
    scores = []
    for _ in range(n):
        sample = rng.integers(0, len(y), len(y))
        if y[sample].min() == y[sample].max():
            continue
        scores.append(roc_auc_score(y[sample], p[sample]))
    return [float(np.percentile(scores, 2.5)), float(np.percentile(scores, 97.5))]


def calibration_table(y, p, bins=5) -> list[dict]:
    edges = np.linspace(0, 1, bins + 1)
    table = []
    for low, high in zip(edges[:-1], edges[1:]):
        mask = (p >= low) & (p < high if high < 1 else p <= high)
        if mask.sum():
            table.append({"bin": f"{low:.1f}-{high:.1f}", "count": int(mask.sum()), "mean_predicted": float(p[mask].mean()), "observed_rate": float(np.asarray(y)[mask].mean())})
    return table


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, default=Path("ml/data/synthetic_ar_ledger.csv"))
    parser.add_argument("--model-out", type=Path, default=Path("backend/modules/ml/models/risk-model.json"))
    parser.add_argument("--report-dir", type=Path, default=Path("ml/reports"))
    args = parser.parse_args()

    raw = pd.read_csv(args.data)
    df = buyer_history(raw)
    train_mask = df["issue_date"] < SPLIT_DATE
    train, test = df[train_mask], df[~train_mask]

    defaults = {"priorLateRate": float(train["is_late"].mean()), "priorAvgDaysLate": float(train["days_late"].mean())}
    x_train, x_test = build_features(train, defaults), build_features(test, defaults)
    y_train, y_test = train["is_late"].to_numpy(), test["is_late"].to_numpy()

    scaler = StandardScaler().fit(x_train)
    logreg = LogisticRegression(C=1.0, max_iter=1000).fit(scaler.transform(x_train), y_train)
    p_logreg = logreg.predict_proba(scaler.transform(x_test))[:, 1]

    gbm = HistGradientBoostingClassifier(max_iter=200, learning_rate=0.05, random_state=0).fit(x_train, y_train)
    p_gbm = gbm.predict_proba(x_test)[:, 1]

    p_base = np.full(len(y_test), defaults["priorLateRate"])
    p_rule = x_test["prior_late_rate"].to_numpy()

    results = {
        "logistic_regression": {**metrics(y_test, p_logreg), "roc_auc_95ci": bootstrap_auc(y_test, p_logreg)},
        "gradient_boosting": metrics(y_test, p_gbm),
        "baseline_constant_rate": metrics(y_test, p_base),
        "baseline_prior_late_rate": metrics(y_test, p_rule),
    }
    test_no_history = x_test["has_history"].to_numpy() == 0
    subgroup = {
        "buyers_with_history": metrics(y_test[~test_no_history], p_logreg[~test_no_history]),
        "buyers_without_history": metrics(y_test[test_no_history], p_logreg[test_no_history]) if test_no_history.sum() > 20 and len(set(y_test[test_no_history])) > 1 else None,
        "share_without_history": float(test_no_history.mean()),
    }

    model = {
        "name": "fintrix-late-payment-logreg",
        "version": MODEL_VERSION,
        "features": FEATURES,
        "mean": scaler.mean_.tolist(),
        "std": scaler.scale_.tolist(),
        "coef": logreg.coef_[0].tolist(),
        "intercept": float(logreg.intercept_[0]),
        "defaults": defaults,
        "trainedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sklearnVersion": sklearn.__version__,
        "dataset": {
            "name": "Fintrix synthetic AR ledger",
            "source": "ml/generate_dataset.py (seed 42, 600 buyers)",
            "rows": int(len(df)),
            "trainRows": int(len(train)),
            "testRows": int(len(test)),
            "synthetic": True,
        },
        "metrics": {key: round(value, 4) for key, value in results["logistic_regression"].items() if isinstance(value, float)},
    }
    args.model_out.parent.mkdir(parents=True, exist_ok=True)
    args.model_out.write_text(json.dumps(model, indent=2))

    args.report_dir.mkdir(parents=True, exist_ok=True)
    report = {
        "split": {"type": "time-based", "train_before": SPLIT_DATE, "train_rows": int(len(train)), "test_rows": int(len(test))},
        "label_rate": {"train": float(y_train.mean()), "test": float(y_test.mean())},
        "test_metrics": results,
        "subgroups": subgroup,
        "calibration_logreg": calibration_table(y_test, p_logreg),
        "coefficients_standardised": dict(zip(FEATURES, [round(c, 4) for c in logreg.coef_[0]])),
        "note": "Synthetic data: metrics measure recovery of the documented generating process, not real-world performance.",
    }
    (args.report_dir / "risk_model_report.json").write_text(json.dumps(report, indent=2))

    # Parity cases: raw inputs (as the API sees them) and the Python probability.
    cases = []
    for _, row in test.head(8).iterrows():
        raw_input = {
            "totalCents": int(round(row["amount_usd"] * 100)),
            "termsDays": float(row["terms_days"]),
            "priorCount": int(row["prior_count"]),
            "priorLateRate": None if np.isnan(row["prior_late_rate_raw"]) else float(row["prior_late_rate_raw"]),
            "priorAvgDaysLate": None if np.isnan(row["prior_avg_days_late_raw"]) else float(row["prior_avg_days_late_raw"]),
        }
        # Recompute from the cents value exactly as the TS code does.
        frame = pd.DataFrame([{**row.to_dict(), "amount_usd": raw_input["totalCents"] / 100}])
        prob = logreg.predict_proba(scaler.transform(build_features(frame, defaults)))[0, 1]
        cases.append({"input": raw_input, "expected": float(prob)})
    (args.report_dir / "parity_cases.json").write_text(json.dumps(cases, indent=2))

    lr = results["logistic_regression"]
    print(f"rows={len(df)} train={len(train)} test={len(test)} late_rate_test={y_test.mean():.3f}")
    for name, result in results.items():
        print(f"{name:28s} roc_auc={result['roc_auc']:.4f} pr_auc={result['pr_auc']:.4f} brier={result['brier']:.4f} log_loss={result['log_loss']:.4f}")
    print(f"logreg ROC AUC 95% CI: {lr['roc_auc_95ci'][0]:.4f}-{lr['roc_auc_95ci'][1]:.4f}")
    print(f"wrote {args.model_out}")


if __name__ == "__main__":
    main()
