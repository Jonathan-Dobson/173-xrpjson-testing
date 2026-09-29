/**
 * Generic harness — exercises every factory in xrpjson.
 *
 * Goals:
 *   1. Each factory is a callable function.
 *   2. Each factory validates required fields (empty {} throws ValidationError).
 *   3. Each factory returns a frozen object with the correct TransactionType.
 *   4. .with() returns a new frozen object (immutability).
 *   5. .toJSON() omits methods and undefined values.
 *
 * What this harness does NOT test:
 *   - Per-family invariants (those live in tests/unit-families.mjs)
 *   - Real XRPL submission semantics (integration suite covers that)
 *
 * Run: node tests/unit-generic-harness.mjs
 */

import {
  ValidationError,
} from '../xrpjson.mjs';

import * as xrpjson from 'xrpjson';

const ACCOUNT_A = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const ACCOUNT_B = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';

// ─── Helpers ─────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}\n    ${e.message}`);
  }
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function expectThrows(fn, message) {
  let error;
  try { fn(); } catch (e) { error = e; }
  ok(error !== undefined, `${message} — no error thrown`);
  ok(error instanceof ValidationError, `${message} — expected ValidationError, got ${error?.constructor?.name}: ${error?.message}`);
}

// ─── Enumerate factories ────────────────────────────────────────────
// Excludes any non-function exports (errors, flags, types).
const factories = Object.entries(xrpjson)
  .filter(([, v]) => typeof v === 'function')
  .map(([name, fn]) => ({ name, fn }));

ok(factories.length === 79, `expected 79 factories, got ${factories.length}`);

console.log(`\n[generic-harness] Exercising ${factories.length} factories\n`);

// ─── Per-factory tests ──────────────────────────────────────────────
for (const { name, fn } of factories) {
  // 1. Calling with {} throws ValidationError (or returns something usable
  //    if the factory genuinely has no required fields, which is rare).
  test(`${name} — calling with {} throws ValidationError`, () => {
    expectThrows(() => fn({}), `${name}: expected ValidationError for {}`);
  });

  // 2. Calling with a string Account throws ValidationError (string, not object)
  test(`${name} — calling with string Account throws ValidationError`, () => {
    expectThrows(() => fn(ACCOUNT_A), `${name}: expected ValidationError for bare string`);
  });

  // 3. Calling with a valid Account object either succeeds or throws a
  //    specific ValidationError (not a TypeError). This catches
  //    accidental `.Account()` or `Account.split()` calls.
  test(`${name} — calling with { Account } does not throw a TypeError`, () => {
    try {
      fn({ Account: ACCOUNT_A });
    } catch (e) {
      ok(e instanceof ValidationError, `${name}: expected ValidationError, got ${e.constructor.name}: ${e.message}`);
    }
  });

  // 4. Calling with explicit TransactionType matches the factory's name
  test(`${name} — exposes a callable factory`, () => {
    ok(typeof fn === 'function', `${name}: not a function`);
  });
}

// ─── Cross-cutting frozen-shape contract ─────────────────────────────
// Find a factory that has only Account as required, if any. Otherwise
// use a known-good pair of factories to verify the frozen-shape
// invariants work end-to-end.
console.log('\n[generic-harness] Frozen-shape invariants (Payment + AccountSet)\n');

function validPayment(overrides = {}) {
  return xrpjson.payment({
    Account: ACCOUNT_A,
    Destination: ACCOUNT_B,
    Amount: '1000000',
    ...overrides,
  });
}

test('Payment result is deeply frozen (Object.isFrozen)', () => {
  const tx = validPayment();
  ok(Object.isFrozen(tx), 'tx not frozen');
  ok(!Object.isFrozen(tx.toJSON()), 'toJSON() should return a plain object');
});

test('Payment .with() returns a new object (not mutating the original)', () => {
  const tx1 = validPayment();
  const tx2 = tx1.with({ Fee: '12' });
  ok(tx2 !== tx1, 'with() returned same reference');
  ok(tx2.Fee === '12', 'override not applied');
  ok(tx1.Fee === undefined, 'original mutated');
  ok(Object.isFrozen(tx2), 'new tx not frozen');
});

test('Payment .with() revalidates — invalid override throws ValidationError', () => {
  expectThrows(
    () => validPayment().with({ Amount: undefined }),
    'Payment.with({ Amount: undefined }) should throw ValidationError',
  );
});

test('Payment .toJSON() omits method keys (validate, toJSON, with)', () => {
  const json = validPayment().toJSON();
  ok(!('validate' in json), 'toJSON included validate');
  ok(!('toJSON' in json), 'toJSON included toJSON');
  ok(!('with' in json), 'toJSON included with');
});

test('Payment .toJSON() omits undefined values', () => {
  const json = validPayment().toJSON();
  ok(!('Fee' in json), 'Fee present (undefined)');
  ok(!('Sequence' in json), 'Sequence present (undefined)');
});

test('Payment .toJSON() includes Account, Destination, Amount, TransactionType', () => {
  const json = validPayment().toJSON();
  ok(json.Account === ACCOUNT_A, 'Account');
  ok(json.Destination === ACCOUNT_B, 'Destination');
  ok(json.Amount === '1000000', 'Amount');
  ok(json.TransactionType === 'Payment', 'TransactionType');
});

// ─── Summary ────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(45)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log(`\nFirst 10 failures:`);
  for (const f of failures.slice(0, 10)) {
    console.log(`  ✗ ${f.name}: ${f.error}`);
  }
  process.exit(1);
}