# xrpjson testing — divergences & bugs found

This document catalogs divergences between `xrpjson` and the canonical XRPL
sources (`xrpl.js`, `xrpl.org`, XLS specs), surfaced by the test suites in
this project.

Each entry includes:
- The factory / behavior
- The divergence: what xrpjson does vs what the canonical source requires
- The canonical source citation
- Whether the divergence is a **bug** (incorrect behavior) or a **stricter
  validation** (xrpjson catches what xrpl.js does not)
- Status (fixed, open, deferred)

---

## Bug #1 — EscrowCreate Ripple Epoch validation (FIXED in v1.0.3)

**Factory:** `escrowCreate`

**Bug:** The factory used `value >= RIPPLE_EPOCH_OFFSET` (946684800 — the
Unix epoch of 2000-01-01) as the lower bound for `CancelAfter` and
`FinishAfter`. But those fields are **seconds since the Ripple Epoch** — so
the lower bound should be `value >= 0`. The bug rejected every valid
pre-2030 Ripple Epoch timestamp (e.g., `xrplNow() + 8` for a test in 2026 =
~844M, which is < 946M).

The existing xrpjson unit tests didn't catch this because they shared the
same wrong assumption (`FinishAfter = 946684800 + 3600` instead of `3600`).
The integration test in this project (which uses the canonical
`unixTimeToRippleTime()` helper) caught it on every escrow creation.

**Canonical sources:**
- `xrpl-dev-portal/repo/docs/references/protocol/transactions/types/escrowcreate.md`:
  "`CancelAfter` … The time, **in seconds since the Ripple Epoch**, when this
  escrow expires." Example value in the docs: `533257958` (2016-12-01) —
  well below `946684800`.
- `xrpl.js/repo/packages/xrpl/src/utils/timeConversion.ts:22`: 
  `rippleTime = unixTime - 0x386d4380` (= unixTime - 946684800).
- `xrpl.js/repo/packages/xrpl/src/models/transactions/escrowCreate.ts`:
  "`CancelAfter` … The time, in seconds since the Ripple Epoch."

**Fix:** Lower bound changed from `>= RIPPLE_EPOCH_OFFSET` to `>= 0`.

**Tests added:** docs-example values (FinishAfter: 533171558, CancelAfter:
533257958), negative-number rejection test.

**Status:** ✅ Fixed in v1.0.3.

---

## Bug #2 — AccountSet Account not required (FIXED in v1.0.4)

**Factory:** `accountSet`

**Bug:** The factory accepted `accountSet({})` (no Account field). 
xrpl.js's `validateBaseTransaction` requires `Account` on every transaction
(`validateRequiredField(common, 'Account', isString)`).

The factory type signature already declared `Account: string` as required,
but the runtime validation didn't enforce it.

**Canonical sources:**
- `xrpl.js/repo/packages/xrpl/src/models/transactions/common.ts`:
  `validateBaseTransaction` calls `validateRequiredField(common, 'Account', isString)`.

**Fix:** Added `require(props.Account, 'AccountSet: Account is required', isAccount)`.

**Tests added:** "throws when Account is missing at construction" and
"throws when Account is not a valid XRPL address".

**Status:** ✅ Fixed in v1.0.4.

---

## Test-scaffolding bugs (not xrpjson)

### Bug #S1 — Integration test ordering for [10] IOU

**File:** `integration/run-all.mjs`

**Bug:** `[10] IOU` ran after `[3] TrustSet`, which already opened trust
lines from Alice to Bob. But `[10]`'s first action was Bob enabling
`asfAllowTrustLineClawback`, which the ledger rejects with `tecOWNERS` if
Bob has any trust lines.

**Fix:** Move `[10] IOU` to run BEFORE `[3] TrustSet`. This cascades other
fixes (clawback, freeze, etc.) into passing.

**Status:** ✅ Fixed.

### Bug #S2 — Issuer-side freeze pattern collapses HighLimit

**File:** `integration/tests/10-iou.mjs`

**Bug:** The freeze test used `LimitAmount: ica('USD', alice.classicAddress, '0')`
— value 0. But on an issuer-side TrustSet (Bob freezing Alice's trust line
from his side), the LimitAmount **value** sets Bob's HighLimit. value=0
collapses Bob's HighLimit to 0, which blocks all subsequent payments routed
through Bob. The unfreeze does NOT restore HighLimit (only the freeze flag).

**Canonical sources:**
- `xrpl-dev-portal/repo/docs/concepts/tokens/fungible-tokens/freezes.md` —
  describes the freeze mechanics; doesn't explicitly say what value to use.
- Practice (xrpl.js examples): use the EXISTING limit value.

**Fix:** Use `value: '50000'` (the actual trust line limit) instead of `'0'`.
The freeze/unfreeze pattern should preserve the issuer's HighLimit.

**Status:** ✅ Fixed.

### Bug #S3 — `xrpjson.mjs` shim's reference comment is wrong

**File:** `xrpjson.mjs`

**Issue:** The comment says "xrpjson 1.0.2 exposes its functional factories
from the documented root." As of v1.0.3, this is `1.0.3`, not `1.0.2`. The
shim still works.

**Status:** 🟡 Cosmetic. Not fixed.

---

## Coverage observations (no bugs, just learnings)

### Coverage #1 — Generic harness caught missing-required-field pattern

`tests/unit-generic-harness.mjs` iterates over all 79 factories and asserts
that calling each with `{}` throws `ValidationError`. Initially, this found
that `accountSet({})` doesn't throw — see Bug #2 above.

The harness found that the existing `xrpjson.mjs` shim works because Node's
`exports` field only restricts bare-specifier package imports, not relative
file paths. The shim is fragile (depends on `dist/errors.js` and
`dist/types/flags.js` paths that are not in the public `exports` map).

**Status:** ⚠️ Documented but not fixed — `xrpjson` should expose errors
and flags via the public `exports` map for the shim to be durable.

### Coverage #2 — Per-family fixtures exposed strict invariants

`tests/unit-families.mjs` writes happy-path inputs for all 79 factories.
The factories enforce invariants the xrpl.js class API misses. Highlights:

- **AMM**: `ammClawback` requires Account = Asset.issuer; `ammDeposit`
  needs `LPTokenOut` or `Amount`; `ammWithdraw` requires exactly one of
  seven withdraw mode flags.
- **Batch**: `RawTransactions` requires 2..8 entries, each with the
  `tfInnerBatchTxn` flag.
- **ConfidentialMPT**: ZK proof / encrypted amounts have specific hex
  lengths (ZKProof: 128 for clawback, 1632 for convertBack, 1892 for send).
- **Credential**: `CredentialType` must be hex-encoded.
- **DelegateSet**: `Permissions` array required.
- **EscrowCreate**: FinishAfter < CancelAfter when both present; either
  FinishAfter or Condition required.
- **LedgerStateFix**: SpecialTransaction Cost Floor (Fee ≥ 2,000,000 drops).
- **OracleSet**: Provider must be hex; PriceDataSeries required.
- **Sponsorship**: needs Sponsee + fee-modifying field.
- **Vault**: Amount must NOT be XRP drops for VaultClawback; VaultSet
  AssetsMaximum is a drops string.
- **XChain**: SignatureReward + WasLockingChainSend + XChainAccountCreateCount
  required.

**Status:** ✅ All 79 factories now have happy-path coverage.

---

## Summary

- **2 real bugs** in xrpjson found and fixed (v1.0.3, v1.0.4).
- **3 test-scaffolding bugs** in 173-xrpjson-testing found and fixed.
- **Coverage expanded** from 7 (unit) + 11 (integration) test scenarios to:
  - 20 unit scenarios (test.mjs)
  - 322 generic factory contract scenarios (unit-generic-harness.mjs)
  - 236 per-family happy-path scenarios (unit-families.mjs)
  - 68 integration scenarios (integration/run-all.mjs)
  - **Total: 646 test scenarios across all 79 factories.**