# Runbook: the card terminal's end-of-day total does not match the Z-report

Status: v0.9, 4 Nov 2026. For the closing cashier and the manager. Sail records card payments as the cashier types them; the terminal is the source of truth for what was actually charged. The Z-report shows each card tender's total at 34 pt next to the reminder "Compare with the terminal's end-of-day total" for this reason.

## Before closing

1. Settle the terminal (its end-of-day or batch close) and keep the printed summary.
2. On the POS, open **Shift → Z-report** (or Reports → Z-report in the back office) for the station or the whole outlet. Compare the **Card** total (and PayNow, if separate) with the terminal summary, by amount and by count.

## If they match

Close the shift as usual. Staple the terminal summary to the shift's printed Z-report, or photograph both for the shared drive.

## If they do not match

Work from the bigger difference down. Typical causes and the fix for each:

| Symptom | Likely cause | Fix in Sail |
|-|-|-|
| Terminal has one more charge than Sail | A payment was taken on the terminal but **not recorded** in Sail (the station timed out, or the cashier closed the panel) | Find the order (Orders → today, filter unpaid or partly paid). Record the card payment with the terminal's reference number. If the order was completed another way by mistake, the manager **reopens** it (same business day), fixes the payment, completes again. |
| Sail has one more card payment than the terminal | A payment was **recorded** in Sail but the terminal transaction failed or was voided | Manager: refund that bill's card payment in Sail with the kind **amount** and the reason "terminal declined", refund method **card** (no money moves; it records that nothing was charged). Then take the payment again correctly, or record the tender actually used. Sail does not have a "void payment" operation in v0.9; the refund and credit note are the audit trail. |
| Same count, different amount on one transaction | **Wrong amount typed** on the terminal, or a tip added on the terminal | If the terminal charged more: record the extra as a tip on the payment if that is what it was (tips are reported separately), otherwise refund the difference on the terminal and leave Sail as is. If the terminal charged less: take the difference on the terminal and record a second payment in Sail with the reference. |
| Same amount, wrong tender | **Cash recorded as card** or the reverse | Manager: refund the bill (kind full, back to the tender recorded), then record the payment again with the right tender. Both appear on the exception report with the reason. |
| Everything off by small amounts | **Cash rounding** compared with the wrong figure | Rounding only applies to cash. Compare the card total with the card figure, not the tender total. |

Every correction above is an ordinary Sail operation with a reason, so the void, discount and refund report shows who did what and why.

## Still different

Record the variance in the shift close (**Counted** vs **Expected** for cash; the variance reason field for the shift) and leave a note for Finance with both printed summaries. Do not edit the database. Finance reconciles against the acquirer's settlement file the next day with the parallel-run script (`scripts/reconcile-day.py`) during the beta.
