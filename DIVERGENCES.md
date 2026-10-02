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

## Bug #3 — Two throws bypassed the ValidationError contract (FIXED in v1.1.0)

**Factories:** `accountSet` (TickSize), `payment` (DeliverMin)

**Bug:** These two guards threw a bare `new Error(...)` while all 729 other
throw sites in the fp layer throw `ValidationError`:

```js
// account-set.ts — TickSize out of the 3..15 / 0 range
throw new Error('AccountSet: TickSize must be 3-15 or 0');

// payment.ts — DeliverMin without tfPartialPayment
throw new Error('Payment: DeliverMin requires tfPartialPayment flag');
```

**Why this matters downstream:** a caller branching on
`err instanceof ValidationError` is deciding between "the user sent bad
input" (400) and "the library has a bug" (500). Because a bare `Error` is
not a `ValidationError`, a `TickSize` of 16 or a `DeliverMin` without
`tfPartialPayment` was mis-routed into the "unexpected bug" branch — an
unhandled 500 instead of a 400. Both are trivially reachable: `TickSize` is
a 0..16 integer and `DeliverMin` is a normal payment field.

**Verification against the published artifact** (xrpjson@1.1.0, `dist/`):

```
bare `throw new Error(` in dist/fp/factories/  →  0
`throw new ValidationError(`                  →  731
```

Zero bare throws remain anywhere in the published package.

**Fix:** Both sites now throw `ValidationError`.

**Tests added upstream:** `tests/fp/account-set.test.ts`,
`tests/fp/payment.test.ts` (assert the error type).

**Tests added here:** `tests/unit-error-contract.mjs` — the regression guard
this project was missing. Nothing in the consumer suite previously asserted
the error *type* on these two paths, so a regression would have shipped
unnoticed. The new suite pins the type, the message, and the valid/invalid
boundaries (TickSize 0/3/5/15 accepted, 2/16/-1 rejected; DeliverMin accepted
with numeric `0x00020000`, `PaymentFlags.tfPartialPayment`, and
`{ tfPartialPayment: true }`).

**Status:** ✅ Fixed in v1.1.0. Consumer upgraded, 30 regression tests green.

---

## Bug #4 — `factory()` / `factory(null)` throw TypeError, not ValidationError (WITHDRAWN)

**Factories:** all 79

**Original claim:** every factory dereferences `props.Account` before checking
that `props` is an object, so calling with no argument or `null` throws a raw
`TypeError` rather than a `ValidationError`:

```
factory()          → TypeError: Cannot read properties of undefined (reading 'Account')
factory(null)      → TypeError: Cannot read properties of null (reading 'Account')
```

**Why it is withdrawn.** The suggested fix cannot work where it was proposed.
`require(props.Account, …)` dereferences **at the call site**, before `require`
is ever entered, so a guard *inside* `require()` structurally cannot help. And
there is no central wrapper to put the guard in: the 79 factories are
independent, each doing its own dereference. Meanwhile TypeScript already
rejects both `null` and a missing argument at compile time, so the only callers
who can reach this are untyped ones passing obviously-bad input.

Re-measured against Bug #3, which *was* real: Bug #3 was a bare `Error` thrown
by working validation code, and the fix was to throw `ValidationError` from
inside `require`. Different bug, different fixability.

**Kept, not deleted** because the characterization tests in
`tests/unit-error-contract.mjs` § 3 still pin the current behavior, and because
the honest conclusion — "this is not fixable the way we first thought" — is
worth recording so nobody re-files it.

**Status:** ⚪ Withdrawn. Do not report upstream. If someone wants to revisit
it, the only shape that works is a single wrapper every factory is routed
through — a larger refactor than the defect justifies.

---

## Bug #5 — Seven base transaction fields are missing from all 79 factory prop types (OPEN)

**Factories:** all 79 (gap is systemic, not per-factory)

> **Scope note.** This entry was first written as "`TicketSequence` is missing,
> so tickets can't be spent." Investigation showed that framing was both too
> narrow and slightly wrong. The real finding is a **structural gap in the type
> surface** that affects seven base fields — and it is *not* a runtime hole.

**The gap:** `src/types/base.ts` `BaseTransactionFields` (line 14) declares the
common transaction fields, and `src/validation/base.ts:23` exports
`validateBaseTransaction` to check them. But **none of the 79 fp factory prop
interfaces redeclare those base fields** — every factory re-declares `Fee`,
`Sequence`, and (usually) `Flags` by hand, and seven declared base fields
appear nowhere:

```
$ for f in Memos SourceTag LastLedgerSequence AccountTxnID NetworkID Delegate TicketSequence; do
    printf '%-20s %s/79\n' "$f" "$(grep -lE "^[[:space:]]*$f\?:" src/fp/factories/*.ts | wc -l)"
  done
  Memos                0/79
  SourceTag            0/79
  LastLedgerSequence   0/79
  AccountTxnID         0/79
  NetworkID            0/79
  Delegate             0/79
  TicketSequence       0/79

# controls, same command
  Fee                  79/79
  Sequence             79/79
  Flags                63/79
  Account              79/79   (required, so no `?`)
```

So the inconsistency is: the three fields every factory happens to need are
duplicated 79 times by hand; the seven they don't need are duplicated **zero**
times, even though the type that owns all of them already exists and is already
validated by `validateBaseTransaction`.

**The validator is unreachable from the fp layer.** No fp factory *imports*
`validation/base.js`:

```
$ grep -rn "^import.*from '.*validation/base" src/fp/factories/*.ts | wc -l
  0
```

(Four files mention `src/validation/base.ts`, but all four are JSDoc
citations in comments, not imports.)

**This is a type-surface and validation-coverage gap — NOT a runtime hole.**
`buildFrozenTx` spreads the whole field set through:

```ts
// src/fp/shape.ts:56
const data = Object.freeze({ TransactionType: txType, ...fields });
```

So all seven fields work today at runtime; a caller just has to cast past the
prop type. Verified: `TicketSequence: 42` survives construction, `toJSON()`,
and `.with()`; `Memos` is already relied on by passing suite [1]. The cost is
erased type safety and skipped validation, not an unusable transaction.

**The one practically severe case is still `TicketSequence`.**
`ticketCreate` is fully supported, but a ticketed standalone transaction must
carry `Sequence: 0` and `TicketSequence: N`, so a user who creates tickets has
to merge the field in by hand, outside the factory's validation:

```js
const tx = payment({ Account, Destination, Amount });
const ticketed = { ...tx.toJSON(), Sequence: 0, TicketSequence: 1 };
```

`TicketSequence` shows up in the built package in exactly two places:
`dist/types/base.d.ts` (the internal base type) and `dist/fp/factories/batch.d.ts`
(for **inner** `RawTransactions` of a `Batch` — a different transaction).

**Canonical sources:**
- xrpl.js `packages/xrpl/src/models/transactions/common.ts` — `TicketSequence`
  is part of the base transaction interface alongside `Sequence`.
- xrpl.org `ticketcreate.md` — "The transaction that uses a ticket sets
  `Sequence` to `0` and `TicketSequence` to the ticket's number."
- rippled parses `TicketSequence` on any transaction type, not just `Batch`.
- xrpjs' **own** `src/types/base.ts:14` — the interface already declares
  `TicketSequence` (line 40 of that file). The library declares the field, then
  drops it before the public API.

**Suggested fix upstream:** have each `<Name>Props` interface `extends`
`BaseTransactionFields` instead of re-declaring `Fee`/`Sequence`/`Flags` by
hand, and call `validateBaseTransaction` from the fp layer. That closes the
type gap, removes 79 copies of the same three lines, and makes the existing
validator reachable — one change instead of seven.

**Tests added here:** ADM-11 in `integration/tests/13-account-admin.mjs`
deliberately performs the hand-merge and asserts the resulting transaction is
accepted by the ledger, and that reusing the same ticket is rejected. The
story documents the gap rather than working around it silently, so the test
fails loudly if the shape ever changes.

**Status:** 🔴 Open upstream. Not reported yet. Severity: low for the six
convenience fields, medium for `TicketSequence`.

---

## Bug #6 — `ammDeposit` performs no flag validation; `ammWithdraw` does (OPEN)

**Factories:** `ammDeposit` (defective), `ammWithdraw` (correct — used as the control)

**Bug:** The XRPL requires an `AMMDeposit` to carry **exactly one** deposit
mode flag. `xrpjson`'s `ammWithdraw` implements that check carefully. `ammDeposit`
implements **none of it** — it accepts an absent `Flags`, an explicit
`undefined`, `Flags: 0`, and multiple conflicting mode flags, all silently.

**The two factories should be identical here. They are not:**

| | `amm-withdraw.ts` | `amm-deposit.ts` |
|---|---|---|
| mode-flag bit table | `AMM_WITHDRAW_FLAG_BITS` (line 114) | **none** |
| mask | `AMM_WITHDRAW_FLAGS_MASK` (line 124) | **none** |
| `popcount32` helper | yes (line 179) | **none** |
| exactly-one check | line 294, `popcount32(...) !== 1` | **none** |
| `Flags` referenced at all | 8 sites | 3 sites, all type-only |

`grep -n "FLAG\|popcount\|Flags" src/fp/factories/amm-deposit.ts` returns only
the import of `AMMDepositFlagsInterface` (line 71), the `Flags?` property in the
props interface (line 99), and a JSDoc example (line 14). No validation.

**Why this matters.** `ammDeposit` in xrpjs is already thorough about the things
*it* owns (asset amounts, the two-asset path, min/max constraints). Skipping the
one rule the spec states in the same imperative voice for both transactions is
an oversight, not a policy decision. A caller who passes `Flags: 0` gets a
transaction object that looks valid and fails at submission with an opaque
`temMALFORMED`-class code, instead of an eager, named `ValidationError`.

**Canonical sources:**
- xrpl.org `ammdeposit.md:129` — "You must specify **exactly one** of these
  flags, plus any [global flags](../common-fields.md#global-flags)."
- xrpl.org `ammwithdraw.md:107` — byte-identical sentence. The rule is the same
  for both transactions; only the flag list differs.

**How this was found:** diffing sibling factories against each other rather
than against the docs. `ammWithdraw` was written to spec and documents its own
rule with the exact canonical sentence; reading `ammDeposit` next to it made
the absence obvious in a way that reading `ammDeposit` alone did not. The
technique is now taught in the `xrpl-tx-stories` skill — it is the highest-yield
defect-finding move available and neither the docs nor the skill previously
named it.

**Suggested fix upstream:** lift the existing `ammWithdraw` flag machinery into
a shared `validation/amm.ts` (`AMM_MODE_FLAG_BITS` + `MASK` + `popcount32`,
parameterized by the flag enum) and call it from both factories. Fixes the
defect and removes the duplication that let it through.

**Status:** 🔴 Open upstream. Not reported yet. This is the best candidate so
far to actually file — it is unambiguous, has a one-line canonical citation,
affects a public API, and the fix is already written one directory over.

---

## Test-scaffolding bugs (not xrpjson)

### Bug #S7 — Ledger rules that cost three wrong implementations

Writing suite [13] surfaced three XRPL rules that are easy to get wrong and
that no type definition or factory doc warns you about. All three were caught
only by running against testnet.

**1. A multisigned transaction needs the full fee, not the base fee.**
`client.autofill(tx)` computes the *incremental* cost, so a multisigned
payment fails with `telINSUF_FEE_P` — which reads like a funding problem.
xrpl.org `multi-signing.md`: "The transaction cost … must be at least **(N+1)
times the normal transaction cost**, where N is the number of signatures
provided." The signer count is `autofill`'s second argument:
`client.autofill(tx, 1)`.

**2. A ticket's number is not derivable from account state.**
`TicketCreate` reserves the account's *next* sequence numbers, and
rippled `TicketCreate.cpp::doApply` reads `firstTicketSeq` from the account
root *after* the transaction machinery has incremented it. Reading the
account too early — or computing `sequence + 1` from a pre-TicketCreate read
— yields a number that does not exist, and the payment fails with
`terPRE_TICKET` ("Ticket is not yet in ledger"). That code is **retriable**,
so it looks like a propagation race rather than a wrong number. The robust
move is to stop deriving it and read the tickets out of the owner directory:
`account_objects` with `type: 'ticket'`.

**3. A testnet-faucet account cannot be `AccountDelete`d for ~17 minutes.**
rippled `AccountDelete::doApply` refuses while
`account.Sequence + 255 > currentLedgerIndex`. The faucet sets a new account's
`Sequence` to the **current ledger index** (measured: `Sequence: 21195755` at
ledger `21195800`), so a freshly funded account is immediately "too soon".
256 ledgers at testnet's ~4s close is ~17 minutes. The account has to be
funded at the *top* of the suite so the rest of the run provides the wait —
and the wait needs a per-test timeout override, because the shared 90s
`runTest` budget cannot cover it, plus reconnect handling, because an idle
testnet WebSocket drops over that span.

**Status:** ✅ All three fixed in suites [12] and [13].

### Bug #S8 — `extractCreatedIndex` silently returns undefined for NFToken mints

`integration/helpers.mjs` reuses the generic `extractCreatedIndex` in
`11-check-iou.mjs`, which looks for a `CreatedNode` of the requested type. An
NFToken is not created as its own ledger entry — it is appended to an
`NFTokenPage`, appearing as a `ModifiedNode` (or `CreatedNode` for the first
page) with the ID at `NFTokens[-1].NFToken.NFTokenID`. So
`extractCreatedIndex(res, 'NFToken')` finds nothing and returns `undefined`
with no error.

Suite [8] already worked around this with a local `extractNFTokenId`. Suite
[12] initially used the shared helper and failed 17/17 at the first mint.
`extractNFTokenId` is now in `helpers.mjs` so the next suite does not
rediscover it.

A related trap: `extractCreatedIndex` also returns
`NewFields.NFTokenID` for an `NFTokenOffer`, which is the *token's* ID, not
the offer index. `extractOfferIndex` reads `CreatedNode.LedgerIndex` instead.

**Status:** ✅ Fixed. Three purpose-named extractors now exist rather than one
overloaded one.

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

### Bug #S3 — Bob's HighLimit on Carol trust line was 0

**Files:** `integration/tests/10-iou.mjs`, `integration/tests/11-check-iou.mjs`

**Bug:** When Carol opened her trust line to Bob (LimitAmount value=50000),
only Carol's LowLimit was set. Bob's HighLimit on the Bob<->Carol trust
line stayed at 0 (default). For rippling through Bob (Alice → Bob → Carol)
to work, Bob's HighLimit on **both** sides (Alice-Bob and Bob-Carol) must
be > 0.

**Symptom:** `tecPATH_PARTIAL` on cross-currency payments and check-cashing
flows that routed through Bob.

**Fix:** Added a step at the start of [10] and [11] where Bob sets his
HighLimit on the Carol trust line via `TrustSet` with `LimitAmount.issuer=carol`.

**Status:** ✅ Fixed.

### Bug #S4 — [3] TrustSet limits lower than [10] balance ceiling

**File:** `integration/tests/03-trust-set.mjs`

**Bug:** After my [10] reorder, [10] already set up USD/EUR trust lines
with limit 50000 and issued 10000 USD + 4500 EUR to Alice. Then [3] ran
TrustSet to update Alice's LowLimit to 10000 USD / 5000 EUR — but Alice
already had 10000 USD, so the new limit was breached immediately. [4] then
tried to issue 100 more USD (Alice balance would go to 10100 > 10000) and
got `tecPATH_DRY`.

**Fix:** Updated [3] to use `value: '50000'` for USD and `value: '10000'`
for EUR (matching/exceeding [10]'s balance).

**Status:** ✅ Fixed.

### Bug #S5 — Bob's TransferRate from [2] blocks rippling in [10]

**File:** `integration/tests/10-iou.mjs`

**Bug:** [2] set `TransferRate: 1_005_000_000` (0.5% fee) on Bob. This fee
applies to holders moving Bob's issuances. [10]'s cross-currency rippling
tests (Alice → Bob → Carol) couldn't path through Bob because the fee
made the effective amount insufficient.

**Symptom:** `tecPATH_PARTIAL` on Alice → Carol rippling tests when run
after [2] in the full suite (but NOT in standalone [10], where Bob had
no AccountSet flags).

**Fix:** Added a step at the start of [10] that resets Bob's TransferRate
and TickSize to 0, undoing any state from [2].

**Status:** ✅ Fixed.

### Bug #S6 — `xrpjson.mjs` shim's reference comment is wrong

**File:** `xrpjson.mjs`

**Issue:** The comment said "xrpjson 1.0.2 exposes its functional factories
from the documented root." As of v1.0.3, this is `1.0.3`, not `1.0.2`. The
shim still works.

**Status:** ✅ Fixed. The comment now tracks the installed version (`1.1.0`),
and it records the non-obvious part: `ValidationError` and the `*Flags` enums
are **not** on the root entry point, only on `xrpjson/errors` and
`xrpjson/flags`. Importing them from bare `xrpjson` yields `undefined`, which
makes `err instanceof ValidationError` silently `false` — the same
mis-routing Bug #3 is about, arrived at from the other direction.

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

### Coverage #3 — Error-contract suite locks the `ValidationError` guarantee

`tests/unit-error-contract.mjs` (added for the v1.1.0 upgrade) asserts the
error *type*, not just the fact of throwing:

- The two paths fixed in 1.1.0 (`accountSet` TickSize, `payment` DeliverMin)
  throw `ValidationError` with the exact expected message.
- Their valid values still construct — guarding against the fix over-tightening.
- A cross-cutting sweep over all 79 factories × 10 malformed input shapes:
  anything the factories reject must be a `ValidationError`, never a bare
  `Error` or `TypeError`.

The sweep is tiered, because a uniform "must throw" assertion would be wrong:

- **Tier A (must throw)** — `{}`, bare string, `[]`, `123`,
  `{ Account: null }`, `{ Account: 123 }`. Every factory has an `Account`
  requirement, so all 79 reject these.
- **Tier B (may ignore)** — field-specific garbage like
  `{ Account, Amount: "not-a-number" }`. Four factories
  (`accountSet`, `didDelete`, `mptokenIssuanceCreate`, `setRegularKey`)
  have no `Amount` field at all, so ignoring it is correct. The invariant is
  only: *if* it rejects, the rejection is a `ValidationError`.

This suite is also the first place in the repo that asserts the shim's
`ValidationError` is the *same class object* as `xrpjson/errors`'s — if those
ever diverge, every `instanceof` check against the root import silently
starts returning `false`.

**Status:** ✅ 30 tests, green.

---

## Summary

- **4 real bugs** in xrpjson found — 3 fixed upstream (v1.0.3, v1.0.4, v1.1.0),
  **2 open**, 1 withdrawn:
  - **Bug #6 (open)** — `ammDeposit` does no flag validation at all, while
    `ammWithdraw` enforces the identical "exactly one" rule. **Strongest
    candidate to actually file upstream.**
  - **Bug #5 (open)** — 7 base fields (`Memos`, `SourceTag`,
    `LastLedgerSequence`, `AccountTxnID`, `NetworkID`, `Delegate`,
    `TicketSequence`) are declared in `BaseTransactionFields` and validated by
    `validateBaseTransaction`, but appear in **0 of 79** factory prop types,
    and the validator is unreachable from the fp layer. A type-surface and
    validation-coverage gap — **all seven work at runtime**; `TicketSequence`
    is the one with real user impact.
  - **Bug #4 (withdrawn)** — `factory()` / `factory(null)` throw `TypeError`.
    Re-measured and taken back: the proposed fix cannot work, because
    `require(props.Account, …)` dereferences at the call site, before a guard
    inside `require()` could run, and there is no central wrapper to hold one.
- **5 + 2 test-scaffolding bugs** in 173-xrpjson-testing found and fixed
  (S7 covers three ledger rules, S8 the NFT metadata extractors).
- **Coverage expanded** from 7 (unit) + 11 (integration) test scenarios to:
  - 20 unit scenarios (test.mjs)
  - 322 generic factory contract scenarios (unit-generic-harness.mjs)
  - 236 per-family happy-path scenarios (unit-families.mjs)
  - 30 error-contract scenarios (unit-error-contract.mjs)
  - 70 integration scenarios, suites [1]–[11] (integration/run-all.mjs)
  - 18 integration scenarios, suite [12] NFT lifecycle
  - 23 integration scenarios, suite [13] account admin
  - **Total: 719 test scenarios across all 79 factories.**

New user stories are specified in [USER-STORIES.md](./USER-STORIES.md),
which the [12] and [13] suites are written against.

### xrpjson release history driven by this project

| Version | What it fixed | Found by |
|---|---|---|
| v1.0.3 | `EscrowCreate` Ripple Epoch lower bound | integration suite [6] |
| v1.0.4 | `AccountSet` did not require `Account` | `unit-generic-harness.mjs` |
| v1.1.0 | `accountSet` TickSize + `payment` DeliverMin threw bare `Error` | upstream citation audit; guarded here by `unit-error-contract.mjs` |
| *unreleased* | `ammDeposit` accepts zero, one, or many mode flags | sibling-factory diff (`ammDeposit` vs `ammWithdraw`) |
| *unreleased* | 7 base fields missing from all 79 factory prop types | suite [13], ADM-11, then widened by source audit |
| *withdrawn* | `factory()` / `factory(null)` throw `TypeError` | `unit-error-contract.mjs` § 3 — not fixable as proposed |

Suites [12] and [13] found **no new xrpjson defect among the 8 factories they
exercise**; all behaved per spec against a live ledger, and the three failures
hit while writing them (S7) were bugs in the tests' understanding of ledger
rules. Bugs #5 and #6 both came from *reading the source*, not from running
transactions — which is a finding about this project's method, and the reason
the `xrpl-tx-stories` skill now teaches source-reading and sibling diffing as
first-class moves.