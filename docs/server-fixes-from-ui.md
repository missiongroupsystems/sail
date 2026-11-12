# Server fixes found from the front ends

Found while working on `packages/ui`, `web` and `guest` on branch `fix/ui-locale`. Each root cause sits in `packages/server` or `packages/shared`, so none is fixed on that branch. Each entry has a reproduction against `dev:local`, the cause and a proposed fix.

## 1. A station without a PIN is refused its POS channel link (403 on every POS load)

**Reproduce.** Pair a station, then call the endpoint with the station token alone, as the POS lock screen does:

```
GET /v1/channel-links?channel=pos&outlet_id=…&brand_id=…   (station token, no PIN session)
→ 403 permission_denied "channel_links.list needs a signed-in staff member"
```

The same token gets 200 from `GET /v1/channel-links/{id}/menu` and `GET /v1/layouts/{id}`.

**Should the POS call it?** Yes. `LockScreen.tsx` warms the menu and layout while the iPad is locked (design 5.2: cold start to the floor in 3 s or less) and takes the outlet name from the menu. It needs the link id to ask for the menu. `menu.get` and `layouts.get` already allow a bare station (`minRole: null`, principals include `station`), so the link lookup is the odd one out.

**Cause.** `server/src/lib/crud.ts:45` gives every `defineCrud` group a read role of `"server"` unless the config says otherwise. The channel-links config in `routes/floor.ts` lists `station` among the read principals but sets no `roles`, so a station passes the principal check and then fails the role check in `lib/openapi.ts:137`.

**Fix.** Add `roles: { read: null }` to the channel-links `defineCrud` in `routes/floor.ts`, regenerate `openapi.json` and the MCP manifest (`min_role` changes for `channel_links.list` and `channel_links.get`), and add a server test that a station token lists its `channel=pos` link. The e2e suite allows this one 403 by name (`STATION_CHANNEL_LINK_403` in `packages/e2e/tests/fixtures.ts`), and the `station channel link` test pins today's 403, so it fails once this is fixed. Then flip that test to expect 200 and remove the allowance.

## 2. A second phone at the table sees accepted guest lines under "Added by staff"

**Reproduce.** Seat a table, rotate its QR and open two guest sessions on it (A and B). A sends a round and staff accept it. Then `GET /v1/guest/order`:

```
A: rounds 1, lines [Canned drink, source guest, round_id e3b7…], round line_ids [1]
B: rounds 0, lines [Canned drink, source guest, round_id e3b7…]
```

The guest app files lines that belong to no listed round under "Added by staff", so phone B shows the guest's own order as staff additions.

**Cause.** `drizzle/0014_rls_guest.sql:44`:

```sql
CREATE POLICY guest_rounds_guest ON guest_rounds FOR SELECT TO app_guest
  USING (merchant_id = sail.merchant_id() AND guest_session_id::text = sail.principal_id());
```

`guestOrderView` in `services/guest.ts:194` reads every round on the order and marks the caller's own with `mine`, but the policy only returns rounds from the caller's session.

**Fix.** A new migration that widens the policy to the order the session is bound to, as the order-lines policy does with `app.current_order`, for example `USING (merchant_id = sail.merchant_id() AND (guest_session_id::text = sail.principal_id() OR order_id::text = current_setting('app.current_order', true)))`. `set_config(..., true)` is transaction-local (`services/guest.ts:181`), so check the rounds query runs in the same transaction. Add a test with two sessions on one table.

## 3. "Net sales" includes tax and fees, and the Z-report ignores refunds

**Reproduce.** Take an order with service charge and GST, refund part of it, then open the Z-report: "Net sales" equals the sum of order totals, tax and fees included, and the refund does not move it. The back office's new Sales report shows the same `net` figure.

**Cause.**
- `services/shifts.ts:38` computes `net: coalesce(sum(total),0)`, and `services/reports.ts:60` (`salesSummary`) does the same.
- `total` is the amount collected, so it includes tax and fees in both tax modes.
- The Z-report has no refund line. `salesSummary.net_after_refunds` subtracts refund totals (tax included) from a tax-included figure.
- `by_category.net` and the product mix use line `net_amount`, so "net" means two things in one response.

**Fix.** This depends on the tax-model rework, so it belongs with the gst → tax change. Define net sales as gross minus discounts, excluding tax and fees. Show fees and refunds on their own lines, add net sales after refunds using the refunds' net, and keep the collected figure as its own field (for example `sales.total`) so tender reconciliation still adds up. The front ends keep the label "Net sales" on this branch because the right label depends on that decision; `ZReportBody.tsx`, `ZReportView.tsx` (POS) and `SalesView.tsx` change with the new fields.

## 4. Settings the front ends read

Every amount, date and time in `ui`, `web` and `guest` goes through `LocaleProvider` / `useLocale` in `packages/ui`. These are the fields it reads:

| Field | Where | Today | Front-end fallback |
|-|-|-|-|
| `currency` (ISO 4217) | `GET /v1/merchant` → `data.settings.currency` | exists | none needed |
| `timezone` (IANA) | `GET /v1/merchant` → `data.settings.timezone` | exists | none needed |
| `locale` (BCP 47) | `GET /v1/merchant` → `data.settings.locale` | being added | the browser's: `Accept-Language` on the server, `navigator.language` on the iPad |
| `cash_denominations` (integer minor units) | `GET /v1/merchant` → `data.settings.cash_denominations` | missing | a 1-2-5 series from the smallest coin (the cash rounding increment when set) up to 100 major units, or 10,000 for a currency with no minor unit |

**The guest app cannot read any of them.** `merchants.get` is for staff, stations and agents. Please add `currency`, `locale` and `timezone` under `data.settings` on `POST /v1/guest/sessions` and `GET /v1/guest/receipts/{token}`, with the names above. The guest types already expect them there (`GuestSession.settings`, `ReceiptRead.settings`). Until then the guest app shows amounts in the browser's number format with no currency symbol and two decimals, and times in the phone's zone. The zone is right because the phone is in the room. The two decimals are wrong for a 0- or 3-decimal currency.

**Before the PIN.** `GET /v1/merchant` also refuses a bare station, so the POS reads it after sign-in, and the lock-screen clock uses the iPad's zone. If the lock screen should show outlet time, `merchants.get` needs the same change as item 1.

**Cash variance threshold.** The POS asks for a reason when the counted cash is more than 500 minor units off (`VARIANCE_THRESHOLD_CENTS` in `ShiftHome.tsx`, there before this branch). That is $5 but ¥500 or KWD 0.500. It should be an outlet or merchant setting in minor units, read the same way as the fields above.

**Currency exponent.** The front ends take the number of minor units from `Intl.NumberFormat(locale, { style: "currency", currency }).resolvedOptions().maximumFractionDigits` (JPY 0, USD 2, KWD 3). If the server stores any currency at a different exponent from ISO 4217, expose it (for example as `settings.currency_exponent`) and the provider needs a one-line change to prefer it.
