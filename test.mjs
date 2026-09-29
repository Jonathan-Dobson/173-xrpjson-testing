import {
  accountSet,
  ammCreate,
  escrowCreate,
  nftokenMint,
  offerCreate,
  payment,
  trustSet,
  ValidationError,
  PaymentFlags,
  AccountSetAsfFlags,
  TrustSetFlags,
} from './xrpjson.mjs';

const ACCOUNT_A = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const ACCOUNT_B = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertThrows(fn, message) {
  let error;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  assert(error instanceof ValidationError, message || 'Expected ValidationError');
}

function validPayment(overrides = {}) {
  return payment({
    Account: ACCOUNT_A,
    Destination: ACCOUNT_B,
    Amount: '1000000',
    ...overrides,
  });
}

const VALID_RIPPLE_TIME = 946684800 + 3600;

// ─── 1. Payment factory ──────────────────────────────────────────────────────
console.log('\n[1] Payment factory');

test('creates a payment with the expected transaction shape', () => {
  const tx = validPayment();
  assert(tx.TransactionType === 'Payment');
  assert(tx.Amount === '1000000');
  assert(tx.Destination === ACCOUNT_B);
});

test('validates required fields at construction time', () => {
  assertThrows(
    () => payment({ Account: ACCOUNT_A, Destination: ACCOUNT_B }),
    'Expected missing Amount to throw ValidationError',
  );
});

test('toJSON() returns the canonical wire shape', () => {
  const json = validPayment().toJSON();
  assert(json.TransactionType === 'Payment');
  assert(json.Account === ACCOUNT_A);
  assert(json.Amount === '1000000');
});

test('toJSON() excludes unset optional fields', () => {
  const json = validPayment().toJSON();
  assert(!('Fee' in json), 'Fee should not appear when unset');
  assert(!('Sequence' in json), 'Sequence should not appear when unset');
});

test('supports issued-currency amounts', () => {
  const json = validPayment({
    Amount: { currency: 'USD', issuer: ACCOUNT_B, value: '10' },
  }).toJSON();
  assert(json.Amount.currency === 'USD');
  assert(json.Amount.issuer === ACCOUNT_B);
});

test('returns an immutable transaction', () => {
  const tx = validPayment();
  assert(Object.isFrozen(tx), 'Transaction should be frozen');
  assert(!Object.isFrozen(tx.toJSON()), 'toJSON() should return a plain wire object');
});

// ─── 2. Immutable with() ─────────────────────────────────────────────────────
console.log('\n[2] Immutable with()');

test('with() creates a new validated transaction', () => {
  const original = validPayment();
  const updated = original.with({ Fee: '12', Sequence: 42 });
  assert(updated !== original);
  assert(updated.Fee === '12');
  assert(updated.Sequence === 42);
  assert(original.Fee === undefined, 'Original should be unchanged');
});

test('with() preserves original fields and transaction type', () => {
  const updated = validPayment().with({ Fee: '12' });
  assert(updated.Amount === '1000000');
  assert(updated.Destination === ACCOUNT_B);
  assert(updated.TransactionType === 'Payment');
});

test('with() revalidates overrides', () => {
  assertThrows(
    () => validPayment().with({ Amount: undefined }),
    'Expected invalid override to throw ValidationError',
  );
});

test('supports chained with() calls', () => {
  const tx = validPayment()
    .with({ Fee: '12' })
    .with({ Sequence: 1 })
    .with({ LastLedgerSequence: 1000 });
  assert(tx.Fee === '12');
  assert(tx.Sequence === 1);
  assert(tx.LastLedgerSequence === 1000);
});

// ─── 3. Flags ─────────────────────────────────────────────────────────────────
console.log('\n[3] Flags');

test('accepts numeric payment flags', () => {
  const tx = validPayment({ Flags: PaymentFlags.tfPartialPayment });
  assert(tx.Flags === PaymentFlags.tfPartialPayment);
});

test('accepts the boolean-map flag form', () => {
  const tx = validPayment({ Flags: { tfPartialPayment: true } });
  assert(tx.toJSON().Flags.tfPartialPayment === true);
});

test('accepts account-set flags', () => {
  const tx = accountSet({
    Account: ACCOUNT_A,
    SetFlag: AccountSetAsfFlags.asfRequireDest,
  });
  assert(tx.TransactionType === 'AccountSet');
});

test('accepts trust-set flags', () => {
  const tx = trustSet({
    Account: ACCOUNT_A,
    LimitAmount: { currency: 'USD', issuer: ACCOUNT_B, value: '1000' },
    Flags: TrustSetFlags.tfSetNoRipple,
  });
  assert(tx.TransactionType === 'TrustSet');
});

// ─── 4. Representative factories ────────────────────────────────────────────
console.log('\n[4] Representative factories');

test('creates and serializes AccountSet', () => {
  const json = accountSet({
    Account: ACCOUNT_A,
    Domain: '6578616d706c652e636f6d',
    SetFlag: AccountSetAsfFlags.asfRequireDest,
  }).toJSON();
  assert(json.TransactionType === 'AccountSet');
  assert(json.Domain === '6578616d706c652e636f6d');
});

test('creates and serializes TrustSet', () => {
  const json = trustSet({
    Account: ACCOUNT_A,
    LimitAmount: { currency: 'USD', issuer: ACCOUNT_B, value: '1000' },
  }).toJSON();
  assert(json.TransactionType === 'TrustSet');
  assert(json.LimitAmount.currency === 'USD');
});

test('creates and serializes EscrowCreate', () => {
  const json = escrowCreate({
    Account: ACCOUNT_A,
    Destination: ACCOUNT_B,
    Amount: '5000000',
    FinishAfter: VALID_RIPPLE_TIME,
  }).toJSON();
  assert(json.TransactionType === 'EscrowCreate');
  assert(json.FinishAfter === VALID_RIPPLE_TIME);
});

test('creates and serializes NFTokenMint', () => {
  const json = nftokenMint({
    Account: ACCOUNT_A,
    NFTokenTaxon: 1,
    TransferFee: 5000,
    Flags: 8,
    URI: '68747470733a2f2f6578616d706c652e636f6d2f6e66742e6a736f6e',
  }).toJSON();
  assert(json.TransactionType === 'NFTokenMint');
  assert(json.TransferFee === 5000);
});

test('creates and serializes OfferCreate', () => {
  const json = offerCreate({
    Account: ACCOUNT_A,
    TakerPays: { currency: 'USD', issuer: ACCOUNT_B, value: '100' },
    TakerGets: '200000000',
  }).toJSON();
  assert(json.TransactionType === 'OfferCreate');
  assert(json.TakerPays.currency === 'USD');
});

test('creates and serializes AMMCreate', () => {
  const json = ammCreate({
    Account: ACCOUNT_A,
    Amount: '1000000',
    Amount2: { currency: 'USD', issuer: ACCOUNT_B, value: '500' },
    TradingFee: 500,
  }).toJSON();
  assert(json.TransactionType === 'AMMCreate');
  assert(json.TradingFee === 500);
});

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(45)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);