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
npm install   # installs xrpjson@^1.0.x + xrpl@^4.6.0
```

## Running tests

```bash
# Unit tests only (no testnet)
npm run test:unit

# Single-scope
npm run test           # 20 tests — original happy-path sanity
npm run test:generic   # 322 tests — all 79 factories × 4 contract tests
npm run test:families  # 236 tests — happy-path coverage per factory

# End-to-end (testnet)
npm run test:integration

# Everything
npm run test:all
```

## Test layout

```
173-xrpjson-testing/
├── package.json
├── xrpjson.mjs                  # Re-export shim with temporary `Tx` aliases
├── test.mjs                     # Original 20-test sanity check
├── tests/
│   ├── unit-generic-harness.mjs # 322 tests — generic factory contract
│   └── unit-families.mjs        # 236 tests — per-family happy-path
├── integration/
│   ├── run-all.mjs              # 68 tests — full testnet suite
│   ├── helpers.mjs
│   ├── setup.mjs
│   └── tests/                   # 11 scenario files (1 per family)
└── DIVERGENCES.md
```

## Coverage matrix

| Family | Factories | Unit | Integration |
|---|---|---|---|
| Account | `accountDelete`, `accountSet` | ✓ generic + happy | ✓ `02-account-set` |
| AMM (7) | `ammBid`, `ammClawback`, `ammCreate`, `ammDelete`, `ammDeposit`, `ammVote`, `ammWithdraw` | ✓ generic + happy | `ammCreate` only |
| Batch | `batch` | ✓ | — |
| Check (3) | `checkCancel`, `checkCash`, `checkCreate` | ✓ | ✓ `07-check`, `11-check-iou` |
| Clawback | `clawback` | ✓ | ✓ in `10-iou` |
| ConfidentialMPT (5) | `confidentialMpt*` | ✓ | — |
| Credential (3) | `credential*` | ✓ | — |
| Delegate | `delegateSet` | ✓ | — |
| DepositPreauth | `depositPreauth` | ✓ | — |
| DID (2) | `didSet`, `didDelete` | ✓ | — |
| Escrow (3) | `escrow*` | ✓ | ✓ `06-escrow` |
| LedgerStateFix | `ledgerStateFix` | ✓ | — |
| Loan (4) | `loan*` | ✓ | — |
| LoanBroker (5) | `loanBroker*` | ✓ | — |
| MPT (4) | `mptoken*` | ✓ | ✓ `09-mptoken` |
| NFToken (6) | `nftoken*` | ✓ | ✓ `08-nft` |
| Offer (2) | `offer*` | ✓ | ✓ `05-offer` |
| Oracle (2) | `oracle*` | ✓ | — |
| Payment | `payment` | ✓ | ✓ `01-payment-xrp`, `04-payment-iou` |
| PaymentChannel (3) | `paymentChannel*` | ✓ | — |
| PermissionedDomain (2) | `permissionedDomain*` | ✓ | — |
| SetRegularKey | `setRegularKey` | ✓ | — |
| SignerList | `signerListSet` | ✓ | — |
| Sponsorship (2) | `sponsorship*` | ✓ | — |
| Ticket | `ticketCreate` | ✓ | — |
| TrustSet | `trustSet` | ✓ | ✓ `03-trust-set`, `10-iou`, `11-check-iou` |
| Vault (6) | `vault*` | ✓ | — |
| XChain (8) | `xchain*` | ✓ | — |

## xrpjson shim (`xrpjson.mjs`)

```js
export * from 'xrpjson';  // 79 factories
export { ValidationError, TransactionError } from './node_modules/xrpjson/dist/errors.js';
export * from './node_modules/xrpjson/dist/types/flags.js';

// `new XxxTx({...})` aliases (legacy migration shim)
export { payment as PaymentTx, ... };
```

**Note**: the deep imports to `dist/errors.js` and `dist/types/flags.js`
work because Node's `exports` field only restricts bare-specifier package
imports (e.g. `import x from 'xrpjson/errors'`), not relative file paths.
These paths are **not** part of xrpjson's public surface and may break in
future versions. A future xrpjson release should expose them via the
`exports` map.

## xrpjson fix history

This project caused two xrpjson releases:

- **v1.0.3** (2026-09-29): Fix `EscrowCreate.isRippleEpochUInt32` lower
  bound (was `>= RIPPLE_EPOCH_OFFSET`, now `>= 0`). Surfaced by the
  integration suite's `EscrowCreate` with `xrplNow() + 8`.
- **v1.0.4** (2026-09-29): Fix `AccountSet` factory to require `Account`.
  Surfaced by the generic harness expecting every factory to throw on `{}`.

See [DIVERGENCES.md](./DIVERGENCES.md) for full details.