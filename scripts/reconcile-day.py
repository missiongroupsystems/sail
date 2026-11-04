#!/usr/bin/env python3
"""Parallel-run reconciliation (roadmap v0.9): compare one business day in Sail with the
outlet's legacy POS, tender by tender and in total, and list the differences.

Inputs
  --sail   CSV from GET /v1/reports/sales-summary?outlet_id=...&from=D&to=D&format=csv
  --legacy CSV exported from the legacy POS and mapped to the generic layout below
           (one row per tender; amounts in cents; a header row is required):
             business_date,tender,amount_cents,count
             2026-11-04,Cash,123450,87
             2026-11-04,Card,456700,152
  --tolerance  cents of difference to accept per tender (default 0)

Usage
  python3 scripts/reconcile-day.py --sail sales-summary.csv --legacy legacy-day.csv
Exit code 0 when every tender and the total agree within tolerance, 1 otherwise.
Python is allowed here by scope doc 10.2 condition 6 (ops scripts only).
"""
import argparse
import csv
import sys
from collections import defaultdict


def read_sail(path):
    tenders, total_net, refunds = {}, None, 0
    with open(path, newline="") as f:
        for row in csv.reader(f):
            if not row:
                continue
            if row[0] == "by_tender":
                # by_tender,<tender>,<is_cash>,<count>,<amount>,<rounding>,<tips>
                tenders[row[1]] = {"amount": int(row[4]), "count": int(row[3]), "rounding": int(row[5])}
            elif row[0] == "totals":
                kv = dict(zip(row[1::2], row[2::2]))
                total_net = int(kv["net"])
                refunds = int(kv.get("refunds", 0))
    if total_net is None:
        sys.exit("sail CSV has no totals row; export sales-summary with format=csv")
    return tenders, total_net, refunds


def read_legacy(path):
    tenders = defaultdict(lambda: {"amount": 0, "count": 0})
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            t = tenders[row["tender"].strip()]
            t["amount"] += int(row["amount_cents"])
            t["count"] += int(row.get("count") or 0)
    return tenders


def dollars(c):
    sign = "-" if c < 0 else ""
    return f"{sign}${abs(c) // 100}.{abs(c) % 100:02d}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sail", required=True)
    ap.add_argument("--legacy", required=True)
    ap.add_argument("--tolerance", type=int, default=0)
    a = ap.parse_args()
    sail, sail_net, sail_refunds = read_sail(a.sail)
    legacy = read_legacy(a.legacy)
    ok = True
    print(f"{'tender':<16}{'sail':>14}{'legacy':>14}{'diff':>12}  note")
    for tender in sorted(set(sail) | set(legacy)):
        s = sail.get(tender, {"amount": 0, "count": 0, "rounding": 0})
        l = legacy.get(tender, {"amount": 0, "count": 0})
        # Sail records cash after rounding; the legacy figure may be pre-rounding. Show both readings.
        diff = s["amount"] - l["amount"]
        note = ""
        if tender not in legacy:
            note = "not in legacy export"
        elif tender not in sail:
            note = "not in Sail"
        elif abs(diff) > a.tolerance:
            alt = s["amount"] + s.get("rounding", 0) - l["amount"]
            note = "cash rounding explains it" if abs(alt) <= a.tolerance else f"count {s['count']} vs {l['count']}"
        if abs(diff) > a.tolerance:
            ok = False
        print(f"{tender:<16}{dollars(s['amount']):>14}{dollars(l['amount']):>14}{dollars(diff):>12}  {note}")
    sail_total = sum(t["amount"] for t in sail.values())
    legacy_total = sum(t["amount"] for t in legacy.values())
    print(f"{'TOTAL':<16}{dollars(sail_total):>14}{dollars(legacy_total):>14}{dollars(sail_total - legacy_total):>12}")
    print(f"Sail net sales {dollars(sail_net)}; refunds {dollars(sail_refunds)}; tenders received {dollars(sail_total)}")
    if abs(sail_total - legacy_total) > a.tolerance:
        ok = False
    print("RECONCILED" if ok else "DIFFERENCES FOUND: review the rows above with Finance")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
