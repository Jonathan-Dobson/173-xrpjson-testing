/**
 * Bug #5 — the type-surface half.
 *
 * Everything below is rejected by `tsc` against the published xrpjson 1.2.0,
 * even though the runtime demo shows the same values work fine at runtime.
 * That gap is the defect: the compiler is the only guard, and it is pointing
 * the wrong way.
 *
 * Run: npx tsc --noEmit --module nodenext --moduleResolution nodenext \
 *            --target es2022 --skipLibCheck type-demo.ts
 */
import { ammDeposit, payment } from 'xrpjson';

const ACCOUNT = 'rGFBE8WA2ZKfqGGB7CFkLusVt7hsVT4r8H';
const ASSET = { currency: 'XRP' } as const;

// (1) The one with real user impact. `ticketCreate` works, so a user can
//     reserve a ticket — and then cannot express spending it.
payment({
  Account: ACCOUNT,
  Destination: 'rP9jPyP5kyvFRb6ZiRghAGw5u8SGAmU4bd',
  Amount: '1000',
  Sequence: 0,
  TicketSequence: 42,          // ← TS2353
});

// (2) Memos — a routine field people reach for.
ammDeposit({
  Account: ACCOUNT,
  Asset: ASSET,
  Asset2: ASSET,
  Amount: '1000',
  Flags: 0x00080000,
  Memos: [{ Memo: { MemoData: '6869' } }],   // ← TS2353
});

// (3) SourceTag — used to tag transactions for reconciliation.
ammDeposit({
  Account: ACCOUNT,
  Asset: ASSET,
  Asset2: ASSET,
  Amount: '1000',
  Flags: 0x00080000,
  SourceTag: 42,               // ← TS2353
});

// Control: a field the factory DOES declare compiles fine, which is what makes
// the three above look like a bug in the user's code rather than in the types.
ammDeposit({
  Account: ACCOUNT,
  Asset: ASSET,
  Asset2: ASSET,
  Amount: '1000',
  Flags: 0x00080000,
  Fee: '12',                   // ← OK
  Sequence: 7,                 // ← OK
});
