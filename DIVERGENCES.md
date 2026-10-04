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

## Bug #5 — Seven base transaction fields were missing from all 79 factory prop types (FIXED upstream, 79/79, verified here)

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

**The validator has no callers at all.** It is not merely unreachable from the
fp layer — nothing in `src/` invokes it. Stripping comments out of the search
leaves exactly one reference, the re-export:

```
$ grep -rn "validateBaseTransaction" src/ --include=*.ts \
    | grep -vE "^\S+:[0-9]+:\s*(\*|//)" \
    | grep -v "^src/validation/base.ts"
  src/validation/index.ts:1:export { validateBaseTransaction } from './base.js';
```

Thirty-two files mention `src/validation/base.ts`; **every one is a JSDoc
citation**, and most quote *xrpl.js's* `validateBaseTransaction` rather than
calling the local one. So the finding is sharper than "the fp layer skips it":
the function is fully written, fully correct, exported for consumers through
`xrpjson/validation` — and the library itself never uses it.

It is not a stub. It validates all seven of the fields above, including a rule
no factory can ever reach:

```ts
// src/validation/base.ts:99-103
if (tx['Delegate'] === tx['Account']) {
  throw new ValidationError(
    'Transaction: Account and Delegate addresses cannot be the same');
}
```

Since no factory accepts `Delegate` at all, that check is provably dead from
the public API. Demonstrated live in `integration/demos/bug5-base-fields/`: a caller can
build `ammDeposit({ Delegate: <same as Account> })`, get a valid-looking frozen
object, and meet the failure only at submission.

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

**The type surface is where a consumer actually feels it.** Against the
published `xrpjson@1.2.0`, `tsc` rejects three adjacent fields in the *same*
object literal — two of which the factory does declare:

```
error TS2353: … 'TicketSequence' does not exist in type 'PaymentProps'.
error TS2353: … 'Memos'          does not exist in type 'AmmDepositProps'.
error TS2353: … 'SourceTag'      does not exist in type 'AmmDepositProps'.
```

`Fee` and `Sequence` on those same calls compile clean. That contrast is the
defect: the compiler is the only guard, and it is pointing the wrong way.
Runnable demonstration in `integration/demos/bug5-base-fields/` — `demo-bug5.mjs` shows
the runtime half (garbage values accepted, then rejected by the shipped
validator), `type-demo.ts` shows the compile-time half.

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
Re-checked against `xrpjson@1.2.0`: all seven fields are still **0 of 79**, and
`batch.d.ts` is still the only factory file that mentions it. The gap did not
close in 1.2.0.

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

**Status:** 🟡 **Partially fixed, not yet released.** Severity: low for the six
convenience fields, medium for `TicketSequence`.

**Corrected progress (measured 2026-10-04).** "10 of 79 done" undercounts the
work banked, because the fix has **two independent halves** at very different
levels of completion. Counting each separately:

| Half | What it means | Done | Remaining |
|---|---|---|---|
| **Type surface** | props interface inherits `BaseTransactionFields` | **11/79** | 68 |
| **Runtime validation** | factory calls `validateBaseTransaction` | **38/79** | 41 |

By file, over all 79:

| Category | Count | Missing |
|---|---|---|
| Fully converted | 10 | — |
| Runtime done, type missing | 28 | the type change only |
| Neither | 40 | both |
| Type done, runtime missing | 1 (`vault-clawback`) | the runtime call only |

`vault-clawback` importing `BaseTransactionFields` without ever calling
`validateBaseTransaction` is an inconsistency rather than a gap, and is worth
fixing for its own sake. The 28 runtime-only files are the cheapest remaining
work: validation already happens, only the type surface is missing.

Reproduce:

```bash
cd 175-xrpjson
for f in src/fp/factories/*.ts; do
  t=$(grep -c BaseTransactionFields "$f"); r=$(grep -c validateBaseTransaction "$f")
  echo "$t $r $(basename "$f" .ts)"
done | sort
```

**Progress detail.** The fix is being applied **one family at a time**, proving
the pattern before scaling it — a 79-file refactor is a two-file revert when it
goes wrong on family 1, and a 79-file archaeology exercise when it goes wrong on
family 79.

Ten factories across five families converted so far:

| Family | Factories | Change | Tests |
|---|---|---|---|
| `Payment` | `payment` | `Props extends Omit<BaseTransactionFields, 'TransactionType' \| 'Flags'>`; `validateBaseTransaction` called after the factory's own checks | +12 |
| `Ticket` | `ticketCreate` | same | +6 |
| `TrustSet` | `trustSet` | same, applied by codemod | +9 |
| `Check` | `checkCreate`, `checkCash`, `checkCancel` | same | +27 |
| `Escrow` | `escrowCreate`, `escrowFinish`, `escrowCancel` | same | +27 |
| `AccountSet` | `accountSet` | same | +9 |

Families 3–6 were applied by a codemod rather than by hand, and the result is
byte-identical in shape to families 1–2. `175-xrpjson` gates: tsc 0, lint 0,
**2948 tests** (was 2858). **Not one pre-existing test broke** — that is the
actual evidence that the pattern generalises rather than merely type-checks.

Forward-compat: the harness's all-79 happy-path fixtures were re-run against the
newly built `dist` (imports rewritten to bypass `node_modules`) — **236/236 still
construct**. The stricter validation does not reject any input the harness
already considered valid, so a future `xrpjson` bump will not break this repo.

**The `Omit` is load-bearing, not decoration.** Two reasons, both verified:

1. `TransactionType` — `buildFrozenTx` builds
   `Object.freeze({ TransactionType: txType, ...fields })`. The spread comes
   *second*, so a caller-supplied `TransactionType` would silently override the
   discriminator. Inheriting the base field would put that hazard in the type.
   A test asserts `TransactionType` is still rejected.
2. `Flags` — the base types it `number | GlobalFlagsInterface`, but each
   transaction narrows it to its own flags interface. Since
   `PaymentFlagsInterface extends GlobalFlagsInterface`, the narrowing is
   assignable and legal to re-declare. Omitting first is what makes the
   redeclaration type-check.

**The validator call is placed LAST**, after each factory's own field checks.
That ordering is a decision, not an accident: a specific mistake should get a
specific message, and the base check is the backstop for everything shared. A
test pins it — `ticketCreate({TicketCount: 0})` must still say
"TicketCount must be an integer from 1 to 250", not a generic base-field error.

**What this changes for a user, concretely.** All ten converted factories now
reject what `validateBaseTransaction` always meant to reject:

```
payment({ ..., Memos: 'not-an-array' })   -> ValidationError: invalid Memos
payment({ ..., SourceTag: 'NaN' })        -> ValidationError: SourceTag must be a number
payment({ ..., Delegate: <same as Account> }) -> ValidationError: cannot be the same
ticketCreate({ ..., TicketSequence: 42 }) -> builds  ← previously impossible
```

`validateBaseTransaction` is no longer orphaned: it has its first real callers.

**Still open:** 68 factories still lack the type change, 41 still lack the
validator call, and `vault-clawback` is missing only the call. The work has been
handed to a second agent. The 90 tests added here are family scoped — they are
not a claim about the package.

### Bug #5 — resolved (upstream, 79/79, measured by this harness)

**Status: ✅ FIXED in `175-xrpjson`, 79/79 factories, both halves.** The upstream
agent reports `tsc` exit 0, `lint` exit 0, 4023/4023 tests green (baseline
2948), 150 files changed, nothing skipped. Independently re-verified here by
counting *code shapes* rather than bare words:

```
validateBaseTransaction(  at start of line   →  79 / 79 factories
extends BasePropsFields  (incl. via alias)   →  79 / 79 factories
factories missing both halves                →   0
```

Two of the 79 do not match a naive `extends Omit<` grep and are correct
anyway: `payment.ts:53` routes through a local
`type PaymentBaseFields = Omit<BasePropsFields, …>` alias, and
`ticket-create.ts:93-94` inlines `Omit<BasePropsFields, …>` in a multi-line
type expression. Both were read, not assumed.

**Two corrections to the original entry, both of which the original got wrong.**

1. **The `Omit<BaseTransactionFields, …>` this entry recommended is inert.**
   `BaseTransactionFields` ends with `readonly [key: string]: unknown`
   (`src/types/base.ts:87`). That index signature widens `keyof` to
   `string | number`, and `Omit` is defined in terms of `keyof` — so the `Omit`
   does not subtract two keys from fourteen named members, it **collapses to a
   bare index signature and discards every one of them**. Following the original
   recipe would have made the type half compile and enforce nothing. The
   upstream fix adds `BasePropsFields`, a key-remapped mapped type that filters
   the index signature out while preserving each named field's exact type.
2. **"38/79 already call `validateBaseTransaction`" was a false positive.** The
   real figure was **10/79**; the other 28 matched JSDoc prose such as
   *"inherits `validateBaseTransaction`'s `isString(Account)` check"*. The
   runtime half was 69 factories, not 41. Two upstream workers caught this
   independently by reading source, and the upstream agent then repeated the
   same mistake once more (reporting "79/79 typed" from a `grep -l` that matched
   an aspirational comment — true count 49/79) before switching to a
   comment-stripped count. **The lesson is recorded as Bug #S12 below**,
   because it has now cost three wrong numbers across two agents.

The ordering guarantee this entry recorded still holds, and upstream verified it
independently: `setRegularKey({ Account, RegularKey: Account })` still reports
its own `temBAD_REGKEY` message rather than a generic base backstop, and
`ledger-state-fix` keeps its ≥2,000,000 Special Transaction Cost floor ahead of
the base `Fee` check.

**Do not read the old "68 factories still lack…" line as current.** It records
the state at handoff and is left in place deliberately, as the before-picture.

---

## Bug #6 — `ammDeposit` performs no flag validation; `ammWithdraw` does (FIXED in v1.2.0, verified live)

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

**Status:** 🟢 **Fixed in v1.2.0.** Verified against a live ledger by suite
[14] (`integration/tests/14-amm-deposit-flags.mjs`) — rippled answers
`temMALFORMED` for both the zero-flag and two-flag cases, matching the
`popcount(flags & tfDepositSubTx) != 1` check the fix implements. The factory
half is covered by 45 unit tests in `175-xrpjson`; the ledger half can only be
settled against a network, which is why suite [14] exists.

**Found by:** diffing sibling factories against each other rather than against
the docs. `ammWithdraw` was written to spec and documents its own rule with the
exact canonical sentence; reading `ammDeposit` next to it made the absence
obvious in a way that reading `ammDeposit` alone did not. The technique is now
taught as §1a of the `xrpl-tx-stories` skill — it is the highest-yield
defect-finding move available and neither the docs nor the skill previously
named it.

**Suggested fix upstream:** lift the existing `ammWithdraw` flag machinery into
a shared `validation/amm.ts` (`AMM_MODE_FLAG_BITS` + `MASK` + `popcount32`,
parameterized by the flag enum) and call it from both factories. Fixes the
defect and removes the duplication that let it through.

---

---

## Bug #7 — AMM factories check flag *cardinality* but not flag *membership* (FIXED in v1.2.0)

**Factories:** `ammDeposit` and `ammWithdraw` (both affected)

**Found by:** the live verification commissioned for Bug #6. Fixing Bug #6
made the ledger disagree with the factory in a case the factory had never been
asked about, and the disagreement is a second, independent rule.

**The rule.** rippled applies **two** checks to `AMMDeposit` flags, in order:

1. **Membership** — `getFlagsMask` returns `tfAMMDepositMask`, built by
   `TO_MASK` as `~(tfUniversal | <the six deposit flags>)`
   (`TxFlags.h:264-266`, `169-176`). `tfUniversal` is only
   `tfFullyCanonicalSig | tfInnerBatchTxn` (`TxFlags.h:43-46`). Any *other* bit
   set in `Flags` is not in the mask → **`temINVALID_FLAG`**.
2. **Cardinality** — `preflight` runs
   `std::popcount(flags & tfDepositSubTx) != 1` → **`temMALFORMED`**
   (`AMMDeposit.cpp:72`).

xrpjson implements only step 2, in both AMM factories. So a bit belonging to a
*different* transaction type is silently tolerated at construction and refused
only at the ledger.

**Observed live** (suite [14], AMM-5, testnet ledger 21219576):

| `Flags` | factory | ledger |
|---|---|---|
| `tfSingleAsset` (0x00080000) | accepts | passes both checks → `temBAD_AMM_TOKENS` |
| `tfSingleAsset \| tfTwoAsset` | rejects | `temMALFORMED` |
| no `Flags` | rejects | `temMALFORMED` |
| `tfSingleAsset \| tfWithdrawAll` (0x00020000) | **accepts** | **`temINVALID_FLAG`** |
| `tfSingleAsset \| 0x00000002` | accepts | `temINVALID_FLAG` |

The distinct result codes are the evidence: `temINVALID_FLAG` is a *different*
check from `temMALFORMED`, so the ledger refused the membership question, not
the cardinality one. A caller who trusts the factory to have caught a bad flag
gets a transaction object that cannot be submitted.

**Why this is smaller than Bug #6:** it needs the caller to have combined a
flag from the wrong transaction type, which is rarer than forgetting the flag
altogether. But it is the same shape — the factory answers a question about
flags that only the ledger can fully answer, and answers it incompletely.

**Tests added here:** suite [14] AMM-5 asserts the ledger's side, so the
divergence cannot be quietly closed without also fixing the factory. The
`amm-deposit.test.ts` case "ignores a withdraw-only bit when counting deposit
modes" pins the factory's *current* behaviour deliberately, and says so in a
comment, so the pair reads as a known gap rather than a passing test.

**Status:** 🟢 **Fixed in v1.2.0**, alongside Bug #6. Both factories now build
the same validity mask rippled uses —
`UNIVERSAL_FLAGS | AMM_*_FLAGS_MASK` — and reject any bit outside it *before*
the cardinality check. `tfFullyCanonicalSig` and `tfInnerBatchTxn` stay legal
because they are in `tfUniversal`. 6 new unit tests; suite [14]'s AMM-5 will go
from documenting a gap to agreeing with the factory once 1.2.0 is published
here.

---

## Bugs #8–#10 — Three over-strict factories (fixed in 146, awaiting release)

These three came from the flag-contradiction audit in
`175-xrpjson/docs/audit/2026-10-02-flag-contradiction-audit.md`, and they are the
**opposite shape** to Bugs #6 and #7. Those two accepted what the ledger
refused; these three *refused what the ledger accepts*. A user following the
documentation could not build a valid transaction at all.

⚠️ **A correction to an earlier measurement in this file.** The audit's scope
was briefed as "7 of 63 factories validate flags." That was a **grep
artifact**: the heuristic looked for validator-shaped names
(`popcount|FLAG_BITS|FLAGS_MASK`). Sweeping instead for *runtime reads of
`props.Flags`* finds **17**. Ten factories carry real flag logic the heuristic
missed — `did-delete`, `did-set`, `loan-manage`, `loan-pay`,
`nftoken-create-offer`, `nftoken-mint`, `offer-create`, `payment`,
`sponsorship-set`, `vault-create` — and **two of these three defects live in
that hidden set.** The lesson generalises: a grep for one *shape* of code is
not a safe proxy for "does this thing reason about the field at all."

### Bug #8 — `sponsorshipTransfer` rejects `spfSponsorFee`, which rippled allows

**Severity: high.** `SponsorFlags` has no other entry point, so the documented
fee-and-reserve combination was simply unconstructible.

```ts
// src/fp/factories/sponsorship-transfer.ts:404-408 (before)
if ((props.SponsorFlags & ~SPF_SPONSOR_RESERVE) !== 0) {
  throw new ValidationError('SponsorshipTransfer: SponsorFlags may only set the spfSponsorReserve bit…');
}
```

rippled keeps the two sponsor bits in **independent** predicates
(`isFeeSponsored` / `isReserveSponsored`, `SponsorHelpers.h:32-45`) and its
`spfSponsorFlagMask` excludes both from the invalid set. xrpl.js 5.3.0 uses the
same mask. `SponsorFlags: 0x00000003` is the documented fee+reserve form.

This is `SponsorFlags`, not `Flags` — `Flags` itself is correct here.

**Status:** ✅ **Fixed in `175-xrpjson` `3a55880`, not yet released, and now
ledger-verified.** Closed 2026-10-02.

**The ledger verdict.** This bug was previously unclosable: `featureSponsor` is
disabled on testnet, *and* this harness pinned `xrpl@4.6.0`, which could not even
name the transaction type. Both are resolved — the repo now uses `xrpl@5.3.0`
(the first release that can encode `SponsorshipTransfer`, XLS-68 / xrpl.js PR
#3238), and devnet has the amendment enabled (`feature` → `Sponsor: enabled:
true`, confirmed live).

```bash
XRPL_WSS=wss://s.devnet.rippletest.net:51233 \
  node integration/tests/15-flag-defect-verification.mjs
# Defect 1 — sponsorshipTransfer SponsorFlags: fee + reserve
#   ✓ factory builds SponsorFlags fee+reserve (0x03)
#   ✓ factory still refuses a bit outside fee+reserve
#     ledger said: terNO_PERMISSION
#   ✓ ledger did not reject the flags (got terNO_PERMISSION)
# Total: 11/11 passed | 0 failed | 0 skipped
```

**Why `terNO_PERMISSION` is the passing result, not a failure.** The test's real
assertion is negative: it fails only on `temINVALID_FLAG`, which is what a wrong
flag mask would produce. `terNO_PERMISSION` is `ter`-class — resubmittable,
apply-phase — which means the transaction cleared preclaim. The ledger *parsed
the flags and accepted them*, and was then refused on business grounds, because
Bob is not a permitted sponsor for that object. `tem` (malformed) and `ter`
(apply-phase) are different layers, and the distinction is the whole point:
`temINVALID_FLAG` would have meant the mask is wrong.

Suite [15] is now **11/11 with zero skips** (was 10/11 with 1 skip).

**Caveat, stated so it is not over-read.** This confirms the *flag mask*. It does
not confirm the sponsorship business rules end to end, because a real fee+reserve
sponsorship needs a sponsored account and a live sponsor relationship that this
test does not set up. The flag verdict is what this bug was about, and that part
is now settled against a live ledger.

### Bug #9 — `mptokenIssuanceCreate` treats a boolean-map `Flags` as zero

`Flags` has two documented input forms: a numeric bitmask, or a boolean map
keyed by `tfMPT*` names. The map form was collapsed to `0` before the
cross-field gates ran, so a caller who correctly wrote
`{ tfMPTCanTransfer: true }` was told their `TransferFee` needed a flag they had
just set.

The inconsistency is the tell: the sibling `mptokenIssuanceSet` already resolved
the map correctly.

**Status:** 🟡 **Fixed in `3a55880`, not yet released.** Ledger-verified by
suite [15] — `Flags=0x20` with `TransferFee: 100` returns `tesSUCCESS`, and the
control without the flag is refused.

### Bug #10 — `nftokenMint` gates `TransferFee` on presence; rippled gates on value

```ts
// src/fp/factories/nftoken-mint.ts:319-327 (before)
if (props.TransferFee !== undefined && (numericFlags & TF_TRANSFERABLE) !== TF_TRANSFERABLE) { /* throw */ }
```

```cpp
// NFTokenMint.cpp:92-96
// If a non-zero TransferFee is set then the tfTransferable flag must also be set.
if (f > 0u && !ctx.tx.isFlag(tfTransferable)) return temMALFORMED;
```

**The prose is what is wrong here.** XLS-20 and xrpl.org both describe the
coupling in terms of *presence*, so the old code was defensible against the
documentation and wrong against the implementation. Settled on a live ledger:
`TransferFee: 0` without `tfTransferable` is accepted, `TransferFee: 1` without
it is `temMALFORMED` — identical flag state, different value. Suite [15] pins
both halves as a controlled pair.

This finding independently reproduces a conclusion reached earlier in this
project by a different route, which is worth noting: the implementation and
the prose disagree here, and the ledger is what settles it.

**Status:** 🟡 **Fixed in `3a55880`, not yet released.** Ledger-verified.

---

## Bug #11 — Every factory serialises unrecognised props straight to the wire (OPEN)

**Factories:** all 79. Systemic, not per-factory.

**Found by:** suite [16b], as collateral damage from a real MPT test. Not a
theoretical review finding — it broke a test, cost a diagnostic cycle, and was
reproduced independently on the **published v1.2.0** (see below), so it is
shipped, not merely in progress.

**The mechanism.** Every one of the 79 factories serialises with the same
shape (`buildFrozenTx` spreads `props` wholesale, then `toJSON` walks every
key):

```ts
// 79 / 79 factories
toJSON(this) {
  const json: Record<string, unknown> = {};
  for (const k of Object.keys(this)) { … json[k] = v; }
  return json;
}
```

Each factory validates a **known, closed set** of fields — meticulously, with
per-field and cross-field rules. But nothing rejects a field that is *not* in
that set. `buildFrozenTx` does
`Object.freeze({ TransactionType: txType, ...fields })`, so an unknown key
arrives on the object, and `toJSON` copies it into the serialised transaction
without having been validated at all.

**Why this contradicts the package's own contract.** Every factory docstring
states:

> "Validation happens at construction; there is no way to construct an invalid
> tx."

That is true of the fields a factory knows about and false of the fields it
does not. A consumer can build a transaction the ledger will always reject.

**Reproduced here, against published `xrpjson@1.2.0`** (four factories, four
distinct unknown keys, all silently accepted):

```
setRegularKey  : TransactionType,Account,TotallyBogusField
payment         : TransactionType,Account,Destination,Amount,Nope
mptokenIssueSet : TransactionType,Account,MPTokenIssuanceID,TransferFee,MaximumAmount
accountSet      : TransactionType,Account,TransferRate,Bogus
```

**The live consequence, from 16b.** `MaximumAmount` is an
`MPTokenIssuanceCreate` field. `MPTokenIssuanceSet` has no such field —
xrpl.js's own `MPTokenIssuanceSet` interface (`MPTokenIssuanceSet.d.ts`)
declares `MPTokenIssuanceID`, `Holder`, `IssuerEncryptionKey`,
`AuditorEncryptionKey`, `Flags`, `MPTokenMetadata`, `TransferFee`,
`ImmutableFlags`, `DomainID` and nothing else. The factory built the
transaction without complaint, and rippled's codec rejected it at submit time:

```
Field 'MaximumAmount' found in disallowed location.
```

That is a confusing submit-time error where a `ValidationError` at
construction is the entire point of the package.

**Severity — and the reason it is narrower than it looks.** TypeScript catches
every instance of this: an unknown prop is not assignable to the props
interface, so `tsc` fails. **JavaScript does not.** The package is published as
ESM and consumed from JavaScript, and this repository's own harness is
JavaScript. So the exposure is real but confined to untyped consumers.

**Suggested fix upstream.** Enforce a closed key set once, in
`buildFrozenTx` (`src/fp/shape.ts:51`), rather than 79 times in the factories —
pass the known-key set in and reject anything else with a `ValidationError`
naming the offending key. This is behaviour-changing across the whole package:
any current consumer relying on a silently-ignored prop will start getting an
error. That is why it was **not** folded into the Bug #5 sweep, and why it
deserves its own change rather than riding along with it.

Note the adjacency to Bug #5: both are the same root cause, *no closed
field-set enforcement*. Bug #5 fixed the seven fields the package forgot to
declare; this is the inverse error — fields the package correctly refuses to
declare, but then fails to reject at runtime.


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

### Bug #S9 — The `ammDeposit` happy-path fixture omitted a mandatory flag

**File:** `tests/unit-families.mjs`

**Found by:** upgrading this harness to `xrpjson@1.2.0`, which is the honest
answer to "what breaks when a library fix actually lands." Three tests failed on
the install, not on a code change:

```
✗ ammDeposit — constructs and freezes with minimal input
✗ ammDeposit — toJSON() returns canonical wire shape
✗ ammDeposit — with({ Fee: '12' }) returns a new frozen object
  AMMDeposit: Flags must specify exactly one AMM-deposit mode flag
```

**Classification: test-scaffolding defect, not a library defect.** The library
is right and the fixture was wrong. `checkFactory` built `ammDeposit` from
`Account`, `Asset`, `Asset2`, and `Amount` with no `Flags` — an input the spec
has never permitted. The fixture only passed because the factory used to accept
it, so the test was asserting the *bug* (Bug #6) rather than the contract.

**Fix:** added `Flags: 0x00080000` (`tfSingleAsset`) to the fixture, with a
comment citing `ammdeposit.md:129` and rippled's preflight. Not weakened: the
tests still assert the same three properties, just against a valid transaction.

**Why it is worth recording.** This is the failure mode the whole project is
built to avoid, appearing in the project's own harness. A happy-path fixture
that constructs the *minimum the library accepts* is not testing the spec — it
is testing whatever the library happens to tolerate. When a library gets
stricter, that fixture fails, and the instinct to "fix" it by loosening the new
check is exactly backwards. Suite [14] is the deliberate counterweight: it pins
the rule from the ledger side so a future loosening has something to fail
against.

### Bug #S10 — Suite [15] had no standalone entry point and exited 0

**File:** `integration/tests/15-flag-defect-verification.mjs`

**Found by:** running the file its own header told you to run.

```
$ node integration/tests/15-flag-defect-verification.mjs
$ echo $?
0
```

**No output. Exit 0.** The module defined and exported `run()` but never
called it — the `if (process.argv[1] === fileURLToPath(import.meta.url))`
guard that suites [12]–[14] all carry was missing. Every other suite in this
directory has it.

**Why this is worse than a crash.** A suite that throws is obvious. A suite
that exits 0 having tested nothing is the failure mode this project exists to
prevent: it looks exactly like a green run, in a terminal, in CI, in a report
someone copies. The header comment claiming "Run standalone: node …" made it
more dangerous, because following the documented instruction was the way to
reach the false pass.

**Fix:** added the standard guard, delegating to `withStandaloneSetup(run)`.
The suite then runs as documented: **10 passed, 0 failed, 1 skipped** (the skip
is Defect 1, explained in Bug #8).

**As of 2026-10-02 the skip is gone.** On `xrpl@5.3.0` the client can encode
`SponsorshipTransfer`, so the check runs on testnet too — **11 passed, 0 failed,
0 skipped**. Testnet returns `temDISABLED` because the amendment is off there;
run against devnet for the real flag verdict, which is `terNO_PERMISSION` (see
Bug #8).

**The transferable rule.** A test file that exports a runner and is not wired
into a caller has *no* failure signal by construction. Wiring it into
`run-all.mjs` is what makes it real; the standalone guard is what makes it
verifiable by hand. Neither is optional, and "it exits 0" is not evidence that
either exists.

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

### Bug #S11 — `MPTokenIssuanceID` is in neither the meta nor the ledger index

Found writing suite [16b]. This is an **xrpl.js** gap, not an xrpjson one, but
it is the same species as Bug #S8: a generic reader hands you a plausible value
of the wrong shape, and the failure surfaces several steps later as a `tem*` or
`tec*` code that points at the wrong thing.

**What is actually there.** All three facts below were measured against testnet
(rippled 3.4.1), not inferred from source:

1. `MPTokenIssuanceCreate`'s `CreatedNode.NewFields` contains exactly
   `Flags`, `Issuer`, `Sequence`. **There is no id field.** So
   `extractCreatedIndex` correctly falls through to `LedgerIndex` and returns
   64 hex characters.
2. `MPTokenIssuanceID` is a `Hash192` — 24 bytes, **48 hex characters** — per
   `ripple-binary-codec/dist/enums/definitions.json`:
   `["MPTokenIssuanceID",{...,"type":"Hash192"}]`. The `LedgerIndex` is a
   `Hash256`. The two cannot be the same string.
3. Truncating the `LedgerIndex` to 48 characters is **wrong**, and this is the
   trap: the two hashes share no bytes. `MPTokenAuthorize` with a truncated id
   against a freshly created issuance answered `tecOBJECT_NOT_FOUND`. A prefix
   *looks* like a legitimate derivation and is not one.

**Where it really lives.** The id is a field on the ledger object, returned by
`ledger_entry` as `mpt_issuance_id`:

```js
const res = await client.request({
  command: 'ledger_entry',
  ledger_entry_type: 'mpt_issuance',
  index: /* the CreatedNode's LedgerIndex */,
});
res.result.node.mpt_issuance_id;  // 48 hex chars
```

**The xrpl.js gap that makes this necessary.** xrpl.js's own interface for
this object omits the field entirely —
`node_modules/xrpl/dist/npm/models/ledger/MPTokenIssuance.d.ts` declares
`LedgerEntryType`, `Flags`, `Issuer`, `Sequence`, `OutstandingAmount`,
`OwnerNode` and the rest, but **no** `mpt_issuance_id`, even though rippled
returns it on the wire. A TypeScript consumer of `MPTokenIssuance` therefore
cannot reach the one field every MPT transaction requires as its primary key,
without dropping to a raw `client.request` and asserting the shape by hand.
(`MPToken.d.ts` *does* declare `MPTokenIssuanceID`, so the omission is
specific to the issuance object.)

**Fix:** `integration/helpers.mjs` gained
`extractMPTokenIssuanceId(client, response)`, which reads the object back and
throws rather than returning a value of unknown provenance. Suite [16b] calls
it and no longer substitutes a made-up 48-hex id.

**Status:** ✅ Fixed in the harness. The xrpl.js interface gap is worth an
upstream report; it is not an xrpjson defect.

### Bug #S12 — A bare-word `grep` for a function name measures prose, not code

**This one has now produced three wrong numbers across two agents.** Recording
it because the failure is invisible: the number looks like an answer, the brief
reads like ground truth, and it propagates into someone else's work.

1. A briefing asserted **"38/79 factories already call
   `validateBaseTransaction`"**, derived from `grep -l validateBaseTransaction`.
   The true figure was **10/79**. The other 28 matched **JSDoc prose** —
   comments like *"inherits `validateBaseTransaction`'s `isString(Account)`
   check"*. Twenty-eight files, confidently wrong. Both upstream workers caught
   it independently by reading source; the gap was ~30% of the job.
2. The upstream agent then **repeated the identical mistake** mid-task,
   reporting "79/79 factories typed" from `grep -l BasePropsFields`. That
   matched an *aspirational comment* — the very comment explaining the fix.
   True count at the time: **49/79**. A worker refused its next task because the
   premise did not hold.
3. The final audit now strips comments before counting.

**Why it keeps happening.** `grep -l <name>` answers "does this string appear
anywhere in this file", which is a strictly weaker question than "is this
called". In a codebase with a documented-divergences convention, *most*
factories legitimately mention the validator in prose — the convention
guarantees it. The files most likely to match a bare-word grep are the files
with the best documentation.

**The rule.** Anchor the pattern to code shape, then print the matching lines
and read them before quoting any number:

| Looking for | Pattern |
|---|---|
| a call site | `^[[:space:]]*fnName\(` |
| an import | `^import .*\{ fnName` |
| an `extends` clause | match the whole clause — a multi-line `extends Omit<\n  Base,\n  …\n>` will not match a one-line grep |
| a field on an interface | `^[[:space:]]*readonly fnName[?]?:` |

**Corollary for delegating work.** When a briefing hands me an inventory, spot
check the cheapest claim in it before passing it to anyone else — *especially*
when the number is already labelled "measured, do not re-derive". Two of these
three were labelled exactly that way. "Measured" in a briefing is a claim about
someone's process, not a fact about the code.

**Corollary for the harness.** Strip comments before counting, mechanically, not
by remembering to.

### Bug #S13 — `AccountSet` has two flag namespaces, and mixing them succeeds

Found writing suite [16b]. Cost one diagnostic cycle and nearly produced a false
"Bug #11 in the wild" — worth writing down because **nothing errors**.

`AccountSet` carries two unrelated flag fields, and they use *different
encodings*:

| Field | Encoding | xrpl.js enum | Example |
|---|---|---|---|
| `SetFlag` | **1-based table index**, not a bitmask | `AccountSetAsfFlags` | `asfDefaultRipple = 8` |
| `Flags` | **bitmask** | `AccountSetTfFlags` | `tfRequireDestTag = 65536` |

The trap is that neither field rejects the other's encoding. Measured on fresh
faucet wallets against testnet:

```
accountSet({ Account, Flags: 0x00010000 })  ->  tesSUCCESS, root Flags -> 0x00020000
accountSet({ Account, Flags: 8 })          ->  temINVALID_FLAG
accountSet({ Account, SetFlag: 8 })        ->  tesSUCCESS, root Flags -> 0x00800000
```

Line 1 is the hazard. `0x00010000` is the legal `tfRequireDestTag` bit, so the
transaction is valid and *changes real account state* — it set
`lsfRequireDestTag` on the root. I had meant to set Default Ripple, silently
set something else instead, and the AMM test I was fixing stayed broken for a
completely different reason than the one I was chasing.

**Do not read a flag off a doc page without its namespace.** The account-root
values (`LedgerFormats.h:138-152`) are a *third* encoding again, and they do not
match the `asf*` indices:

```
lsfPasswordSpent   0x00010000      lsfDisableMaster  0x00100000
lsfRequireDestTag  0x00020000      lsfNoFreeze       0x00200000
lsfRequireAuth     0x00040000      lsfGlobalFreeze   0x00400000
lsfDisallowXRP     0x00080000      lsfDefaultRipple  0x00800000
lsfDepositAuth     0x01000000
```

Note `lsfDefaultRipple` is `0x00800000`, **not** `0x00010000` — the value most
third-party summaries still quote. Measured: `SetFlag: 8` lands `0x00800000`.

Not an xrpjson defect — the factory's types are correct and the ledger enforces
both namespaces. This is recorded as a harness trap because the failure mode is
a *successful* transaction that does something other than what was asked.

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

- **10 real bugs** in xrpjson found — 6 released (v1.0.3, v1.0.4, v1.1.0,
  v1.2.0), **4 fixed but unreleased** (Bugs #5, #8, #9, #10), 1 open, 1 withdrawn:
  - **Bug #5 (fixed, unreleased)** — 7 base fields (`Memos`, `SourceTag`,
    `LastLedgerSequence`, `AccountTxnID`, `NetworkID`, `Delegate`,
    `TicketSequence`) are declared in `BaseTransactionFields` and validated by
    `validateBaseTransaction`, but appeared in **0 of 79** factory prop types,
    and the validator was called by **10 of 79** (not 38 — that figure was a
    `grep` matching JSDoc prose; see Bug #S12). Fixed **79/79 on both halves**,
    independently re-verified here. The originally-recommended
    `Omit<BaseTransactionFields, …>` was itself inert and had to be replaced
    with a key-remapped `BasePropsFields`.
  - **Bug #11 (open, new)** — all 79 factories serialise unrecognised props
    straight to the wire via `toJSON`'s `Object.keys(this)` walk, bypassing
    every validation rule. Reproduced on published `xrpjson@1.2.0`. TypeScript
    catches it; **JavaScript does not**, and JS is how the package is consumed.
  - **Bug #4 (withdrawn)** — `factory()` / `factory(null)` throw `TypeError`.
    Re-measured and taken back: the proposed fix cannot work, because
    `require(props.Account, …)` dereferences at the call site, before a guard
    inside `require()` could run, and there is no central wrapper to hold one.
- **Fixed by this project:** Bugs #1, #2, #3 (v1.0.3 / v1.0.4 / v1.1.0) and
  **#6 and #7 (v1.2.0)** — the latter two verified against a live ledger by
  suite [14]. Bugs #8, #9 and #10 are fixed in `175-xrpjson` `3a55880` but
  **not yet released**; all three are now ledger-verified by suite [15] —
  #9 and #10 on testnet, #8 on devnet, which is the only public network with
  the `Sponsor` amendment enabled.
- **12 test-scaffolding bugs** in 173-xrpjson-testing found and fixed
  (S7 covers three ledger rules, S8 the NFT metadata extractors, S9 a happy-path
  fixture that was asserting a library bug, S10 a suite with no standalone
  entry point, S11 the `MPTokenIssuanceID` derivation, S12 the
  `grep`-matches-prose measurement error — the last has now produced **three
  wrong numbers across two agents** and is the highest-leverage lesson here).
- **Coverage expanded** from 7 (unit) + 11 (integration) test scenarios to:
  - 20 unit scenarios (test.mjs)
  - 322 generic factory contract scenarios (unit-generic-harness.mjs)
  - 236 per-family happy-path scenarios (unit-families.mjs)
  - 30 error-contract scenarios (unit-error-contract.mjs)
  - 70 integration scenarios, suites [1]–[11] (integration/run-all.mjs)
  - 18 integration scenarios, suite [12] NFT lifecycle
  - 23 integration scenarios, suite [13] account admin
  - 5 live-ledger scenarios, suite [14] AMM deposit flags
  - 10 live-ledger scenarios, suite [15] flag-defect verification
  - **Total: 736 test scenarios across all 79 factories.** (Suite [14] runs 7
    checks; 5 are ledger-level, 2 assert the installed factory agrees. Both
    halves are active as of `xrpjson@1.2.0` — earlier they skipped.)

New user stories are specified in [USER-STORIES.md](./USER-STORIES.md),
which the [12], [13] and [14] suites are written against.

### xrpjson release history driven by this project

| Version | What it fixed | Found by |
|---|---|---|
| v1.0.3 | `EscrowCreate` Ripple Epoch lower bound | integration suite [6] |
| v1.0.4 | `AccountSet` did not require `Account` | `unit-generic-harness.mjs` |
| v1.1.0 | `accountSet` TickSize + `payment` DeliverMin threw bare `Error` | upstream citation audit; guarded here by `unit-error-contract.mjs` |
| v1.2.0 | `ammDeposit` enforced no mode-flag rule at all; AMM factories didn't validate flag membership | sibling-factory diff, then verified live by suite [14] |
| *unreleased* | `sponsorshipTransfer`, `mptokenIssuanceCreate`, `nftokenMint` rejected input rippled accepts | flag-contradiction audit `3a55880`; all three verified by suite [15] (#9/#10 testnet, #8 devnet) |
| *unreleased* | 7 base fields missing from all 79 factory prop types | suite [13], ADM-11, then widened by source audit; 10 of 79 factories fixed so far |
| *withdrawn* | `factory()` / `factory(null)` throw `TypeError` | `unit-error-contract.mjs` § 3 — not fixable as proposed |

Suites [12] and [13] found **no new xrpjson defect among the 8 factories they
exercise**; all behaved per spec against a live ledger, and the three failures
hit while writing them (S7) were bugs in the tests' understanding of ledger
rules. Bugs #5, #6 and #7 came from *reading the source* and from suite [14] —
which is a finding about this project's method, and the reason the
`xrpl-tx-stories` skill now teaches source-reading and sibling diffing as
first-class moves.