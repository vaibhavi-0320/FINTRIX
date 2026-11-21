"""
Generate the SYNTHETIC accounts-receivable ledger used to train the Fintrix
late-payment risk model.

Why synthetic: no public invoice-level payment dataset with a verified,
permissive licence was found. The widely circulated IBM "Accounts Receivable"
sample is itself simulated and its licence could not be verified, so it is not
used (see DATASET_DOCUMENTATION.md).

What this means: a model trained on this data learns the assumptions coded
below. Its metrics measure how well it recovers this generating process, NOT
real-world predictive power. The data contains no real companies or people.

Generative assumptions (all documented, all adjustable):
  * Each buyer has a latent payment reliability z ~ N(0, 1) (higher = pays on time).
  * Each buyer has a typical invoice size; invoice amounts are log-normal around it.
  * Payment terms are drawn from {15, 30, 45, 60, 90} days.
  * P(late) = sigmoid(-0.55 - 1.1 z + 0.25 (ln amount - 8) + 0.012 (terms - 30) + e),
    e ~ N(0, 0.6). Larger invoices and longer terms are slightly riskier.
  * If late, days late = 1 + Gamma(1.5, 8 exp(-0.4 z)).

Usage:  python ml/generate_dataset.py [--seed 42] [--buyers 600] [--out ml/data/synthetic_ar_ledger.csv]
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

GENERATOR_VERSION = "1.0.0"
TERMS = np.array([15, 30, 45, 60, 90])
TERM_PROBS = np.array([0.15, 0.40, 0.20, 0.15, 0.10])


def generate(seed: int = 42, n_buyers: int = 600) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    start = np.datetime64("2023-01-01")
    span_days = 3 * 365

    rows = []
    invoice_id = 0
    for buyer in range(n_buyers):
        reliability = rng.normal(0.0, 1.0)
        size = rng.lognormal(mean=8.0, sigma=1.0)  # typical invoice ~ $3k
        n_invoices = rng.poisson(12) + 1
        issue_offsets = np.sort(rng.integers(0, span_days, size=n_invoices))
        for offset in issue_offsets:
            amount = float(np.clip(rng.lognormal(np.log(size), 0.5), 50, 500_000))
            terms = int(rng.choice(TERMS, p=TERM_PROBS))
            logit = -0.55 - 1.1 * reliability + 0.25 * (np.log(amount) - 8.0) + 0.012 * (terms - 30) + rng.normal(0, 0.6)
            late = rng.random() < 1.0 / (1.0 + np.exp(-logit))
            days_late = int(1 + round(rng.gamma(1.5, 8.0 * np.exp(-0.4 * reliability)))) if late else 0
            issue = start + np.timedelta64(int(offset), "D")
            due = issue + np.timedelta64(terms, "D")
            rows.append(
                {
                    "invoice_id": f"SYN-{invoice_id:06d}",
                    "buyer_id": f"BUYER-{buyer:04d}",
                    "issue_date": str(issue),
                    "due_date": str(due),
                    "settled_date": str(due + np.timedelta64(days_late, "D")),
                    "amount_usd": round(amount, 2),
                    "terms_days": terms,
                    "days_late": days_late,
                    "is_late": int(days_late > 0),
                }
            )
            invoice_id += 1
    return pd.DataFrame(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--buyers", type=int, default=600)
    parser.add_argument("--out", type=Path, default=Path("ml/data/synthetic_ar_ledger.csv"))
    args = parser.parse_args()

    df = generate(args.seed, args.buyers)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(args.out, index=False)
    print(f"wrote {len(df)} synthetic invoices for {df.buyer_id.nunique()} buyers to {args.out} (late rate {df.is_late.mean():.3f})")


if __name__ == "__main__":
    main()
