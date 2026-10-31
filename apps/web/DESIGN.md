# OrgPay web: design system

Direction **"Ledger tree"**: cool paper, navy ink, one cobalt accent, ledger figures. A payroll run is a
document you can trust: totals sit on a double rule, every payment has a status word, and a successful
payment shows its verified hash. Tokens live in `app/globals.css`; this file is the summary. The full
board (logo, motion, every screen) is the OrgPay design canvas.

## Logo

The fan-out: a cobalt square, a white coin (the organization) with three lines running to three white
dots (the employees paid). `components/Logo.tsx`. In the app the lines flow and the dots pulse
(`.lg-live`); below 24 px the lines drop. Wordmark: Bricolage Grotesque 700, "Org" in ink, "Pay" in
cobalt (`#9FB0FF` on night).

## Colour

| Token | Hex | Use |
| --- | --- | --- |
| `--paper` / `--sheet` / `--sunken` | `#F3F4F0` / `#FFFFFF` / `#ECEDE8` | Ground, cards and dialogs, hover |
| `--rule` / `--rule-soft` / `--rule-strong` | `#DADCD3` / `#E8E9E3` / `#8A8E85` | Borders, row dividers, inputs (≥ 3:1) |
| `--ink` / `--ink-2` / `--ink-3` | `#14213D` / `#475069` / `#5E6577` | Text (all ≥ 4.5:1 on paper and sheet) |
| `--green` (brand) / `--green-hover` / `--green-tint` | `#2F4BD8` / `#2239B0` / `#E6EAFD` | Cobalt: the main action, links, focus (the token keeps PayBridge's name) |
| `--night` | `#0E1830` | Auth panel, landing safety band |
| Successful | `#11663F` on `#DFF1E6` | Only ever a successful, verified payment |
| Waiting for signature | `#855409` on `#F7EAD0`; amber stripes | |
| Submitted, confirming | `#1F5A8A` on `#DCEBF5`; blue stripes | |
| Failed | `#A2361F` on `#F7E1D9` | |
| Pending / draft / cancelled | `#4A5263` on `#E9EAE5` | |
| Testnet dot | `#C98A1B` | The permanent "Stellar Testnet · no real money" badge |

Status is never colour alone: every pill has an icon and a word.

## Type

- **Bricolage Grotesque** 700 for page titles, section titles and headline money (`--font-serif`, kept for the old class names).
- **Inter** for everything you read.
- **JetBrains Mono** for every amount in a list, addresses, hashes, memos and row numbers.
- An amount is headline or mono, never body text. Amounts are decimal strings end to end; `parseFloat`/`Number()` on amounts are banned (ESLint).

## Signature details

Kept from PayBridge: the perforated run document, the double rule under a binding total, the tick bar
(one tick per payment), the date tile, the run's stamp (Completed / Partially paid).

## Motion

Calm and quick, only where something happened: 160 ms hover, 400 ms pop, 550 ms rise, 60 ms stagger,
ease `cubic-bezier(.2,.7,.2,1)`. Screens rise in, rows stagger, ticks grow, a pill pops when its status
changes, totals count up, the live dot breathes while money is moving, the logo's lines flow. Every
animation is off under `prefers-reduced-motion`. Live updates poll every 2 s only while a payment is
confirming.

## Rules

- Real `<button>`, `<a>`, `<label for>`; dialogs trap focus and close on Escape; focus ring 2 px cobalt, offset 2.
- Every list has loading, empty and error states. Tables become stacked rows below 640 px.
- The Testnet badge is always visible in the app.
- A pasted secret key (S…) is cleared from the field and never sent anywhere.
- The UI never marks a payment successful on its own: it shows what the API says, and the API says so only after the ledger record is verified.
