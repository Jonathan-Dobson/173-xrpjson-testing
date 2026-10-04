# 173-xrpjson-testing

A downstream integration + unit test harness for the [`xrpjson`](https://www.npmjs.com/package/xrpjson)
package. Exercises every one of xrpjson's 79 transaction factories against:

1. The xrpjson unit contract (frozen shape, validate, toJSON, with immutability).
2. Happy-path construction per factory (all 79, with documented required fields).
3. End-to-end submission to XRPL Testnet (XRPL 3.4.1) for representative transaction families.

Three canonical sources are consulted before landing each test:
- **xrpl.js** at `~/.mavis/docs.local/xrpl.js/` — the canonical JS validator.
- **xrpl.org** at `~/.mavis/docs.local/xrpl-dev-portal/` — the human-readable reference.
- **XLS specs** at `~/.mavis/docs.local/xrpl-standards/` — the amendment spec text.

See [DIVERGENCES.md](./DIVERGENCES.md) for the catalog of bugs this project
has found in xrpjson (and the test scaffolding fixes that surfaced them).

## Setup

```bash
npm install   # installs xrpjson@^1.2.0 + xrpl@^4.6.0
```

> **Sandbox note:** if `npm install` fails with `EPERM ... unlink` under
> `_cacache/tmp`, that is a filesystem-sandbox restriction, not a corrupt
> cache (npm's "root-owned files" message is misleading here). Point npm's
> cache inside the workspace:
>
> ```bash
> npm install --cache="$PWD/.npm-cache"
> ```
>
> `.npm-cache/` is gitignored.

## Running tests

```bash
# Unit tests only (no testnet)
npm run test:unit

# Single-scope
npm run test           # 20 tests  — original happy-path sanity
npm run test:generic   # 322 tests — all 79 factories × 4 contract tests
npm run test:families  # 236 tests — happy-path coverage per factory
npm run test:errors    # 30 tests  — ValidationError error-contract guard

# End-to-end (testnet)
npm run test:integration

# Everything
npm run test:all
```

The integration suites run against **XRPL Testnet** by default and need no
credentials — wallets are funded from the faucet. Expect the full run to take
~30 minutes; suite [13] alone is ~20 because it waits out the `AccountDelete`
ledger-age requirement (see [DIVERGENCES.md](./DIVERGENCES.md) Bug #S7).

Set `XRPL_WSS` to run against a different network. This matters for
amendment-gated families: **devnet is the only public network with the `Sponsor`
amendment enabled**, so on testnet those transactions return `temDISABLED`
regardless of what the client encodes.

```bash
XRPL_WSS=wss://s.devnet.rippletest.net:51233 \
  node integration/tests/15-flag-defect-verification.mjs
```

## Test layout

```
173-xrpjson-testing/
├── package.json
├── xrpjson.mjs                   # Re-export shim with temporary `Tx` aliases
├── test.mjs                      # 20 tests — original sanity check
├── tests/
│   ├── unit-generic-harness.mjs  # 322 tests — generic factory contract
│   ├── unit-families.mjs         # 236 tests — per-family happy-path
│   └── unit-error-contract.mjs   # 30 tests  — ValidationError contract
├── integration/
│   ├── run-all.mjs               # full testnet suite
│   ├── helpers.mjs
│   ├── setup.mjs
│   └── tests/                    # 13 scenario files
└── DIVERGENCES.md
└── USER-STORIES.md
```

Suites [12], [13] and [14] are specified in [USER-STORIES.md](./USER-STORIES.md) —
the tests are written against those stories, so the document is the intent
and the test is the bug when they disagree.

`13-account-admin.mjs` **must run last**. It mutates Alice's signing setup
(regular key, then signer list) and finally deletes a throwaway account;
`AccountDelete` only succeeds once the regular key and signer list are gone,
so `run-all.mjs` schedules it at the end. Suite `14-amm-deposit-flags.mjs` is
self-contained and non-destructive — it creates no AMM, because the AMMDeposit
flag check is a *preflight* check that runs before any pool state is read.

`15-flag-defect-verification.mjs` is the one suite that imports the **fixed
`dist` from the `175-xrpjson` working tree** rather than this repo's published
`node_modules` copy — the three fixes it verifies (Bugs #8–#10) are not
released yet. It fails loudly if that path moves, rather than silently testing
the old package. Once 1.3.0 ships, point it back at `xrpjson` proper.

## Coverage matrix

| Family | Factories | Unit | Integration |
|---|---|---|---|
| Account | `accountDelete`, `accountSet` | ✓ generic + happy | ✓ `02-account-set`, `13` (delete) |
| AMM (7) | `ammBid`, `ammClawback`, `ammCreate`, `ammDelete`, `ammDeposit`, `ammVote`, `ammWithdraw` | ✓ generic + happy | `ammCreate` only; `14` covers `ammDeposit` flag contract |
| Batch | `batch` | ✓ | — |
| Check (3) | `checkCancel`, `checkCash`, `checkCreate` | ✓ | ✓ `07-check`, `11-check-iou` |
| Clawback | `clawback` | ✓ | ✓ in `10-iou` |
| ConfidentialMPT (5) | `confidentialMpt*` | ✓ | — |
| Credential (3) | `credential*` | ✓ | — |
| Delegate | `delegateSet` | ✓ | — |
| DepositPreauth | `depositPreauth` | ✓ | ✓ `13` |
| DID (2) | `didSet`, `didDelete` | ✓ | — |
| Escrow (3) | `escrow*` | ✓ | ✓ `06-escrow` |
| LedgerStateFix | `ledgerStateFix` | ✓ | — |
| Loan (4) | `loan*` | ✓ | — |
| LoanBroker (5) | `loanBroker*` | ✓ | — |
| MPT (4) | `mptoken*` | ✓ | ✓ `09-mptoken`, `15` (flag defect) |
| NFToken (6) | `nftoken*` | ✓ | ✓ `08-nft`, `12-nft-lifecycle`, `15` (flag defect) |
| Offer (2) | `offer*` | ✓ | ✓ `05-offer` |
| Oracle (2) | `oracle*` | ✓ | — |
| Payment | `payment` | ✓ | ✓ `01-payment-xrp`, `04-payment-iou` |
| PaymentChannel (3) | `paymentChannel*` | ✓ | — |
| PermissionedDomain (2) | `permissionedDomain*` | ✓ | — |
| SetRegularKey | `setRegularKey` | ✓ | ✓ `13-account-admin` |
| SignerList | `signerListSet` | ✓ | ✓ `13-account-admin` |
| Sponsorship (2) | `sponsorship*` | ✓ | `15` (flag defect; ledger verdict blocked) |
| Ticket | `ticketCreate` | ✓ | ✓ `13-account-admin` (see Bug #5) |
| TrustSet | `trustSet` | ✓ | ✓ `03-trust-set`, `10-iou`, `11-check-iou` |
| Vault (6) | `vault*` | ✓ | — |
| XChain (8) | `xchain*` | ✓ | — |

## xrpjson shim (`xrpjson.mjs`)

```js
export * from 'xrpjson';  // 79 factories
export { ValidationError, TransactionError } from 'xrpjson/errors';
export * from 'xrpjson/flags';

// `new XxxTx({...})` aliases (legacy migration shim)
export { payment as PaymentTx, ... };
```

**Import through this shim, not bare `xrpjson`.** `ValidationError` and the
`*Flags` enums are **not** on the root entry point — they live on the
`xrpjson/errors` and `xrpjson/flags` subpaths. Importing them from bare
`xrpjson` yields `undefined`, which makes `err instanceof ValidationError`
silently `false` and routes user input errors into a caller's "library bug"
branch. See `DIVERGENCES.md` Bug #S6.

The bare-specifier subpaths work because xrpjson declares them in its
`exports` map (added in v1.0.5). Before that, the shim reached into
`dist/errors.js` and `dist/types/flags.js` by relative path, which works but
depends on internal layout.

## xrpjson fix history

This project caused two xrpjson releases and guards a third:

- **v1.0.3** (2026-09-29): Fix `EscrowCreate.isRippleEpochUInt32` lower
  bound (was `>= RIPPLE_EPOCH_OFFSET`, now `>= 0`). Surfaced by the
  integration suite's `EscrowCreate` with `xrplNow() + 8`.
- **v1.0.4** (2026-09-29): Fix `AccountSet` factory to require `Account`.
  Surfaced by the generic harness expecting every factory to throw on `{}`.
- **v1.1.0** (2026-10-01): `accountSet` (TickSize) and `payment`
  (DeliverMin without `tfPartialPayment`) now throw `ValidationError`
  instead of a bare `Error`, matching the other 729 throw sites. Found
  upstream via its citation audit; `tests/unit-error-contract.mjs` guards
  it here.
- **v1.2.0** (2026-10-02): `ammDeposit` now enforces the "exactly one
  deposit-mode flag" rule its sibling `ammWithdraw` already did, and both
  AMM factories now validate flag *membership* (every set bit must be legal
  for the transaction type) as well as *cardinality* — Bugs #6 and #7. Found
  by diffing sibling factories, then verified against a live ledger by suite
  [14]. **Behaviour change:** `ammDeposit` now throws on input it previously
  accepted.

**Open finding:**

- **Bug #5 — 7 base transaction fields appear in 0 of 79 factory prop types.**
  `Memos`, `SourceTag`, `LastLedgerSequence`, `AccountTxnID`, `NetworkID`,
  `Delegate`, and `TicketSequence` are declared in `BaseTransactionFields` and
  validated by `validateBaseTransaction`, but no fp factory re-declares them and
  none imports that validator. Not a runtime hole — `buildFrozenTx` spreads
  fields through, so all seven work if you cast past the type. `TicketSequence`
  is the practical case: `ticketCreate` works, but spending the ticket needs a
  hand-merge.
  **Partial fix in `175-xrpjson`, not yet released.** The fix has two independent
  halves, and counting them separately shows far more banked than "10 of 79"
  suggests — as of 2026-10-04, **11/79** factories carry the type change and
  **38/79** call `validateBaseTransaction`. 28 are runtime-only (the type change
  is all that remains), 40 have neither, and `vault-clawback` is the one
  inconsistency: type present, validator never called. Six families (`Payment`,
  `Ticket`, `TrustSet`, `Check`, `Escrow`, `AccountSet`) now extend
  `Omit<BaseTransactionFields, 'TransactionType' | 'Flags'>` and call
  `validateBaseTransaction` last, with 90 new tests (2948 total, tsc/lint
  clean, no pre-existing test broken). The family-by-family order proves the
  pattern before it scales; `TicketSequence` is now a real capability instead of
  a hand-merge. **The remaining 68 type changes and 41 validator calls have been
  handed to a second agent.**
- **Bug #4 — withdrawn.** `factory()` / `factory(null)` do throw a raw
  `TypeError`, but the proposed fix cannot work: `require(props.Account, …)`
  dereferences at the call site, before a guard inside `require()` could run.
  Kept in the error-contract suite as a characterization test; not worth filing.

**Fixed by this project:** Bug #6 — `ammDeposit` enforced no mode-flag rule at
all while `ammWithdraw` enforced the identical one — and **Bug #7**, where both
AMM factories checked flag *cardinality* ("exactly one mode") but not flag
*membership* ("every bit must be legal for this transaction type"). So
`Flags: tfSingleAsset | tfWithdrawAll` was accepted by the factory and refused
by the ledger with `temINVALID_FLAG`. Both fixed in v1.2.0 and verified against
a live ledger by suite [14].

**Fixed by this project, not yet released** — three factories were *too strict*,
refusing transactions the ledger accepts (Bugs #8, #9, #10, fixed in
`175-xrpjson` `3a55880`):

- `sponsorshipTransfer` rejected `spfSponsorFee`, making the documented
  fee-and-reserve combination unconstructible. **Now ledger-verified on devnet** —
  `terNO_PERMISSION`, not `temINVALID_FLAG`, so the ledger accepted the flags and
  refused on business grounds. See [DIVERGENCES.md](./DIVERGENCES.md) Bug #8.
- `mptokenIssuanceCreate` collapsed a boolean-map `Flags` to `0`, so setting
  `tfMPTCanTransfer` then being told `TransferFee` needed a flag you'd just set.
- `nftokenMint` gated `TransferFee` on field *presence*; rippled gates on
  *value*. XLS-20 and xrpl.org both say presence — **the prose is what is
  wrong**, settled on a live ledger.

These are the opposite shape to Bugs #6/#7, which accepted what the ledger
refused. Both directions are defects; catching only one is a partial audit.

See [DIVERGENCES.md](./DIVERGENCES.md) for full details.