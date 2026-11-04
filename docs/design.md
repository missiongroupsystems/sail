# Sail design spec: POS, back office and guest ordering

Status: draft for discussion, 3 Nov 2026.
Sources: `docs/sail-v0.9-scope.md` (the scope doc) is the authority on *what* v0.9 contains, `docs/roadmap.md` on *when*, and `docs/agent-centric-vision.md` (the vision) on how agents work. Section numbers such as §4.3 refer to the scope doc unless they say otherwise.

**Phil's brief.** Sail must feel:
- **Ultra-intuitive and self-explanatory.** New floor staff are productive in minutes, with no training.
- **Agentic-forward and built for autonomy.** Agents propose, prefill and act; humans glance, confirm or override.
- **Beautifully designed, not generic SaaS.**

The primary surface is the **iPad Safari POS in landscape, during a busy service**. The back office and the guest QR ordering page follow.

**One thing this spec does not change:** the register (the API) owns every amount and every state change (§7.1 rule 1; vision §2). The UI shows the register's numbers; it never computes its own. Agent features follow the vision. The roadmap has not yet been reconciled with the vision (vision §13), so every screen here also **works fully with agents switched off**.

## 1. Design principles

1. **The room comes first.** Sail is used at arm's length, standing, in dim light, one-handed, with wet or greasy fingers, while someone is talking to you. Everything is readable from about 70 cm. Every target is big. Nothing needs precision.
2. **One obvious next step.** Every POS screen has one primary action, in the same place: bottom right, in the **action dock**. The label says what happens next, for example "Send 4 to kitchen", "Pay $86.40", "Approve refund". A new staff member can always find out what to do by looking at the bottom-right button.
3. **Nothing hidden.** No long-press, swipe-only or double-tap actions, and no unlabelled icons on the POS. A gesture may be a shortcut, but every action also has a visible, labelled button. This is what "no training" means in practice.
4. **Plain words, not POS jargon.** The UI says "Bill", "Send to kitchen", "Sold out" and "Manager approval". It does not say "check", "fire", "86" or "override grant", even though the API does (glossary in section 1.1). Staff who know the jargon still recognise the plain words; new staff do not have to learn it.
5. **The register speaks; the assistant suggests.** Register facts (amounts, statuses, totals) are solid, in tabular figures, with no decoration. Agent content (suggestions, pending lines, proposals) always wears the **agent treatment**: a dashed outline, the agent mark, and the agent hue (section 7.3). A glance tells you whether something is fact or suggestion. **Model text never shows an amount.** Every amount on an agent card is rendered from register data (vision §7.4).
6. **Prefilled by default.** Every form opens with the most likely answer already in it: the balance in the payment amount, the original tenders in a refund, the active seat on a new line, or the assistant's reading of what was said. Confirming is one tap. Changing it is one more.
7. **Friction in proportion to risk.** Friction follows the vision's risk tiers exactly:

   | Tier | Examples | Friction in the UI |
   |-|-|-|
   | T0 read | Look at an order, quote a refund | None |
   | T1 routine, reversible | Add a line, split, mark sold out, reroute a ticket | **Just do it, then offer Undo** |
   | T2 consequential | Send to kitchen, take a payment, apply a discount | **One deliberate tap** on a button that states the effect |
   | T3 restricted | Refund, void a sent item, reopen, config change | **Manager PIN**, shown with the register's quote of the effect |

   Confirmation dialogs ("Are you sure?") are never used for T1 or T2. Undo and an explicit button label do that job better.
8. **Lines may be optimistic; money never is.** A tapped item appears in the order sheet straight away. Totals change only when the register replies. While they wait, they show a quiet "pricing" state, never a number the client guessed. (The POS preview may use the shared `price` function, §4.3, but the display is labelled as a preview until the server confirms it.)
9. **Ambient by default, interruptive by exception.** Agent activity, notifications and status live at the edges of the screen until they need you. Only a few events may interrupt, and never on top of the primary action (section 2.2).
10. **One grammar on every surface.** A line, a bill, a proposal and an attribution look and behave the same on the POS, in the back office and, where it applies, in the guest app. Learn it once.
11. **Crafted, calm, warm.** No dashboard of cards, no gradients, no illustrations of people at laptops. The look is typography-led, with warm neutrals, hairlines instead of shadows, and colour kept for meaning. It should feel like a well-made tool in a kitchen: confident, quiet and fast.
12. **Brands tint; Sail's controls stay the same.** Staff move between outlets and brands. The brand shows up in identity (name, accent stripe, tile colours, the guest app), but the controls keep their position, shape and primary colour everywhere (section 9).

### 1.1 Glossary: API term to UI term

| API / data model | UI (POS and guest) | Note |
|-|-|-|
| check | **Bill** ("Bill 1", "Bill 2") | |
| fire | **Send** ("Send to kitchen", "Sent 7:42") | |
| hold | **Hold** | |
| 86 / sold out | **Sold out** | "86" appears as a secondary label for staff who use it |
| void | **Remove** before sending; **Void** after sending | A void after sending is a real kitchen event, so it keeps a strong word |
| override grant | **Manager approval** | |
| proposal | **Request** (from the assistant) | |
| tender | **Payment method** | |
| order type | **Dine-in, Takeaway, Pickup, Delivery** | |
| guest round | **QR order** | |
| service request | **Table request** | |
| changeset | **Change** (back office: "Changes waiting for review") | |
| agent | **Assistant** (with its role, for example "Manager assistant") | |

## 2. How agent activity shows up

### 2.1 The agent's visual identity

- **The agent mark:** a small three-point sail glyph, used only for agents.
- **The agent treatment:** a 1.5 pt dashed outline, the agent hue (section 7.3) at low opacity as the fill, and the mark in the top-left corner. The treatment applies to **anything the register has not yet committed** that an agent produced: pending lines, prefilled fields, requests.
- **Attribution chips** on committed things show who did them: `MT` (a person's initials) or `◭ Assistant · for MT` (an agent acting on behalf of MT). Committed agent work looks like any other committed work, apart from the chip. Once the register accepts something, it is a fact.
- **Agents are never people.** No avatar faces, no first names, no "I". The assistant speaks in short, neutral statements: "Matched 4 items. 1 needs a choice."

### 2.2 Five levels of presence

| Level | Name | What it looks like | Used for | Interrupts? |
|-|-|-|-|-|
| L0 | Trace | Attribution chip in the order history and audit | Everything an agent did | No |
| L1 | Ambient | A count badge on the top bar, a badge on a table, a one-line status in the order header | "2 requests waiting", "Assistant rerouted 3 tickets" | No |
| L2 | Inline | Pending lines in the order sheet; prefilled fields in a form | The cashier assistant's reading of an order; refund prefill | Only where the user is already looking |
| L3 | Request card | A card in the Requests tray (top bar), with a badge | Proposals that need a manager (refunds, comps, voids) | No: the badge counts up, the card waits |
| L4 | Banner | A full-width banner under the top bar, which stays until it is resolved | Service-affecting events: a kitchen ticket not printed within 10 s (§4.7), a request that this station is waiting on, a connection loss | **Yes**, but never as a modal and never covering the action dock |

**Interruption rules:**
- **At most one L4 banner at a time** per station. Others queue behind it, with a "+2" count.
- **A banner never moves the action dock** and never covers the order sheet's totals. The layout reserves space for it.
- **Modals are reserved for PIN entry**, which the user started. Nothing an agent does opens a modal.
- **Busy mode.** When an outlet has more than a set number of open orders (outlet setting; default 12), or a manager turns it on, L3 cards show only as badges, and L1 status lines are hidden. L4 banners and anything the user started are unaffected.
- **Agent work never steals focus.** If an agent adds pending lines while staff are typing in the search field, the cursor stays where it is.

### 2.3 Confidence: what to check, not a percentage

Model probabilities are not calibrated, and "87% confident" tells a cashier nothing about what to check. The UI shows confidence **per field**, in three states:

| State | Meaning | UI |
|-|-|-|
| **Matched** | The register resolved it exactly: one product, valid modifiers | A normal pending line in the agent treatment |
| **Choose** | Several matches, or a required modifier is missing | The field is highlighted, with the options inline as chips: "Laksa: **Prawn** · **Chicken** · **Vegetarian**". The pending line cannot be added until a choice is made. |
| **Not found** | Nothing matched, or the item is sold out or unavailable | A struck-out ghost line with the reason ("Sold out at this outlet", "Not on the dinner menu") and a search button |

**The assistant never guesses silently.** Any choice it could not settle exactly is shown as **Choose**. The "Add all" button says how many lines are ready: "Add 4 · 1 needs a choice".

### 2.4 Requests (proposals): approve or reject with a PIN

The anatomy of a request card is the same in the POS tray, on the order screen and in the back office:

```
┌ ◭ Manager assistant · for Raj · 2 min ago ─────────────── expires in 8:12 ┐
╎ Refund $19.18 to Visa ••42                                                ╎
╎ Table 12 · Bill 2 · Laksa (prawn) ×1                                      ╎
╎                                                                           ╎
╎   Laksa (prawn)            −$16.00     ← every amount here is from the   ╎
╎   Service charge 10%        −$1.60       register's refund quote         ╎
╎   GST 9%                    −$1.58                                        ╎
╎   ─────────────────────────────────                                       ╎
╎   Refund total             −$19.18                                        ╎
╎                                                                           ╎
╎ “Guest reports main arrived 35 min after mains; playbook: late main,      ╎
╎  refund the dish.”                       ← agent note, shown as a quote  ╎
╎ Evidence: sent 7:42 · ready 8:17 · complaint noted 8:20                   ╎
╎                                                                           ╎
╎ [ Reject ]   [ Edit… ]                          [ Approve with PIN ▸ ]    ╎
└╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘
```

- **Title:** verb, amount, target. It is generated from the frozen operation and the register's quote, not from model text.
- **Agent note:** shown in quotation marks and in the secondary text colour, so it reads as someone's words, not a system fact. It is untrusted text (vision §11) and is never rendered as rich text or links.
- **Approve with PIN** opens the PIN pad as a sheet over the card. On success the card collapses into a confirmation line ("Refunded $19.18 · approved by Aisha") and the receipt prints. Then the card leaves the tray.
- **Reject** asks for a one-tap reason (Not needed, Wrong amount, Wrong item, Guest declined, Other…). Rejections go back to the agent and into the evals (vision §9.4).
- **Edit…** takes the human into the normal manual screen (for example the refund flow, section 4.6), prefilled with the request. The request is then withdrawn: the human now owns the action.
- **Stale requests.** If the order changes, the card greys out with "Order changed. The assistant is checking again." Approve is disabled. The register would refuse it anyway (vision §7.4).
- **Expiry** is shown as a countdown. Expired cards fade into the tray's history.

### 2.5 Undo

- Every T1 action, whoever did it, shows an **Undo toast** at the **bottom left** for 8 seconds: "Added Kopi Peng ×2 · Undo", "Assistant rerouted 3 tickets to Pass · Undo". It sits at the opposite corner from the primary action, so a quick second tap on the primary button can never hit Undo by accident.
- Undo calls the compensating primitive (remove the line, reroute back, restore the stock). It is recorded like any other action.
- T2 and T3 actions have no Undo, because they cannot be taken back: food has gone to the kitchen, or money has moved. Their reversal path (Void, Refund) is one tap from the result screen instead.

### 2.6 Attended confirmation (T2)

When the assistant prepares a T2 action at a station, the action dock's primary button turns into a **confirm bar** that states the register-rendered effect:

```
┌────────────────────────────────────────────────────────────────────┐
│ ◭ Send 4 items · Kitchen ×3, Bar ×1          [ Send to kitchen ▸ ] │
└────────────────────────────────────────────────────────────────────┘
```

The staff member taps the same button in the same place they always tap. The assistant never presses it.

### 2.7 With agents off

- The intent bar, the Requests tray and the agent status lines disappear. **The layout does not leave gaps**: the catalogue grid takes the intent bar's space.
- The Requests tray is replaced by **Approvals**, which still lists override requests from other staff, if remote approval is on (section 4.7).
- If the assistant becomes unavailable mid-task, its pending lines stay where they are, marked "Assistant unavailable. Add or remove these yourself." Nothing is lost and nothing is added on its own.

## 3. Information architecture

### 3.1 POS (iPad, landscape)

Design target: **1180 × 820 pt** (iPad 10th generation and iPad Air 11"). Minimum: **1024 × 768** (older 10.2" models scale the catalogue grid down by one column). Sail runs as a home-screen web app (standalone mode, section 11.3), so there is no Safari chrome.

```
Station locked (PIN)
└─ Top bar (always): Floor | Orders | Shift     ·  Requests ◭ 2 · Alerts ⚠ 1 · MT ▾ · ● online
   ├─ Floor ─────────── tap a table ──► Order
   │    └─ "Now" rail: QR orders to accept, table requests, ready pickups, requests
   ├─ Orders (takeaway, pickup, delivery; open and today's closed) ──► Order
   │    └─ [+ New order: Takeaway · Pickup · Delivery]
   ├─ Order
   │    ├─ Catalogue (layout pages > folders > tiles) + search + intent bar
   │    ├─ Order sheet (lines by state, totals, action dock)
   │    ├─ Bill ──► Split · Pre-bill · Pay ──► Receipt
   │    └─ Order menu: Change type · Move table · Customer · Refund · Reopen · History
   └─ Shift: open/close shift · Z-report · Sold-out list · Printers · Reprints
```

- **Three destinations, no more.** Floor, Orders and Shift cover the whole POS. Everything else is reached from an order or from Shift.
- **Depth.** Any common action is at most two levels below a destination.
- **Back is always top left**, labelled with where it goes ("◂ Floor").
- **The station remembers its home.** A dine-in station opens on Floor; a counter station opens on a new takeaway order (station setting).

### 3.2 Back office (desktop-first, works on iPad)

```
Scope picker: Merchant ▸ Brand ▸ Outlet (top left; every page respects it)
Left navigation:
  Today ............ live outlet status, alerts, requests waiting, print health
  Orders ........... today and all orders, order detail drawer (§4.11)
  Menu ............. products, modifiers, menus and sections, availability, sold out
  Pricing .......... rules, simulator, customer groups, tax and rounding settings
  Floor & QR ....... areas, tables, QR sheets
  Printing ......... printers, relays, test prints
  Team ............. staff, roles, outlet scope
  Reports .......... §4.10 reports
  Changes ◭ 3 ...... changes waiting for review, scheduled, applied
  Assistants ....... identities, playbooks, activity and traces, budgets, on/off switch
  Settings ......... outlets, brands, stations, channels, tenders, void reasons, receipts
Right drawer (any page): Assistant (chat; results land as Changes, never as direct edits)
```

- Every write goes through **Changes** (vision §5.13). Simple forms save as one-item changes and auto-submit for Admins, so small edits still feel direct.
- **Today** is the home page: what needs a person now. It is not a KPI dashboard.

### 3.3 Guest ordering (phone, portrait)

```
Scan QR ─► Table 12 · <Brand>
           ├─ Menu (sections as sticky tabs) ─► Item sheet ─► back to menu
           ├─ Basket (sticky bar) ─► Review ─► Send ─► Order status
           ├─ Our table (everything ordered so far, with statuses)
           └─ Call staff (table requests + Ask for the bill)
```

There is no login, no payment and no account, ever (§4.6).

## 4. Key screens and flows

Tap counts in this section are checked against the speed budgets in section 5.

### 4.1 Lock and sign-in

- **Lock screen:** the outlet and station name, a clock, and a large PIN pad (digits 48 pt, keys 88 × 72 pt). After 4 digits the "Unlock" label appears; the pad unlocks on the 6th digit with no extra tap.
- **Switch user:** tap your initials in the top bar, then "Switch user", then enter a PIN. The current order stays open for the next person.
- **Auto-lock** after the inactivity timeout (§4.1). The screen dims 10 s before locking, and any tap cancels it.
- **Wrong PIN:** the dots shake (or flash if reduced motion is on), with the plain message "PIN not recognised". Lockout after repeated failures shows a countdown.

### 4.2 Floor plan

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ Floor   Orders   Shift          Casa · Main dining         ◭ 2   ⚠ 1   MT ▾   ● 8:24 pm │
├──────────────────────────────────────────────────────────────────┬───────────────────────┤
│ [Main] [Terrace] [Bar]                                            │ NOW                   │
│                                                                   │ ▣ T7  QR order · 3    │
│   ┌────┐  ┌────┐   ╭──────╮   ┌──────────┐                        │   [Accept] [View]     │
│   │ 1  │  │ 2  │   │  3   │   │ 4   ●4   │                        │ ▣ T12 Water ×2        │
│   │    │  │●2  │   │ ●3   │   │ 0:42 🔥  │                        │   [Done]              │
│   └────┘  │0:15│   │ 1:05 │   └──────────┘                        │ ▣ P-031 Ready · Lim   │
│           └────┘   │  $   │                                       │   [Collected]         │
│   ┌────┐  ┌────┐   ╰──────╯   ┌────┐ ┌────┐                       │ ◭ Refund $19.18 · T12 │
│   │ 5  │  │ 6  │              │ 7  │ │ 8  │                       │   [Review]            │
│   │    │  │●2 ✓│              │●4 ▣│ │    │                       │                       │
│   └────┘  └────┘              └────┘ └────┘                       │                       │
│                                                                   │                       │
│ ○ Free  ● Seated  🔥 Sent  $ Bill asked  ✓ Paid  ▣ Needs you     │ [+ Takeaway order]    │
└──────────────────────────────────────────────────────────────────┴───────────────────────┘
```

- **Tables** are drawn at their imported positions and shapes. Each shows its number (20 pt), pax, elapsed time since seating, and **status as colour + icon**, never colour alone. The legend is always visible.
- **The "Now" rail** (right, 300 pt) lists everything on the floor that is waiting for a person, oldest first: QR orders to accept, table requests, pickups ready, and requests from agents (L3). Each item has its action inline. With nothing waiting, it says "Nothing waiting" in quiet type.
- **Seat a table:** tap a free table, then tap the number of guests on a pax sheet (1–8 as big buttons, "More…" for 9+). The order screen opens. **2 taps.**
- **Open a seated table:** tap it. **1 tap.**
- **Move table** is in the order menu, not drag and drop, so it cannot happen by accident: Order menu, "Move table", tap the target. Free targets are highlighted.

### 4.3 Order entry

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ ◂ Floor   Table 12 · 4 guests · Dine-in · 0:42            ◭ 2   ⚠ 1   MT ▾   ● 8:24 pm │
├──────────┬─────────────────────────────────────────┬─────────────────────────────────────┤
│ Mains    │ ◭ Tell the assistant what to add…   🎙  │ Seat:  [Shared] [1] [2] (3) [4]  [+]│
│ Noodles  │ ┌──────┐┌──────┐┌──────┐┌──────┐        │─────────────────────────────────────│
│ Rice     │ │Laksa ││Mee   ││Char  ││Hokkien│       │ NEW                                 │
│ Sides    │ │      ││Goreng││Kway  ││Mee    │       │ 1  Laksa (prawn)        3   $16.00  │
│ Drinks ▸ │ │$16.00││$14.00││Teow  ││$15.00 │       │      · less spicy                   │
│ Desserts │ └──────┘└──────┘│$15.00│└──────┘       │ 2  Kopi Peng            3    $3.80  │
│          │ ┌──────┐┌──────┐└──────┘┌──────┐        │ SENT 7:42 · round 1                 │
│          │ │Satay ││Otah  │┌──────┐│ SOLD  │       │ 2  Teh Tarik       ✓ printed  $7.60 │
│          │ │×10   ││      ││...   ││ OUT   │       │ 1  Satay ×10   S1  ✓ printed $18.00 │
│ 🔍 Search│ │$18.00││$9.00 ││      ││Popiah │       │─────────────────────────────────────│
│          │ └──────┘└──────┘└──────┘└──────┘        │ Subtotal                   $45.40   │
│          │                                         │ Service charge 10%          $4.54   │
│          │                                         │ GST 9%                      $4.49   │
│          │                                         │ Total                      $54.43   │
│          ├─────────────────────────────────────────┼─────────────────────────────────────┤
│          │ Added Kopi Peng · Undo                  │ [Hold] [Discount] [Bill]  [Send 2 ▸]│
└──────────┴─────────────────────────────────────────┴─────────────────────────────────────┘
```

**Layout.** Section rail (140 pt), catalogue grid (about 600 pt, 4 columns of 136 × 96 pt tiles), and the order sheet (420 pt). The grid comes from the brand's POS layout: pages are rail items, folders are tiles with a ▸ corner, and tiles carry their configured colour as a 6 pt top band (the tile body stays neutral so the name is always readable).

**Adding items:**
- **A simple item is 1 tap.** The line appears at the top of NEW, on the active seat.
- **An item with required choices** opens the **modifier sheet** from the right, over the catalogue (never over the order sheet). Required groups come first, labelled "Choose 1" or "Choose up to 3". Picking the last required option enables "Add" and does not auto-close the sheet, so staff can still add notes. "Add" stays disabled until the minimum is met, with the reason written on the button: "Choose 1 more: Spice level". Nested groups (2 levels, §4.2) open inline under their parent option.
- **Sold-out and unavailable tiles** stay in place (so the layout never shifts) with a "Sold out" overlay. Tapping one explains why ("Sold out until tomorrow"). Daily caps show the remaining count on the tile when 5 or fewer are left: "3 left".
- **Search** filters across the brand's menu as you type, results as tiles, and starts after one character. With 20,000 products, it searches the channel's menu, not the whole catalogue (roadmap v0.4 risk).
- **Seats.** The seat strip shows only if the station has seats turned on. New lines go to the active seat, shown filled. Tapping another seat changes the active seat, not existing lines.

**The order sheet:**
- Lines are grouped by state: **NEW** (not sent), **HELD**, then each **SENT** round with its time. Each line shows quantity, name, modifiers indented one level in secondary text, notes in italics, a seat chip, print status for sent lines (✓ printed, ◷ waiting, ⚠ not printed), and the line amount right-aligned in tabular figures.
- **Tap a line** to open the line sheet: quantity stepper, quick notes (configurable chips such as "No ice", "Less spicy", plus free text), seat, Hold, and Remove (before sending) or Void (after sending, which needs approval).
- **Totals** list each adjustment by its rule name, as the register returned it: "Service charge 10%", "Staff meal −20%". When the register reprices, the changed rows flash once (a 400 ms background highlight) so staff notice a discount appearing or disappearing.
- **Pricing state.** If the register has not replied within 150 ms, the totals block shows a thin progress line and keeps the previous figures at 60% opacity. They are never blank and never guessed.

**The action dock** (always the bottom 72 pt of the order sheet):
- The **primary button** changes with the state of the order: "Send 2 ▸" when there are new lines; "Pay $54.43 ▸" when everything has been sent; "Pay $12.40 ▸" on a "pay before sending" station (§4.1).
- **Secondary buttons:** Hold, Discount, Bill. Discount opens the list of manual rules the signed-in role can apply, with their names and ranges; rules above the role are shown with a "Manager approval" badge instead of being hidden, so staff learn what exists.

**With the assistant:**
- The **intent bar** sits above the catalogue grid. Staff type, or tap 🎙 to speak and tap again to stop (no press-and-hold, principle 3).
- Results arrive as **pending lines in the order sheet**, in the agent treatment, at the top of NEW, with per-field confidence (section 2.3). The dock's primary button becomes "Add 4 · 1 needs a choice". Tapping it commits the matched lines (T1, with Undo).
- If the assistant also understood "send the mains", it prepares a **confirm bar** (section 2.6). The human still taps Send.
- **The rule for speed:** tapping a tile is never slower because the assistant exists. The intent bar is never focused automatically.

**Two stations on one order.** If someone else changed the order, the sheet updates in place. A one-line L1 note says "Updated from Bar station". If the register rejected this station's change for a version conflict, it replays the change on the new version where it is safe (roadmap v0.4) and says "Your 2 new lines were kept". Only a real collision shows a choice.

### 4.4 Bill and split

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ ◂ Table 12   Bill · 4 guests · Total $248.60                [ One ] [ Even ] [Seat] [Item]│
├──────────────────────────────────┬──────────────────────┬──────────────────────┬─────────┤
│ LINES (tap one, then a bill)     │ Bill 1 · Seat 1      │ Bill 2 · Seat 2      │ Bill 3  │
│ Laksa (prawn)       S1   $16.00  │ Laksa (prawn) $16.00 │ Mee Goreng   $14.00  │ ...     │
│ Mee Goreng          S2   $14.00  │ Wine ⅓        $22.00 │ Wine ⅓       $22.00  │         │
│ Wine (bottle)  Shared ⅓·⅓·⅓ $66  │ Service ch.    $3.80 │ Service ch.   $3.60  │         │
│ ...                              │ GST            $3.76 │ GST           $3.56  │         │
│                                  │ ──────────────────── │ ──────────────────── │         │
│ [Share between bills…]           │ $41.56   🔒 Paid     │ $43.16               │         │
│                                  │                      │ [Pre-bill] [Pay ▸]   │         │
├──────────────────────────────────┴──────────────────────┴──────────────────────┴─────────┤
│ ✓ Bills add up to $248.60                                   [Print all pre-bills] [Done]  │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Modes** are a segmented control: One bill, Even, By seat, By item (§4.4). Switching mode before the first payment is free; the register recomputes. After a payment, modes that would move paid lines are disabled, with the reason: "Bill 1 is paid. Refund it to change the split."
- **Even:** a stepper for N (2–20), with the per-bill amounts shown live from the register.
- **By seat:** one bill per seat. Shared lines are split evenly by default; a "Shared lines" toggle lets staff assign them by hand.
- **By item:** **tap a line, then tap a bill** to move it. Dragging works too, but it is never the only way (principle 3). "Share between bills…" picks bills for an equal share, such as the wine three ways.
- **The invariant is visible.** The footer always shows "✓ Bills add up to $248.60" from the register. If a request is in flight, it shows "Checking…".
- Paid bills show 🔒 and their tenders. Each unpaid bill has its own "Pay ▸".

### 4.5 Payment

```
┌────────────────────────────────────────┬─────────────────────────────────────────────────┐
│ Bill 2 · Table 12                      │  Balance                                        │
│ Mee Goreng                    $14.00   │  $43.16                                         │
│ Wine ⅓                        $22.00   │                                                 │
│ ...                                    │  [ Cash ]  [ Card ]  [ PayNow ]  [ More… ]      │
│ Service charge 10%             $3.60   │                                                 │
│ GST 9%                         $3.56   │  Amount  [ $43.16 ]  (prefilled; tap to edit)   │
│ ───────────────────────────────────    │                                                 │
│ Total                         $43.16   │  CASH   [Exact] [$50] [$100]                    │
│ Paid                           $0.00   │         Cash rounding −$0.01  → pay $43.15      │
│                                        │                                                 │
│                                        │                         [ Take $50.00 cash ▸ ]  │
└────────────────────────────────────────┴─────────────────────────────────────────────────┘
```

- **Methods** come from the configured tender list, ordered by how often this outlet uses them. The top three are buttons; the rest are under "More…".
- **The amount is prefilled with the balance.** Editing it makes a part payment, and the button says so: "Take $20.00 by card · $23.16 left".
- **Cash:** quick buttons for Exact and the next sensible notes. When a cash method is selected, the register is asked for a **dry run** (vision §4.2), which returns the rounding ("Cash rounding −$0.01") and the change due. The button states the result: "Take $50.00 cash", then "Change $6.85". These figures come from the register.
- **Card and PayNow** (standalone terminal, §4.3): the amount is shown at 34 pt so it can be read while keying it into the terminal, with the instruction "Charge $43.16 on the terminal, then tap Paid." The button is "Paid by card ▸". There is an optional "Reference" field. An idempotency key stops a double tap from recording twice (§6).
- **Done:** a full-screen confirmation, "Paid · Bill 2 · $43.16", with receipt choices as large buttons: **Print**, **QR on screen**, **Email/SMS**, **No receipt**. With no choice, the screen returns to the floor (or a new order on counter stations) after 4 s. The table turns ✓ when every bill is paid.
- **Taps:** cash, exact amount: Pay → Cash → Exact → No receipt = **4**. Card: Pay → Card → Paid by card → No receipt = **4**.

### 4.6 Refund

The flow is reached from the order menu ("Refund"), from a closed order in Orders, or from the back office order drawer. It is a short stepper with a persistent summary on the right:

1. **Which bill?** Skipped when there is only one.
2. **What?** "Whole bill", "Some items" (tap lines, with quantity steppers; modifiers follow their parent), or "An amount" (number pad, for goodwill, §4.5).
3. **Why?** A reason, required (one tap from the configured list, plus optional text).
4. **Back to?** The original payment methods, **prefilled from the register's quote**: the refund is split across the original tenders within their caps. Card refunds show "Refund on the terminal, then tap Refunded".
5. **Review.** The register's quote: reversal per line, service charge, GST and rounding. The primary button reads "Refund $19.18 ▸".

- If the signed-in role cannot refund, the button reads **"Manager approval ▸"** and opens the override sheet (section 4.7) with this summary on it.
- **When an agent prepared it**, the human sees the same review screen from the request card (section 2.4). Steps 1 to 4 are already filled.
- **Done:** "Refunded $19.18". The refund receipt prints, and if the bill was invoiced, the credit note number is shown ("Credit note CN-000412").

### 4.7 Manager approval (override)

- Any action above the signed-in role shows its button with a **Manager approval** badge. Tapping it opens the **override sheet**, which states the action and its register quote ("Void Satay ×10 · already sent · $18.00 · prints a void ticket to Grill").
- **Approve here:** the manager types their PIN on the same iPad. The cashier stays signed in. The sheet shows "Approved by Aisha (Manager)", the action runs, and the approval is recorded (§4.1).
- **Ask a manager (remote):** sends the same thing as a request to the Requests tray of manager devices and the back office (the vision's proposals mechanism). The station shows an L4 banner, "Waiting for manager approval · Void Satay ×10 · [Cancel]", until someone approves or rejects. This depends on the proposals mechanism (vision §13); before it exists, only "Approve here" is shown.
- Approval is always for **one action**. It never switches the signed-in user (§4.1).

### 4.8 Print failure alert

The scope doc requires an alert when a job has not printed within 10 s (§4.7). It is the main L4 banner:

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ ⚠ Kitchen printer not printing · 3 tickets waiting · 0:14   [Send to Pass printer] [Retry] [Details] │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

- **The banner shows on every station in the outlet**, because whoever is closest to the kitchen should act. The action is the same everywhere.
- **"Send to Pass printer"** reroutes the waiting tickets to the configured backup printer (T1, with Undo). **"Retry"** reprints on the same printer. **"Details"** lists the affected tickets by table and time, with the last error ("Paper out", "Cover open", "No reply") when the printer reports it.
- **If the manager assistant has already rerouted** (vision §8.2), the banner arrives in its resolved state, in the agent treatment: "◭ Assistant sent 3 tickets to Pass printer · Undo". It drops to L1 after 10 s.
- In the order sheet, affected lines show ⚠ instead of ✓ until they print.
- **Recovery:** "Kitchen printer is back · all tickets printed" in green, which closes itself after 5 s.
- **Relay offline:** the same banner, worded for the cause: "Printing is offline at this outlet · check the print box is powered · 5 tickets waiting". Tickets stay queued (§4.7).

### 4.9 Shift open and close

**Open:** Shift → "Open shift" → count the float. There are two ways to enter it: a single total, or a **denomination counter** (rows for $100 … 5¢ with steppers, adding up live). The default float amount from the last close is prefilled. Then "Open shift with $200.00".

**Close:**
1. **Checklist first.** A list generated from register reads, with a link on each item: open orders, QR orders not accepted, tickets not printed, unacknowledged table requests. Each item can be resolved or explicitly left ("Leave open: carry to next shift" where the register allows it). With the assistant on, the manager assistant's summary appears at the top as a note (vision §8.2).
2. **Count the cash** (total or denominations), **before** expected cash is shown. Showing the expected figure first invites counting to match it. (A blind count is a design proposal; open question 3.)
3. **Result:** expected, counted and variance, from the register, with cash rounding as its own line. A variance above the outlet's threshold asks for a reason.
4. **Z-report:** preview on screen, then Print. The card total is shown at 34 pt with the reminder "Compare with the terminal's end-of-day total" (§6).

### 4.10 Back office: change review

This is the most important back-office screen, because every configuration change, from a person or an agent, ends here (vision §5.13).

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ Changes ▸ Raise coffee prices at airport outlets            ◭ Config assistant · for Phil │
│ Scope: Brand Kopi & Co · 3 outlets · Draft · effective [Mon 10 Nov, 6:00 am ▾]           │
├───────────────────────┬──────────────────────────────────────────────────────────────────┤
│ SUMMARY               │ PRICES (48)                                    [Only changed ▾]  │
│ Prices        48  ●   │ Product          Outlet       Order type   Before   After   Δ    │
│ Pricing rules  1      │ Kopi             T2 Airport   All           $1.80   $2.00  +0.20 │
│                       │ Kopi C           T2 Airport   All           $1.90   $2.10  +0.20 │
│ CHECKS                │ ...                                                              │
│ ✓ No blocking issues  │                                                                  │
│ ⚠ 2 products have no  │ ───────────────────────────────────────────────────────────────  │
│   price for Delivery  │ IMPACT · replay of last 14 days                                  │
│   [Show]              │ Gross sales  +$1,212 (+0.9%)   Orders affected 6,048             │
│                       │ By outlet   T2 Airport ▇▇▇▇▇▇ +$612   T3 ▇▇▇▇ +$402  T1 ▇▇ +$198 │
│                       │ Rules: Staff meal −$41 more (scales with price)                  │
│ ASSISTANT NOTE        │                                                                  │
│ “Matched 48 coffee    │                                                                  │
│  SKUs by tag coffee;  │                                                                  │
│  excluded RTD cans.”  │                                                                  │
├───────────────────────┴──────────────────────────────────────────────────────────────────┤
│ [Discard]  [Ask for changes…]                          [Approve and schedule for Mon ▸] │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Summary first.** Counts by entity, the validation result, and the impact, before any row-level diff. For a 3,000-row import, nobody should have to scroll to find out whether it is safe.
- **The diff** is a virtualised table with before and after columns. Changed cells are highlighted, and added and archived rows are marked. Filters: entity, outlet, "only warnings".
- **Checks** (`changesets.validate`) are split into blocking (Approve is disabled, with the reason) and advisory.
- **Impact** (`changesets.simulate`): a replay of recent days through the pricing pipeline, showing deltas by outlet and by rule. These are register numbers; the assistant's note may describe them but does not state them.
- **"Ask for changes…"** sends a comment back to the authoring assistant, which produces a new draft version. Versions are listed, with a diff between them.
- **Approve** needs an Admin who is not the author, and shows the effective time on the button. Approving re-asks for the back-office password (or SSO) if the session is older than 15 minutes.

### 4.11 Guest ordering (Scan to Order)

```
┌───────────────────────────┐   ┌───────────────────────────┐   ┌───────────────────────────┐
│ <Brand logo>   Table 12   │   │ ◂  Laksa                  │   │ Order sent                │
│ [Noodles][Rice][Drinks]…  │   │ Rich coconut curry broth… │   │ Table 12 · 8:31 pm        │
│───────────────────────────│   │ $16.00                    │   │                           │
│ NOODLES                   │   │                           │   │ ● Sent                    │
│ Laksa              $16.00 │   │ Choose 1 · Protein        │   │ ○ Accepted                │
│ Rich coconut curry broth  │   │ ( ) Prawn                 │   │ ○ Preparing               │
│                    [ + ]  │   │ (•) Chicken               │   │ ○ Done                    │
│ Mee Goreng         $14.00 │   │ Optional · Spice          │   │                           │
│ Wok-fried yellow noodles  │   │ [ ] Less spicy            │   │ Laksa (chicken) ×1        │
│                    [ + ]  │   │ Note for the kitchen      │   │ Kopi Peng ×2              │
│ Hokkien Mee     Sold out  │   │ [                     ]   │   │                           │
│                           │   │                           │   │ Pay at the counter or ask │
│───────────────────────────│   │ [ – ] 1 [ + ]             │   │ your server for the bill. │
│[ Review 3 items · $35.60 ]│   │ [  Add to order · $16.00 ]│   │ [Order more] [Call staff] │
└───────────────────────────┘   └───────────────────────────┘   └───────────────────────────┘
```

- **Landing:** the brand's logo and name, the table number, and the menu. If the table has no open order (the default, §4.6), the page says **"Your table isn't ready for ordering yet. Ask a member of staff to seat you."** It shows the menu read-only, so guests can still browse.
- **Typography-led menu.** The scope has no product images, so the menu is designed to look good without them: name, price, one-line description, with generous spacing and the brand's display font for section headings. Photos would be an optional enhancement (open question 1).
- **Item sheet:** required choices first, the same rules as the POS modifier picker, an optional note, a quantity stepper, and an "Add to order" button with the price. Sold-out items stay listed, greyed out, with "Sold out".
- **Basket bar** (sticky, 56 px): "Review 3 items · $35.60". The review page lists the items, an optional name ("So staff know whose order it is"), and the plain note "Service charge and any discounts are added to your bill." Then "Send to kitchen".
- **After sending:** the round's status (Sent → Accepted → Preparing → Done) updates live. With "hold orders" on, "Accepted" means staff have accepted it. **"Our table"** lists everything the table has ordered, with statuses, so friends at the same table can see what is coming.
- **Call staff:** a sheet with the channel's table requests (up to 5, §4.6) as big buttons, plus "Ask for the bill". Each confirms with "Sent. Someone will be with you shortly." It is rate-limited, and says so if pressed again too soon.
- **No payment, ever:** there is no price-to-pay screen and no payment button. The status page says "Pay at the counter or ask your server for the bill."

### 4.12 Smaller flows

| Flow | Path | Taps |
|-|-|-|
| Mark an item sold out | Shift → Sold out → search or browse → tap the item → Today / Until… / Indefinitely | 4 + search |
| Accept a QR order | Now rail → Accept (it is sent to the kitchen, or waits if the outlet requires acceptance) | 1 |
| Reprint a ticket | Order → tap a sent round's header → Reprint | 3 |
| New takeaway order | Orders → + Takeaway (or straight in on a counter station) | 1–2 |
| Mark a pickup ready, then collected | Orders → the order → Ready; then Now rail → Collected | 2 + 1 |
| Attach a customer | Order menu → Customer → type a mobile number → tap the match | 3 + typing |
| Change order type | Order menu → Change type → pick (blocked after the first payment, with the reason shown) | 3 |

## 5. Speed budgets

### 5.1 Taps per common action

| Action | Max taps | Notes |
|-|-|-|
| Add an item with no required choices | **1** | |
| Add an item with one required choice | **3** | Tile → option → Add (the sheet stays open after the option so notes can be added) |
| Seat a table and reach order entry | **2** | Table + pax |
| Send new items to the kitchen | **1** | |
| Even split into N bills | **3** | Bill → Even → N (stepper starts at the number of guests) |
| Cash payment, exact | **4** | Pay → Cash → Exact → receipt choice |
| Card payment | **4** | Pay → Card → Paid by card → receipt choice |
| Act on a print failure | **1** | From the banner |
| Approve a request or override | **1 + PIN** | The pad submits on the 6th digit |
| Remove an unsent line | **3** | Line → Remove → reason |
| Undo the last routine action | **1** | Within 8 s |

These budgets are tested in usability sessions (section 11.2). A design that misses one is a bug.

### 5.2 Response times

| Interaction | Budget | How |
|-|-|-|
| Visible feedback on touch | ≤ 50 ms | A pressed state on pointer-down; no 300 ms delay (`touch-action: manipulation`) |
| Local navigation (open a sheet, change mode or page) | ≤ 100 ms | Data already loaded; no network wait |
| A tapped line appearing in the order sheet | ≤ 50 ms | Optimistic line (principle 8) |
| Register-confirmed totals after a change | p95 ≤ 300 ms | §9 API budget; "pricing" state after 150 ms |
| Change visible on other stations | ≤ 1 s | SSE plus catch-up (§7.1 rule 7) |
| QR order reaching the POS | ≤ 2 s | §9 |
| Print failure alert | ≤ 10 s from the send | §4.7 |
| Assistant pending lines after the intent is sent | p95 ≤ 4 s | Vision §10.1; the screen stays fully usable meanwhile |
| Station cold start to the floor plan (cached) | ≤ 3 s | Menu and layout cached per channel link |
| Scrolling the catalogue grid or the order sheet | 60 fps (120 on ProMotion iPads) | No layout thrash; virtualised long lists |

## 6. Voice and copy

- **Buttons are verbs with their object and, where it matters, the amount:** "Send 2 to kitchen", "Pay $54.43", "Refund $19.18". Never "OK", "Submit" or "Confirm".
- **Headings are nouns:** "Bill 2", "Table 12", "Shift".
- **Sentence case** everywhere. No exclamation marks. No apologies in normal operation.
- **Errors say what happened and what to do**, using the register's `remedy` (vision §4.2): "Bill 1 is paid. Refund it to move items out of it." Never "Something went wrong."
- **Numbers:** dollars and cents always shown (`$16.00`), in tabular figures, en-SG formatting. Negative amounts use a true minus sign: "−$1.60".
- **Times:** "7:42 pm" for clock times; "0:42" for elapsed time on tables.

## 7. Visual system

### 7.1 Character

The look is **"galley"**: a well-kept working kitchen. Warm paper and charcoal surfaces, brass-warm neutrals, hairlines instead of shadows, and big, confident type. Colour is reserved for meaning (status, agent, brand). The craft is in the details: tabular figures that never shift, aligned money columns, quiet motion and generous touch targets. It is not a SaaS dashboard: no cards floating on grey, no gradient buttons, no illustrations.

### 7.2 Layout grid and spacing

- **Base unit 4 pt; spacing scale:** 4, 8, 12, 16, 24, 32, 48, 64.
- **POS (1180 × 820):** 20 pt outer margins and 16 pt gutters. The order screen is three regions (section rail 140, catalogue about 600, order sheet 420). The top bar is 56 pt; the action dock is 72 pt; the space for an L4 banner is 48 pt, reserved so nothing jumps.
- **Back office:** a 12-column fluid grid, 1280–1600 px content width, 24 px gutters, 240 px left navigation.
- **Guest app:** a single column, 16 px side margins, max width 560 px (centred on tablets).

### 7.3 Colour

All colours are tokens (CSS variables). There are two POS themes: **Day** (light) and **Service** (dark, for dim dining rooms). The station switches theme on a schedule from the outlet's hours (default: Service from 6 pm), or by a manual toggle in the user menu. Safari cannot read an ambient light sensor, so a schedule is the reliable signal.

| Token | Day | Service | Use |
|-|-|-|-|
| `bg` | #F6F3EE warm paper | #121315 charcoal | App background |
| `surface` | #FFFFFF | #1B1D20 | Panels, order sheet |
| `surface-2` | #EFEBE4 | #24272B | Tiles, inputs |
| `line` | #DDD7CD | #33373C | Hairlines |
| `ink` | #1C1D1F | #ECE8E1 warm white | Primary text and numbers |
| `ink-2` | #5E5A53 | #A9A49B | Secondary text, modifiers |
| `primary` | #1C1D1F (ink) | #ECE8E1 | **The primary action**: ink-on-paper by day, paper-on-ink at night. The same on every brand. |
| `status-seated` | #2563EB | #5B9BFF | Seated / open |
| `status-sent` | #B26B00 | #F0B44A | Sent / cooking |
| `status-bill` | #B4235E | #F27AA5 | Bill requested |
| `status-paid` | #1E7F4F | #4DC98C | Paid / done / success |
| `status-alert` | #C62D1F | #FF6B5E | Failure, needs action |
| `agent` | #5B4CD6 | #A99CFF | Agent treatment only |

- **Service theme is not pure black.** Charcoal reduces glare and halation in dim rooms, and warm white text is easier on eyes adapted to low light. Large status areas (table fills) use the status colour at 20–28% opacity in Service, with the full-strength colour on the icon and outline.
- **Contrast:** body text ≥ 4.5:1 and money figures ≥ 7:1 in both themes. Status colours are checked against both backgrounds for 3:1 as non-text graphics.
- **Colour is never the only signal:** every status also has an icon and a word (section 4.2 legend).
- **Colour blindness:** the status set is chosen to stay distinguishable under deuteranopia and protanopia (blue, amber, magenta, green and red-orange differ in lightness too). This is checked with a simulator during the v0.4 build.
- **Tile colours:** layouts are configured with a curated palette of **12 tile colours**, each tuned for both themes. The legacy importer maps imported colours to the nearest one (§4.2), and the back-office layout editor offers only these.

### 7.4 Typography

- **UI family: IBM Plex Sans** (open licence, self-hosted with `next/font`). It is legible at small sizes, has real tabular figures, and has a slightly humanist character that keeps Sail from looking like every other dashboard. **IBM Plex Mono** is used for job IDs, order numbers and references.
- **CJK item names** fall back to the iPad's system fonts (PingFang SC/TC, Hiragino), so Chinese and other CJK names render correctly with no font download (§8 of the scope doc raises CJK for printing).
- **All money and quantities use `font-variant-numeric: tabular-nums`,** so columns align and totals do not jitter as they change.

| Style | POS size / weight | Use |
|-|-|-|
| `display` | 48 / 500 | PIN digits, the paid confirmation |
| `amount-xl` | 34 / 600 | Balance, amount to key into the terminal |
| `title` | 24 / 600 | Screen titles, Total |
| `heading` | 20 / 600 | Table numbers, bill headers |
| `line` | 17 / 500 | Order lines, tile names, buttons |
| `body` | 15 / 400 | Modifiers, notes, secondary text |
| `caption` | 13 / 500 | Timestamps, chips. **Nothing smaller anywhere on the POS.** |

The back office uses the same family one step smaller (14 pt body). The guest app uses 16 px body (so iOS does not zoom inputs) and the brand's display font for headings (section 9).

### 7.5 Touch targets

- **Minimum 44 × 44 pt** everywhere (§1 of the scope doc). **On the POS, 56 pt is the standard** for buttons, list rows and chips; tiles are 136 × 96; action dock buttons are 64 pt high; PIN keys are 88 × 72.
- **At least 8 pt** between adjacent targets.
- **Destructive actions are kept apart.** Remove, Void and Reject are never directly next to a primary button, and are never in the position a primary button had on the previous step, so a double tap cannot fall through into them.
- **The guest app** uses 48 px minimum targets.

### 7.6 Shape, elevation and icons

- Corner radius: 10 pt for tiles and buttons, 16 pt for sheets, full round for chips.
- Elevation comes from surface steps and hairlines. Shadows are used only for sheets over content (one soft shadow plus a scrim at 40%).
- **Icons:** Lucide (open source) at a 1.75 pt stroke, plus a small custom set for POS objects (table shapes, seat, send, hold, printer, the agent mark). On the POS every icon has a text label, except the status legend's icons, which are labelled by the legend.

### 7.7 Motion

| Event | Motion | Duration |
|-|-|-|
| Press | Scale to 97% and darken | 80 ms |
| Line added | Slides in at the top of NEW | 140 ms |
| Lines sent | Move from NEW into the new SENT round | 200 ms |
| Sheet open / close | Slides from the right (POS) or the bottom (guest) | 200 / 160 ms |
| Total changed by the register | One background highlight on the changed rows | 400 ms |
| L4 banner | Drops into its reserved space (no layout shift) | 160 ms |

- Easing: `cubic-bezier(0.2, 0, 0, 1)` for entering, `cubic-bezier(0.4, 0, 1, 1)` for leaving.
- No looping animation anywhere except a progress indicator. No celebratory animation for payments.
- **`prefers-reduced-motion`:** movement becomes cross-fades, and the total highlight stays (it carries information).

### 7.8 States

| State | Rule |
|-|-|
| **Loading** | Keep showing the last known state. Show a skeleton only for first loads that take more than 300 ms. Never show a full-screen spinner on the POS during service. |
| **Pricing** | Totals at 60% opacity with a thin progress line (section 4.3). |
| **Empty** | Tell the user what to do next, in one line: "No open orders. Tap + Takeaway to start one." |
| **Error (action)** | Shown inline, where the action was, using the register's remedy. The input is kept. |
| **Conflict** | Merged quietly where safe; otherwise a one-line choice in the order sheet (section 4.3). |
| **Disconnected (v0.9)** | v0.9 needs a network (§1). An L4 banner says "Connection lost · reconnecting…". Buttons that change things are disabled with the label "Offline"; reading the last known state still works, with "as of 8:24 pm". On reconnect, the station catches up from the event log and the banner turns green, then closes. Nothing is queued. |
| **Offline mode (v1.1/1.2, later)** | Reserved now: lines and payments have a `pending sync` state in the component library (a hollow clock icon), and the top bar connection indicator has a "Working offline · 3 to sync" state. They are unused in v0.9, so that offline mode does not require a redesign. |

### 7.9 Sound

iPad Safari has no vibration API, so sound is the only non-visual channel. Two short, soft tones are optional per station: one for a new QR order or table request, and one for an L4 banner. Audio is unlocked at PIN sign-in (browsers need a user gesture). Off by default; open question 6.

## 8. Component inventory

All components live in one package, `ui` (section 11), with Day, Service and brand variants, and with stories for every state listed.

| Component | Surfaces | Key states and variants |
|-|-|-|
| `TopBar` | POS | Destination tabs, Requests and Alerts badges, user menu, connection indicator (online, reconnecting, offline, later offline-with-sync) |
| `PinPad` | POS | Entry, error, lockout countdown; used for sign-in and approvals |
| `AmountPad` | POS | Currency entry, quick amounts |
| `Tile` / `FolderTile` | POS | Normal, pressed, sold out, low stock ("3 left"), unavailable, access-restricted |
| `SectionRail` | POS | Selected, with folder depth |
| `SearchField` | POS, BO | Empty, typing, no results |
| `IntentBar` | POS | Idle, listening, working, done, unavailable (hidden when agents are off) |
| `ModifierSheet` | POS, guest | Required groups, nested group, min not met (reason on the button), max reached |
| `QuantityStepper` | All | Min and max limits |
| `SeatStrip` | POS | Active seat, shared, add seat |
| `OrderSheet` | POS | Groups: NEW, HELD, SENT rounds; conflict note; pricing state |
| `LineRow` | POS, BO, guest | New, held, sent (printed / waiting / failed), voided, removed, **pending (agent)**, **choose** and **not found**, later pending-sync |
| `TotalsBlock` / `AdjustmentRow` | POS, BO | Pricing, changed (highlight), frozen (lock icon after the first payment) |
| `ActionDock` | POS | Primary by state, secondaries, **confirm bar** (T2), approval badge |
| `UndoToast` | POS, BO | Countdown, with an attribution chip |
| `Banner` (L4) | POS | Alert, waiting, resolved (success), agent-resolved; queued count |
| `RequestCard` / `RequestsTray` | POS, BO | Pending, stale, expired, approved, rejected |
| `AttributionChip` | All | Person, agent for a person, guest (QR), system |
| `AgentMark` / agent treatment | All | Wrapper for any uncommitted agent content |
| `FloorCanvas` / `TableShape` | POS, BO (editor) | Free, seated, sent, bill requested, paid, needs you; elapsed time; selected |
| `NowRail` / `NowItem` | POS | QR order, table request, pickup ready, agent request |
| `StatusLegend` | POS | |
| `SplitModeSwitch` / `BillCard` | POS | Unpaid, paid (locked), target highlight, share fraction |
| `TenderGrid` / `PaymentPanel` | POS | Cash (with dry-run rounding and change), card instruction, part payment |
| `ReceiptChooser` | POS | Print, QR, email/SMS, none; auto-return countdown |
| `RefundStepper` | POS, BO | Steps, summary panel, approval required |
| `OverrideSheet` | POS | Approve here, ask remotely, waiting |
| `ReasonPicker` | POS, BO | Configured reasons plus "Other" |
| `CashCounter` | POS | Total mode, denomination mode |
| `Checklist` | POS | Item open, resolved, left open |
| `Sheet` / `Dialog` | All | Side sheet (POS), bottom sheet (guest), dialog (back office only) |
| `EmptyState`, `Skeleton`, `InlineError` | All | |
| `DataTable` | BO | Virtualised, sortable, filterable, row selection, bulk actions |
| `DiffTable` | BO | Added, changed (cell highlight), archived, only changed |
| `ValidationList` | BO | Blocking, advisory |
| `ImpactPanel` | BO | Deltas by outlet and rule, with small bar charts |
| `ScopePicker` | BO | Merchant, brand, outlet |
| `EffectiveTimePicker` | BO | Now, scheduled |
| `MenuSectionTabs`, `MenuItemRow`, `BasketBar`, `RoundTimeline`, `CallStaffSheet` | Guest | Sold out, closed table (read-only menu), rate-limited |

## 9. Multi-brand theming

**Tokens come in layers:** Sail base tokens, then the theme (Day or Service), then brand tokens. A brand can set only a small set of values:

| Brand token | POS | Back office | Guest app | Receipts |
|-|-|-|-|-|
| Name and logo | Brand chip in the order header; lock screen | Scope picker, chips | Header | Printed logo (bitmap) |
| `brand-accent` | A 4 pt stripe on the order header, and the selected section in the rail | Chips only | Buttons, selected tabs, links | |
| `brand-display-font` | Not used | Not used | Section and item headings | |
| Tile palette | The brand's POS layout colours (from the 12-colour palette) | Layout editor | | |

- **Controls do not change by brand.** On the POS, the primary button, the dock position and the status colours are identical for every brand, because staff move between outlets and muscle memory matters more than branding there.
- **The guest app is where the brand shows most.** It uses the brand accent, logo and display font. The display font is chosen from a curated list of open-licence faces, so every one is licensed for the web and checked for legibility.
- **Contrast is checked when the brand is saved** in the back office. An accent that fails 4.5:1 for text on its button gets an automatically derived darker or lighter variant, shown to the Admin before saving.
- **Implementation:** CSS variables set by `data-theme` and `data-brand` attributes on the root element. Brand tokens arrive with the channel link's menu and are cached with it.

## 10. Accessibility

- **Target: WCAG 2.2 AA** on all three surfaces, and **AAA contrast (7:1) for money figures**.
- **Not colour alone** (section 7.3). **Targets** at least 44 pt (section 7.5).
- **Text size:** iPad Safari web apps do not follow the system text size reliably, so the POS has its own per-station text setting: **Standard** and **Large** (+2 pt on every step; the catalogue grid drops to 3 columns). The guest app uses relative units and respects browser zoom; pinch zoom is never disabled there.
- **Screen readers:** every control has an accessible name. Totals and status changes are announced through polite live regions; L4 banners use assertive regions. The guest app is fully usable with VoiceOver, including the modifier sheet (a radio group or checkbox group with its "Choose 1" rule announced).
- **Keyboard:** the back office is fully keyboard-operable, with visible focus rings and shortcuts for the review screen (J/K to move between rows, A to approve after confirmation). The POS supports a hardware keyboard for search and amount entry.
- **Handedness:** a per-staff setting mirrors the order screen, putting the order sheet and action dock on the left for left-handed staff. Off by default; open question 5.
- **Motion:** respects `prefers-reduced-motion` (section 7.7).
- **Cognitive load:** one primary action per screen, consistent positions, plain words, and no time limits on decisions, apart from request expiry, which is shown.
- **Checks:** axe in CI on every component story and key page; a manual VoiceOver pass on the guest app before v0.8 ships.

## 11. Tech approach

### 11.1 Stack

| Layer | Choice | Why |
|-|-|-|
| Framework | **Next.js App Router**, as in the scope doc and roadmap: `web` (route groups `(auth)`, `(pos)`, `(backoffice)`) and `guest` (separate app) | Already decided (§10.1) |
| POS rendering | The `(pos)` group is a **client-rendered app inside Next.js**: one long-lived page per station with client-side routing, no server components on the hot path | A station runs all day on one page; navigation must be instant and must never wait for a server render |
| Back office rendering | Server components for page shells; data from the generated API client | Fast first load for large pages; all data still comes through `/v1` (§7.1, rule 1) |
| Primitives | **React Aria Components** (Adobe) | The best touch handling available for iPad Safari: `usePress` normalises touch, pointer and mouse, cancels a press when the finger slides off, and avoids ghost clicks. It also has strong accessibility, focus management and virtualised collections. |
| Styling | **Tailwind CSS v4** with all design tokens as CSS variables | Tokens and themes switch at runtime through `data-theme` and `data-brand`; no runtime CSS-in-JS; small output |
| Components | **Our own `ui` package** in the monorepo, used by `web` and `guest` | The components *are* the design; owning them is how Sail avoids looking generic |
| Server state | **TanStack Query**, keyed by resource and version | Caching, retries, optimistic lines |
| Live state | An **outlet event store**: a reducer over the SSE stream with catch-up (§7.1, rule 7) that patches TanStack Query caches | One source of truth for every open order and table on a station |
| Local UI state | **Zustand** (active seat, pending agent lines, sheet state) | Small, explicit |
| Forms | **react-hook-form + zod schemas from `shared`** | The same validation as the API |
| Lists | **TanStack Virtual** for long lists (search results, back-office tables, diffs) | 20,000 products and 3,000-row diffs |
| Charts (back office) | A light SVG chart library or hand-made SVG for the few charts needed | Reports are tables first |
| Money formatting | `Intl.NumberFormat('en-SG', { style: 'currency', currency: 'SGD' })` on integer cents from the API | The UI formats cents; it never does arithmetic on them (a lint rule flags arithmetic on `*_cents` in `web` and `guest`, except through the `shared` preview function) |

**Rejected options:**
- **A full component kit** (Material-style or similar): it would look generic, and its runtime styling costs too much on older iPads.
- **Headless Radix with copied-in components:** good, but React Aria's press handling is better for a touch-only device, and that matters more than anything else here.

### 11.2 Quality

- **Storybook** for the `ui` package, with every state in the inventory.
- **Visual regression:** Playwright on **WebKit** at the iPad viewport (1180 × 820), in both themes.
- **End to end:** Playwright flows for the speed budgets (section 5.1), counting taps.
- **Real devices:** each release candidate is checked on the oldest iPad model used at the beta outlets.
- **Usability, per phase** (the roadmap's walkthroughs in v0.4 and v0.7): **5 staff who have never seen Sail** each complete "seat a table of 3, order 4 items including one with a required choice, send, split by seat, take a cash payment" **with no help**. Target: all 5 within 5 minutes. Every hesitation longer than 5 seconds is logged as a design issue.

### 11.3 iPad specifics

- **Home-screen web app:** a web app manifest with `display: standalone`. This removes the Safari address bar, gives more room and prevents the swipe-back gesture from leaving the POS. **Guided Access** is recommended at each station so staff cannot leave Sail by accident (an Ops setup step).
- **Screen Wake Lock API** (Safari 16.4+) keeps the screen on while a shift is open.
- **`touch-action: manipulation`** on all controls, to remove the double-tap-to-zoom delay. Text selection and the iOS callout are disabled on tiles and buttons, but kept in text fields.
- **SSE** uses `fetch` streaming, and catches up on `visibilitychange` (§7.1, rule 7).
- **Fonts** are self-hosted and preloaded; CJK uses system fonts (section 7.4).
- **Memory:** the station keeps one channel link's menu in memory, not the whole catalogue.

### 11.4 What gets built when

The roadmap orders the phases; this is where the design work lands in it. The agent UI follows the vision and depends on the vision's roadmap changes being agreed (vision §13).

| Roadmap phase | Design deliverables |
|-|-|
| v0.1 | `ui` package, tokens, both themes, `TopBar`, back-office shell, `DataTable`, `ScopePicker` |
| v0.3 | Menu builder, pricing rules and simulator screens, CSV import review (as a change review once changesets exist), layout and tile palette |
| v0.4 | Lock and PIN, floor plan, order entry, modifier sheet, order sheet, action dock, override sheet, Undo, conflict handling; first staff walkthrough |
| v0.5 | Print status on lines, print failure banner, printers and relays in the back office |
| v0.6 | Payment panel, receipt chooser, shift open and close, Z-report view |
| v0.7 | Bill and split, refund stepper; second staff walkthrough |
| v0.8 | Guest app, Now rail QR items, table requests |
| v0.9 | Reports, Today page, polish, accessibility audit |
| With the agent work (vision §13) | Agent treatment, intent bar, pending lines and confidence states, requests tray and cards, confirm bar, Assistants section, change review for agent-authored changes |

## 12. Open design questions

1. **Menu photos.** Products have no image field (§7.2). Should the guest app support optional photos per product (a new field, storage and an image pipeline), or stay typography-only in v0.9?
2. **Service theme switching.** Switch on a schedule from the outlet's hours (proposed), or let each station choose?
3. **Blind cash count.** Should staff enter counted cash before seeing the expected amount at shift close (proposed), or see both together?
4. **Remote manager approval in v0.9.** "Ask a manager" needs the proposals mechanism from the vision. Is it in v0.9, or is "Approve here" with a PIN enough for the beta?
5. **Handedness.** Is a mirrored, left-handed layout worth building in v0.9?
6. **Sound.** Do the beta outlets want audible chimes for QR orders and print failures, given the noise in the room?
7. **Floor plan positions.** Will the legacy CSV export include table positions and shapes? If not, the back office needs a simple grid floor-plan editor, which is not in the scope doc.
8. **Where agent requests go during service.** Only the station that triggered them, manager devices only, or both (vision open question 3)?
9. **Voice in a loud room.** Is speech input for the intent bar useful at the beta outlets, or should v0.9 ship with typing only?
