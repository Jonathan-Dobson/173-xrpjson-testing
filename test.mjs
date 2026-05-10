import {
  Transaction,
  PaymentTx,
  AccountSetTx,
  TrustSetTx,
  EscrowCreateTx,
  NFTokenMintTx,
  OfferCreateTx,
  AMMCreateTx,
  ValidationError,
  TransactionRegistry,
  PaymentFlags,
  AccountSetAsfFlags,
} from 'xrp-tx';

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

// ─── 1. PaymentTx ───────────────────────────────────────────────────────────
console.log('\n[1] PaymentTx');

test('create via concrete class', () => {
  const tx = new PaymentTx({ Account: ACCOUNT_A, Destination: ACCOUNT_B, Amount: '1000000' });
  assert(tx.TransactionType === 'Payment');
  assert(tx.Amount === '1000000');
  assert(tx.Destination === ACCOUNT_B);
});

test('create via Transaction factory', () => {
  const tx = Transaction.payment({ Account: ACCOUNT_A, Destination: ACCOUNT_B, Amount: '2000000' });
  assert(tx.TransactionType === 'Payment');
  assert(tx.Amount === '2000000');
});

test('validate() passes for valid payment', () => {
  const tx = new PaymentTx({ Account: ACCOUNT_A, Destination: ACCOUNT_B, Amount: '1000000' });
  tx.validate();
});

test('validate() throws for missing Amount', () => {
  const tx = new PaymentTx({ Account: ACCOUNT_A, Destination: ACCOUNT_B, Amount: undefined });
  let threw = false;
  try { tx.validate(); } catch (e) { threw = e instanceof ValidationError; }
  assert(threw, 'Expected ValidationError');
});

test('validate() does NOT catch Account === Destination (known gap)', () => {
  // The package does not validate this case — documenting actual behaviour
  const tx = new PaymentTx({ Account: ACCOUNT_A, Destination: ACCOUNT_A, Amount: '1000000' });
  let threw = false;
  try { tx.validate(); } catch (e) { threw = true; }
  assert(!threw, 'Package currently skips same-account check — gap confirmed');
});

test('toJSON() returns correct shape', () => {
  const tx = new PaymentTx({ Account: ACCOUNT_A, Destination: ACCOUNT_B, Amount: '1000000' });
  const json = tx.toJSON();
  assert(json.TransactionType === 'Payment');
  assert(json.Account === ACCOUNT_A);
  assert(json.Amount === '1000000');
});

test('toJSON() excludes undefined fields', () => {
  const tx = new PaymentTx({ Account: ACCOUNT_A, Destination: ACCOUNT_B, Amount: '1000000' });
  const json = tx.toJSON();
  assert(!('Fee' in json), 'Fee should not appear when unset');
  assert(!('Sequence' in json), 'Sequence should not appear when unset');
});

test('IOU amount (IssuedCurrencyAmount)', () => {
  const tx = new PaymentTx({
    Account: ACCOUNT_A,
    Destination: ACCOUNT_B,
    Amount: { currency: 'USD', issuer: ACCOUNT_B, value: '10' },
  });
  tx.validate();
  const json = tx.toJSON();
  assert(typeof json.Amount === 'object');
  assert(json.Amount.currency === 'USD');
});

// ─── 2. Immutable .with() ────────────────────────────────────────────────────
console.log('\n[2] Immutable .with()');

test('.with() creates a new instance with updated fields', () => {
  const tx1 = new PaymentTx({ Account: ACCOUNT_A, Destination: ACCOUNT_B, Amount: '1000000' });
  const tx2 = tx1.with({ Fee: '12', Sequence: 42 });
  assert(tx2.Fee === '12');
  assert(tx2.Sequence === 42);
  assert(tx1.Fee === undefined, 'Original should be unchanged');
  assert(tx1.Sequence === undefined, 'Original should be unchanged');
});

test('.with() preserves original fields', () => {
  const tx1 = new PaymentTx({ Account: ACCOUNT_A, Destination: ACCOUNT_B, Amount: '1000000' });
  const tx2 = tx1.with({ Fee: '12' });
  assert(tx2.Amount === '1000000');
  assert(tx2.Destination === ACCOUNT_B);
});

test('.with() returns same TransactionType', () => {
  const tx1 = new PaymentTx({ Account: ACCOUNT_A, Destination: ACCOUNT_B, Amount: '1000000' });
  const tx2 = tx1.with({ Fee: '12' });
  assert(tx2.TransactionType === 'Payment');
});

test('chained .with() calls', () => {
  const tx = new PaymentTx({ Account: ACCOUNT_A, Destination: ACCOUNT_B, Amount: '1000000' })
    .with({ Fee: '12' })
    .with({ Sequence: 1 })
    .with({ LastLedgerSequence: 1000 });
  assert(tx.Fee === '12');
  assert(tx.Sequence === 1);
  assert(tx.LastLedgerSequence === 1000);
});

// ─── 3. Flags ────────────────────────────────────────────────────────────────
console.log('\n[3] Flags');

test('PaymentFlags enum values are numbers', () => {
  assert(typeof PaymentFlags.tfNoRippleDirect === 'number');
  assert(typeof PaymentFlags.tfPartialPayment === 'number');
});

test('set numeric flags on payment', () => {
  const tx = new PaymentTx({
    Account: ACCOUNT_A,
    Destination: ACCOUNT_B,
    Amount: '1000000',
    Flags: PaymentFlags.tfPartialPayment,
  });
  assert(tx.Flags === PaymentFlags.tfPartialPayment);
});

// ─── 4. AccountSetTx ─────────────────────────────────────────────────────────
console.log('\n[4] AccountSetTx');

test('create AccountSet with Domain', () => {
  const tx = new AccountSetTx({
    Account: ACCOUNT_A,
    Domain: '6578616d706c652e636f6d', // hex
    SetFlag: AccountSetAsfFlags.asfRequireDest,
  });
  assert(tx.TransactionType === 'AccountSet');
  tx.validate();
});

// ─── 5. TrustSetTx ───────────────────────────────────────────────────────────
console.log('\n[5] TrustSetTx');

test('create TrustSet', () => {
  const tx = new TrustSetTx({
    Account: ACCOUNT_A,
    LimitAmount: { currency: 'USD', issuer: ACCOUNT_B, value: '1000' },
  });
  assert(tx.TransactionType === 'TrustSet');
  tx.validate();
});

// ─── 6. EscrowCreateTx ───────────────────────────────────────────────────────
console.log('\n[6] EscrowCreateTx');

test('create Escrow', () => {
  const tx = new EscrowCreateTx({
    Account: ACCOUNT_A,
    Destination: ACCOUNT_B,
    Amount: '5000000',
    FinishAfter: 800000000,
  });
  assert(tx.TransactionType === 'EscrowCreate');
  tx.validate();
});

test('Escrow toJSON includes FinishAfter', () => {
  const tx = new EscrowCreateTx({
    Account: ACCOUNT_A,
    Destination: ACCOUNT_B,
    Amount: '5000000',
    FinishAfter: 800000000,
  });
  assert(tx.toJSON().FinishAfter === 800000000);
});

// ─── 7. NFTokenMintTx ────────────────────────────────────────────────────────
console.log('\n[7] NFTokenMintTx');

test('mint NFT with taxon', () => {
  const tx = new NFTokenMintTx({
    Account: ACCOUNT_A,
    NFTokenTaxon: 0,
  });
  assert(tx.TransactionType === 'NFTokenMint');
  tx.validate();
});

test('mint NFT with URI and transfer fee', () => {
  const tx = new NFTokenMintTx({
    Account: ACCOUNT_A,
    NFTokenTaxon: 1,
    TransferFee: 5000,
    URI: '68747470733a2f2f6578616d706c652e636f6d2f6e66742e6a736f6e',
  });
  tx.validate();
  assert(tx.TransferFee === 5000);
});

// ─── 8. OfferCreateTx ────────────────────────────────────────────────────────
console.log('\n[8] OfferCreateTx');

test('create DEX offer (XRP for IOU)', () => {
  const tx = new OfferCreateTx({
    Account: ACCOUNT_A,
    TakerPays: { currency: 'USD', issuer: ACCOUNT_B, value: '100' },
    TakerGets: '200000000',
  });
  assert(tx.TransactionType === 'OfferCreate');
  tx.validate();
});

// ─── 9. TransactionRegistry ──────────────────────────────────────────────────
console.log('\n[9] TransactionRegistry');

test('TransactionRegistry.get() returns the correct constructor', () => {
  const Ctor = TransactionRegistry.get('Payment');
  assert(Ctor === PaymentTx, 'Expected PaymentTx constructor');
});

test('TransactionRegistry.has() returns true for known types', () => {
  assert(TransactionRegistry.has('Payment'));
  assert(TransactionRegistry.has('NFTokenMint'));
  assert(TransactionRegistry.has('AMMCreate'));
  assert(!TransactionRegistry.has('FakeTransaction'));
});

test('TransactionRegistry.types() lists all 71 transaction types', () => {
  const types = TransactionRegistry.types();
  assert(types.length >= 71, `Expected ≥71 types, got ${types.length}`);
  assert(types.includes('Payment'));
  assert(types.includes('EscrowCreate'));
});

test('Transaction.create() reconstructs a Payment from plain fields', () => {
  const tx = Transaction.create('Payment', {
    Account: ACCOUNT_A,
    Destination: ACCOUNT_B,
    Amount: '1000000',
  });
  assert(tx instanceof PaymentTx);
  assert(tx.TransactionType === 'Payment');
});

test('Transaction.create() round-trips through toJSON()', () => {
  const original = new PaymentTx({
    Account: ACCOUNT_A,
    Destination: ACCOUNT_B,
    Amount: '1000000',
    Fee: '12',
    Sequence: 7,
  });
  const json = original.toJSON();
  const reconstructed = Transaction.create(json.TransactionType, json);
  assert(reconstructed.toJSON().Fee === '12');
  assert(reconstructed.toJSON().Sequence === 7);
});

// ─── 10. AMMCreateTx ─────────────────────────────────────────────────────────
console.log('\n[10] AMMCreateTx');

test('create AMM pool', () => {
  const tx = new AMMCreateTx({
    Account: ACCOUNT_A,
    Amount: '1000000',
    Amount2: { currency: 'USD', issuer: ACCOUNT_B, value: '500' },
    TradingFee: 500,
  });
  assert(tx.TransactionType === 'AMMCreate');
  tx.validate();
});

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(45)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
