/**
 * Bug #5 — before/after demonstration.
 *
 * Two claims, shown rather than asserted:
 *   1. The gap is in the TYPE SURFACE, not the runtime. `buildFrozenTx`
 *      spreads the field set through, so a cast gets you a working object.
 *   2. The validator that would catch the bad values already exists and is
 *      correct — it simply has no callers. So the defect is "nobody calls
 *      the guard", not "the guard is missing".
 *
 * Run: node demo-bug5.mjs
 */
import { readFileSync } from 'fs';
import { ammDeposit, payment, ticketCreate } from '../../../xrpjson.mjs';
import { validateBaseTransaction } from 'xrpjson/validation';

const ACCOUNT = 'rGFBE8WA2ZKfqGGB7CFkLusVt7hsVT4r8H';

function show(label, fn) {
  try {
    const v = fn();
    console.log(`  ${label.padEnd(46)} → built   ${v}`);
  } catch (e) {
    console.log(`  ${label.padEnd(46)} → ${e.name}: ${e.message.slice(0, 52)}`);
  }
}

const VERSION = JSON.parse(
  readFileSync(new URL('../../../node_modules/xrpjson/package.json', import.meta.url), 'utf8'),
).version;
console.log(`xrpjson ${VERSION}\n`);

console.log('BEFORE — what the factories do today (xrpjson 1.2.0)\n');
console.log('  claim 1: TicketSequence is usable at runtime, just not typed');
const ticketed = payment({
  Account: ACCOUNT,
  Destination: 'rP9jPyP5kyvFRb6ZiRghAGw5u8SGAmU4bd',
  Amount: '1000',
  Sequence: 0,
  ...{ TicketSequence: 42 },   // ← not on PaymentProps
});
console.log(`  ${'payment(...).toJSON()'.padEnd(46)} → ${JSON.stringify(ticketed.toJSON().TicketSequence)}`);
console.log(`  ${'  and it survives .with()'.padEnd(46)} → ${JSON.stringify(ticketed.with({ Fee: '12' }).toJSON().TicketSequence)}\n`);

console.log('  claim 2: the seven missing fields accept garbage silently\n');
show('ammDeposit with Memos: "not-an-array"', () =>
  ammDeposit({
    Account: ACCOUNT, Asset: { currency: 'XRP' }, Asset2: { currency: 'XRP' },
    Amount: '1000', Flags: 0x00080000,
    ...{ Memos: 'not-an-array' },
  }).Memos);
show('ammDeposit with SourceTag: "NaN"', () =>
  ammDeposit({
    Account: ACCOUNT, Asset: { currency: 'XRP' }, Asset2: { currency: 'XRP' },
    Amount: '1000', Flags: 0x00080000,
    ...{ SourceTag: 'NaN' },
  }).SourceTag);
show('ammDeposit with NetworkID: {}', () =>
  ammDeposit({
    Account: ACCOUNT, Asset: { currency: 'XRP' }, Asset2: { currency: 'XRP' },
    Amount: '1000', Flags: 0x00080000,
    ...{ NetworkID: {} },
  }).NetworkID);
show('ammDeposit with Delegate == Account', () =>
  ammDeposit({
    Account: ACCOUNT, Asset: { currency: 'XRP' }, Asset2: { currency: 'XRP' },
    Amount: '1000', Flags: 0x00080000,
    ...{ Delegate: ACCOUNT },
  }).Delegate);
show('ammDeposit with TicketSequence: "nope"', () =>
  ammDeposit({
    Account: ACCOUNT, Asset: { currency: 'XRP' }, Asset2: { currency: 'XRP' },
    Amount: '1000', Flags: 0x00080000,
    ...{ TicketSequence: 'nope' },
  }).TicketSequence);

console.log('\nAFTER — the same objects, run through the validator that already ships\n');
const cases = [
  ['Memos: "not-an-array"', { Memos: 'not-an-array' }],
  ['SourceTag: "NaN"', { SourceTag: 'NaN' }],
  ['NetworkID: {}', { NetworkID: {} }],
  ['Delegate == Account', { Delegate: ACCOUNT }],
  ['TicketSequence: "nope"', { TicketSequence: 'nope' }],
];
for (const [label, extra] of cases) {
  show(label, () => {
    const tx = ammDeposit({
      Account: ACCOUNT, Asset: { currency: 'XRP' }, Asset2: { currency: 'XRP' },
      Amount: '1000', Flags: 0x00080000, ...extra,
    }).toJSON();
    validateBaseTransaction(tx);
    return '(no throw)';
  });
}

console.log('\n  and legitimate values still pass:');
show('Memos: [{ Memo: { MemoType, MemoData } }]  (hex, as isMemo requires)', () => {
  const tx = ammDeposit({
    Account: ACCOUNT, Asset: { currency: 'XRP' }, Asset2: { currency: 'XRP' },
    Amount: '1000', Flags: 0x00080000,
    Memos: [{ Memo: { MemoType: '746578742F706C61696E', MemoData: '6869' } }],
  }).toJSON();
  validateBaseTransaction(tx);
  return '(accepted)';
});

console.log('\nThe ticketed payment, validated:');
show('payment + TicketSequence: 42, Sequence: 0', () => {
  validateBaseTransaction(ticketed.toJSON());
  return '(accepted — the legitimate case still works)';
});
