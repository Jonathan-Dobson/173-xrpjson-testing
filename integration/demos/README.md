# Demonstrations

Runnable evidence for a specific finding in [DIVERGENCES.md](../../DIVERGENCES.md).
These are not tests — they have no assertions and nothing runs them in CI. Each
one exists so a claim in that document can be re-checked in one command instead
of taken on trust.

## `bug5-base-fields/` — Bug #5, the seven base fields

Two halves of the same gap, one at each level.

**`demo-bug5.mjs`** — the runtime. Shows that the seven base fields missing
from every factory's prop type (`Memos`, `SourceTag`, `LastLedgerSequence`,
`AccountTxnID`, `NetworkID`, `Delegate`, `TicketSequence`) are not blocked at
runtime: garbage values for all seven are accepted and returned in a
frozen transaction object. It then runs the same objects through
`validateBaseTransaction` — the function that already ships, validates all
seven correctly, and is called by **nothing** in the package — to show the
guard exists and simply isn't wired up.

```bash
node integration/demos/bug5-base-fields/demo-bug5.mjs
```

**`type-demo.ts`** — the compile-time half, which is what a consumer actually
feels. Three `TS2353` errors for `TicketSequence`, `Memos` and `SourceTag`
against the published `.d.ts`, while `Fee` and `Sequence` on the same object
literals compile clean.

This harness has no TypeScript of its own, so the compiler comes from the
sibling checkout. It still resolves `xrpjson` from *this* repo's
`node_modules`, so it is testing the published types as a consumer sees them.

```bash
/Users/jdobson/developer/175-xrpjson/node_modules/.bin/tsc --noEmit \
  --module nodenext --moduleResolution nodenext --target es2022 \
  --skipLibCheck integration/demos/bug5-base-fields/type-demo.ts
```

Three errors is the expected output — the file is meant not to compile.

**Why this is not a test suite.** Bug #5 has no runtime consequence, so there
is nothing to assert that would fail when the gap closes. The real regression
risk is the opposite one: a future `extends BaseTransactionFields` would
silently widen 79 public types with no runtime signal at all. That wants a
type-level test in the xrpjson repo, which already has `tsc` wired up.
