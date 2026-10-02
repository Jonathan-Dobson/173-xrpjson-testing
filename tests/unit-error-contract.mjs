/**
 * Error-contract tests — locks in the xrpjson 1.1.0 `ValidationError` guarantee.
 *
 * Background: v1.1.0 changed exactly one behavior — `accountSet` (TickSize)
 * and `payment` (DeliverMin without `tfPartialPayment`) stopped throwing a bare
 * `Error` and now throw `ValidationError`, matching the other 729 throw sites.
 * See `DIVERGENCES.md` § Bug #7.
 *
 * Why this file exists: a downstream caller that branches on
 * `err instanceof ValidationError` is deciding between "user sent bad input"
 * (400) and "the library has a bug" (500). Those two paths were silently
 * mis-routed for exactly the two guards 1.1.0 fixed. Nothing in this repo
 * asserted the error *type* on those paths, so a regression would have shipped
 * unnoticed. These tests are the regression guard.
 *
 * Goals:
 *   1. The two paths fixed in 1.1.0 throw `ValidationError` with the right message.
 *   2. Their valid/boundary values still construct cleanly (no over-tightening).
 *   3. Cross-cutting: for every one of the 79 factories, malformed input that
 *      the factories *claim* to validate yields `ValidationError` — never a bare
 *      `Error`, never a `TypeError`.
 *   4. Pin the one known gap (null / no-arg still throw `TypeError`) so a future
 *      xrpjson fix flips this test loudly instead of silently.
 *
 * What this file does NOT test:
 *   - Frozen shape / toJSON / with() — see tests/unit-generic-harness.mjs
 *   - Per-family happy paths — see tests/unit-families.mjs
 *   - Real XRPL submission — see integration/
 *
 * Run: node tests/unit-error-contract.mjs
 */

import {
  ValidationError,
  PaymentFlags,
} from '../xrpjson.mjs';

import * as xrpjson from 'xrpjson';

const ACCOUNT_A = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const ACCOUNT_B = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';

const TF_PARTIAL_PAYMENT = 0x00020000;

// ─── Helpers ─────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}\n    ${e.message}`);
  }
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

/**
 * Assert the thunk throws a `ValidationError`. Reports the concrete constructor
 * name on failure, because "expected ValidationError, got TypeError" is the
 * exact distinction this file exists to make.
 */
function expectValidationError(fn, message) {
  let error;
  try { fn(); } catch (e) { error = e; }
  ok(error !== undefined, `${message} — no error thrown`);
  ok(
    error instanceof ValidationError,
    `${message} — expected ValidationError, got ${error?.constructor?.name}: ${error?.message}`,
  );
  return error;
}

/** Assert the thunk throws nothing at all. */
function expectNoThrow(fn, message) {
  try {
    fn();
  } catch (e) {
    throw new Error(`${message} — unexpected ${e.constructor.name}: ${e.message}`);
  }
}

// Enumerate the factories, excluding non-function exports (errors, flags, types).
const factories = Object.entries(xrpjson)
  .filter(([, v]) => typeof v === 'function')
  .map(([name, fn]) => ({ name, fn }));

ok(factories.length === 79, `expected 79 factories, got ${factories.length}`);

// ══════════════════════════════════════════════════════════════════════
// 1. Regression guard — the two paths fixed in xrpjson v1.1.0
// ══════════════════════════════════════════════════════════════════════
console.log('\n[error-contract] v1.1.0 regression guard — TickSize + DeliverMin\n');

// AccountSet TickSize: xrpl.org requires 3..15, or 0 to disable.
console.log('[1a] AccountSet.TickSize');

test('TickSize: 16 throws ValidationError (was a bare Error in <=1.0.5)', () => {
  const e = expectValidationError(
    () => xrpjson.accountSet({ Account: ACCOUNT_A, TickSize: 16 }),
    'accountSet TickSize=16',
  );
  ok(
    e.message === 'AccountSet: TickSize must be 3-15 or 0',
    `unexpected message: ${e.message}`,
  );
});

test('TickSize: 2 throws ValidationError (lower boundary)', () => {
  const e = expectValidationError(
    () => xrpjson.accountSet({ Account: ACCOUNT_A, TickSize: 2 }),
    'accountSet TickSize=2',
  );
  ok(
    e.message === 'AccountSet: TickSize must be 3-15 or 0',
    `unexpected message: ${e.message}`,
  );
});

test('TickSize: -1 throws ValidationError', () => {
  expectValidationError(
    () => xrpjson.accountSet({ Account: ACCOUNT_A, TickSize: -1 }),
    'accountSet TickSize=-1',
  );
});

// The valid set is 0 (disable) and 3..15 inclusive. Guard against the 1.1.0
// fix accidentally tightening or loosening the bounds.
console.log('\n[1b] AccountSet.TickSize — valid values still construct\n');

for (const ticksize of [0, 3, 5, 15]) {
  test(`TickSize: ${ticksize} is accepted`, () => {
    expectNoThrow(
      () => xrpjson.accountSet({ Account: ACCOUNT_A, TickSize: ticksize }),
      `accountSet TickSize=${ticksize}`,
    );
  });
}

// Payment DeliverMin: xrpl.org requires tfPartialPayment whenever DeliverMin is set.
console.log('\n[1c] Payment.DeliverMin requires tfPartialPayment\n');

const partialPaymentBase = {
  Account: ACCOUNT_A,
  Destination: ACCOUNT_B,
  Amount: '1000000',
  SendMax: '1000000',
  DeliverMin: '1000000',
};

test('DeliverMin without any Flags throws ValidationError (was a bare Error in <=1.0.5)', () => {
  const e = expectValidationError(
    () => xrpjson.payment({ ...partialPaymentBase }),
    'payment DeliverMin with no Flags',
  );
  ok(
    e.message === 'Payment: DeliverMin requires tfPartialPayment flag',
    `unexpected message: ${e.message}`,
  );
});

test('DeliverMin with Flags=0 throws ValidationError', () => {
  const e = expectValidationError(
    () => xrpjson.payment({ ...partialPaymentBase, Flags: 0 }),
    'payment DeliverMin with Flags=0',
  );
  ok(
    e.message === 'Payment: DeliverMin requires tfPartialPayment flag',
    `unexpected message: ${e.message}`,
  );
});

test('DeliverMin with { tfPartialPayment: false } throws ValidationError', () => {
  expectValidationError(
    () => xrpjson.payment({ ...partialPaymentBase, Flags: { tfPartialPayment: false } }),
    'payment DeliverMin with tfPartialPayment:false',
  );
});

console.log('\n[1d] Payment.DeliverMin — valid flag forms still construct\n');

for (const [label, flags] of [
  ['numeric literal 0x00020000', TF_PARTIAL_PAYMENT],
  ['PaymentFlags.tfPartialPayment', PaymentFlags.tfPartialPayment],
  ['boolean map { tfPartialPayment: true }', { tfPartialPayment: true }],
]) {
  test(`DeliverMin with ${label} is accepted`, () => {
    expectNoThrow(
      () => xrpjson.payment({ ...partialPaymentBase, Flags: flags }),
      `payment DeliverMin with ${label}`,
    );
  });
}

test('PaymentFlags.tfPartialPayment is 0x00020000', () => {
  ok(
    PaymentFlags.tfPartialPayment === TF_PARTIAL_PAYMENT,
    `expected ${TF_PARTIAL_PAYMENT}, got ${PaymentFlags.tfPartialPayment}`,
  );
});

// ══════════════════════════════════════════════════════════════════════
// 2. Cross-cutting sweep — malformed input yields ValidationError
// ══════════════════════════════════════════════════════════════════════
// Every shape below is one a caller can realistically produce by mistake.
// The contract is: if the factory rejects the input, it rejects it with
// `ValidationError` (a user-input error), not a `TypeError` or bare `Error`
// (which a caller would report as a library bug).
console.log('\n[2] Cross-cutting sweep — all 79 factories × malformed input\n');

// Tier A — every factory has an `Account` requirement, so every factory must
// reject these outright.
const MUST_THROW = [
  ['{}', {}],
  ['bare string account', ACCOUNT_A],
  ['[]', []],
  ['123', 123],
  ['{ Account: null }', { Account: null }],
  ['{ Account: 123 }', { Account: 123 }],
];

for (const [label, arg] of MUST_THROW) {
  test(`all 79 factories: ${label} throws ValidationError`, () => {
    const offenders = [];
    for (const { name, fn } of factories) {
      let error;
      try { fn(arg); } catch (e) { error = e; }
      if (error === undefined) {
        offenders.push(`${name}: did not throw`);
      } else if (!(error instanceof ValidationError)) {
        offenders.push(`${name}: ${error.constructor.name}`);
      }
    }
    ok(
      offenders.length === 0,
      `${offenders.length} offender(s): ${offenders.slice(0, 6).join(', ')}`,
    );
  });
}

// Tier B — field-specific garbage. Not every factory has an `Amount` field
// (accountSet, didDelete, mptokenIssuanceCreate, setRegularKey do not), so
// passing a bogus one is legitimately ignored by those. The invariant here is
// only: *if* a factory rejects it, the rejection is a ValidationError.
const MAY_IGNORE = [
  ['{ Account, Amount: "not-a-number" }', { Account: ACCOUNT_A, Amount: 'not-a-number' }],
  ['{ Account, Fee: {} }', { Account: ACCOUNT_A, Fee: {} }],
  ['{ Account, Sequence: "abc" }', { Account: ACCOUNT_A, Sequence: 'abc' }],
  ['{ Account, Flags: "nope" }', { Account: ACCOUNT_A, Flags: 'nope' }],
];

for (const [label, arg] of MAY_IGNORE) {
  test(`all 79 factories: ${label} — any rejection is a ValidationError`, () => {
    const offenders = [];
    for (const { name, fn } of factories) {
      let error;
      try { fn(arg); } catch (e) { error = e; }
      if (error !== undefined && !(error instanceof ValidationError)) {
        offenders.push(`${name}: ${error.constructor.name}: ${error.message}`);
      }
    }
    ok(
      offenders.length === 0,
      `${offenders.length} non-ValidationError rejection(s): ${offenders.slice(0, 6).join(' | ')}`,
    );
  });
}

// ══════════════════════════════════════════════════════════════════════
// 3. Known gap — null / no-arg still throw TypeError
// ══════════════════════════════════════════════════════════════════════
// Same class of defect the 1.1.0 fix addressed, still open upstream: every
// factory dereferences `props.Account` before validating that `props` is an
// object, so `factory()` and `factory(null)` throw a raw TypeError. Tracked
// as an open finding in DIVERGENCES.md.
//
// These are CHARACTERIZATION tests — they pin today's (wrong) behavior on
// purpose. When xrpjson fixes it, this test fails, and we flip it to
// expectValidationError and close the DIVERGENCES entry.
console.log('\n[3] Known gap (characterization) — null / no-arg throw TypeError\n');

for (const [label, arg] of [
  ['no argument', undefined],
  ['null', null],
]) {
  test(`all 79 factories: ${label} throws TypeError (known gap, not ValidationError yet)`, () => {
    const offenders = [];
    for (const { name, fn } of factories) {
      let error;
      try { fn(arg); } catch (e) { error = e; }
      if (error === undefined) {
        offenders.push(`${name}: did not throw`);
      } else if (error instanceof ValidationError) {
        offenders.push(`${name}: already ValidationError — update this test and DIVERGENCES.md`);
      } else if (!(error instanceof TypeError)) {
        offenders.push(`${name}: ${error.constructor.name}`);
      }
    }
    ok(
      offenders.length === 0,
      `${offenders.length} unexpected result(s): ${offenders.slice(0, 6).join(', ')}`,
    );
  });
}

// ══════════════════════════════════════════════════════════════════════
// 4. Error shape
// ══════════════════════════════════════════════════════════════════════
console.log('\n[4] ValidationError shape\n');

test('ValidationError carries name === "ValidationError"', () => {
  const e = expectValidationError(
    () => xrpjson.accountSet({ Account: ACCOUNT_A, TickSize: 16 }),
    'accountSet TickSize=16',
  );
  ok(e.name === 'ValidationError', `name was ${JSON.stringify(e.name)}`);
});

test('ValidationError is an instanceof Error (catch blocks still work)', () => {
  const e = expectValidationError(
    () => xrpjson.accountSet({ Account: ACCOUNT_A, TickSize: 16 }),
    'accountSet TickSize=16',
  );
  ok(e instanceof Error, 'not an instanceof Error');
});

test('ValidationError has a stack trace', () => {
  const e = expectValidationError(
    () => xrpjson.accountSet({ Account: ACCOUNT_A, TickSize: 16 }),
    'accountSet TickSize=16',
  );
  ok(typeof e.stack === 'string' && e.stack.length > 0, 'missing stack');
});

test('ValidationError exported from the shim matches xrpjson/errors', async () => {
  // The shim re-exports ValidationError from the `xrpjson/errors` subpath.
  // If those two ever diverge, instanceof checks against the root import
  // silently start returning false — the exact failure mode this file guards.
  const direct = await import('xrpjson/errors');
  ok(
    ValidationError === direct.ValidationError,
    'shim ValidationError !== xrpjson/errors ValidationError',
  );
});

// ─── Summary ────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(45)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log('\nFirst 10 failures:');
  for (const f of failures.slice(0, 10)) {
    console.log(`  ✗ ${f.name}: ${f.error}`);
  }
  process.exit(1);
}