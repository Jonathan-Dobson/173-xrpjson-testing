/**
 * xrp-tx Integration Test Suite
 *
 * Connects to the XRPL Testnet, funds two wallets via the faucet,
 * builds transactions with xrp-tx, autofills + signs with xrpl.js,
 * submits them, and asserts tesSUCCESS for every case.
 *
 * Run: node integration.mjs
 */

import { Client, Wallet, dropsToXrp, xrpToDrops } from 'xrpl';
import {
  Transaction,
  PaymentTx,
  AccountSetTx,
  TrustSetTx,
  EscrowCreateTx,
  EscrowFinishTx,
  EscrowCancelTx,
  CheckCreateTx,
  CheckCashTx,
  CheckCancelTx,
  NFTokenMintTx,
  NFTokenBurnTx,
  NFTokenCreateOfferTx,
  NFTokenAcceptOfferTx,
  OfferCreateTx,
  OfferCancelTx,
  AccountSetAsfFlags,
} from 'xrp-tx';

// ─── Config ──────────────────────────────────────────────────────────────────
const TESTNET_WSS = 'wss://s.altnet.rippletest.net:51233';
const TIMEOUT_MS  = 90_000;   // per-test wall-clock budget

// ─── Helpers ─────────────────────────────────────────────────────────────────
let passed = 0, failed = 0, skipped = 0;

function log(symbol, name, detail = '') {
  const line = detail ? `  ${symbol} ${name}\n    ${detail}` : `  ${symbol} ${name}`;
  console.log(line);
}

async function runTest(name, fn) {
  try {
    await Promise.race([
      fn(),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error(`Timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS),
      ),
    ]);
    log('✓', name);
    passed++;
  } catch (e) {
    log('✗', name, e.message);
    failed++;
  }
}

function skip(name, reason) {
  log('○', name, `skipped — ${reason}`);
  skipped++;
}

/**
 * Autofill a transaction built by xrp-tx, sign it, and submit.
 * Returns the full response from submitAndWait().
 */
async function submitTx(client, txObj, wallet) {
  // xrp-tx toJSON() gives us a plain object compatible with xrpl.js
  const prepared = await client.autofill(txObj.toJSON());
  const { tx_blob } = wallet.sign(prepared);
  return client.submitAndWait(tx_blob);
}

function assertSuccess(response) {
  const result = response?.result?.meta?.TransactionResult;
  if (result !== 'tesSUCCESS') {
    throw new Error(`Expected tesSUCCESS, got: ${result}`);
  }
}

// ─── Setup ───────────────────────────────────────────────────────────────────
const client = new Client(TESTNET_WSS);

console.log('\nConnecting to XRPL Testnet …');
await client.connect();
console.log('Connected.\n');

console.log('Funding two test wallets via faucet (this takes ~10s) …');
const [{ wallet: alice }, { wallet: bob }] = await Promise.all([
  client.fundWallet(),
  client.fundWallet(),
]);
console.log(`  Alice : ${alice.classicAddress}`);
console.log(`  Bob   : ${bob.classicAddress}\n`);

// ─── Tests ───────────────────────────────────────────────────────────────────

// [1] Payment — XRP ───────────────────────────────────────────────────────────
console.log('[1] Payment (XRP)');

await runTest('send 10 XRP from Alice to Bob', async () => {
  const tx = new PaymentTx({
    Account:     alice.classicAddress,
    Destination: bob.classicAddress,
    Amount:      xrpToDrops('10'),
  });
  tx.validate();
  const res = await submitTx(client, tx, alice);
  assertSuccess(res);
});

await runTest('send 1 XRP with DestinationTag and Memo', async () => {
  const tx = new PaymentTx({
    Account:        alice.classicAddress,
    Destination:    bob.classicAddress,
    Amount:         xrpToDrops('1'),
    DestinationTag: 12345,
    Memos: [{
      Memo: {
        MemoData: Buffer.from('xrp-tx integration test').toString('hex').toUpperCase(),
        MemoType: Buffer.from('text/plain').toString('hex').toUpperCase(),
      },
    }],
  });
  tx.validate();
  const res = await submitTx(client, tx, alice);
  assertSuccess(res);
});

await runTest('payment with explicit Fee and LastLedgerSequence via .with()', async () => {
  // Exercise the immutable .with() pattern end-to-end on a live transaction
  const base = new PaymentTx({
    Account:     alice.classicAddress,
    Destination: bob.classicAddress,
    Amount:      xrpToDrops('1'),
  });
  const ledger = await client.request({ command: 'ledger_current' });
  const tx = base.with({
    Fee:                '15',
    LastLedgerSequence: ledger.result.ledger_current_index + 20,
  });
  // autofill only fills Sequence when Fee/LastLedgerSequence are already set
  const prepared = await client.autofill(tx.toJSON());
  const { tx_blob } = alice.sign(prepared);
  const res = await client.submitAndWait(tx_blob);
  assertSuccess(res);
});

// [2] AccountSet ──────────────────────────────────────────────────────────────
console.log('\n[2] AccountSet');

await runTest('set account Domain', async () => {
  const tx = new AccountSetTx({
    Account: alice.classicAddress,
    Domain:  Buffer.from('example.com').toString('hex').toUpperCase(),
  });
  tx.validate();
  const res = await submitTx(client, tx, alice);
  assertSuccess(res);
});

await runTest('enable RequireDest flag (asfRequireDest)', async () => {
  const tx = new AccountSetTx({
    Account: alice.classicAddress,
    SetFlag: AccountSetAsfFlags.asfRequireDest,
  });
  tx.validate();
  const res = await submitTx(client, tx, alice);
  assertSuccess(res);
});

await runTest('clear RequireDest flag (asfRequireDest)', async () => {
  const tx = new AccountSetTx({
    Account:  alice.classicAddress,
    ClearFlag: AccountSetAsfFlags.asfRequireDest,
  });
  tx.validate();
  const res = await submitTx(client, tx, alice);
  assertSuccess(res);
});

await runTest('set transfer rate and tick size', async () => {
  const tx = new AccountSetTx({
    Account:      bob.classicAddress,
    TransferRate: 1_005_000_000, // 0.5 % fee
    TickSize:     5,
  });
  tx.validate();
  const res = await submitTx(client, tx, bob);
  assertSuccess(res);
});

// [3] TrustSet ────────────────────────────────────────────────────────────────
console.log('\n[3] TrustSet');

await runTest('Alice creates a USD trust line to Bob', async () => {
  const tx = new TrustSetTx({
    Account: alice.classicAddress,
    LimitAmount: {
      currency: 'USD',
      issuer:   bob.classicAddress,
      value:    '10000',
    },
  });
  tx.validate();
  const res = await submitTx(client, tx, alice);
  assertSuccess(res);
});

// [4] Payment — IOU (requires trust line from step above) ────────────────────
console.log('\n[4] Payment (IOU)');

await runTest('Bob issues 100 USD to Alice', async () => {
  const tx = new PaymentTx({
    Account:     bob.classicAddress,
    Destination: alice.classicAddress,
    Amount: {
      currency: 'USD',
      issuer:   bob.classicAddress,
      value:    '100',
    },
  });
  tx.validate();
  const res = await submitTx(client, tx, bob);
  assertSuccess(res);
});

await runTest('Alice sends 10 USD back to Bob', async () => {
  const tx = new PaymentTx({
    Account:     alice.classicAddress,
    Destination: bob.classicAddress,
    Amount: {
      currency: 'USD',
      issuer:   bob.classicAddress,
      value:    '10',
    },
  });
  tx.validate();
  const res = await submitTx(client, tx, alice);
  assertSuccess(res);
});

await runTest('partial IOU payment with SendMax (tfPartialPayment)', async () => {
  // Cross-currency / IOU partial payments are allowed.
  // Alice requests up to 5 USD, paying up to 5 USD SendMax.
  const tx = new PaymentTx({
    Account:     alice.classicAddress,
    Destination: bob.classicAddress,
    Amount: {
      currency: 'USD',
      issuer:   bob.classicAddress,
      value:    '5',
    },
    SendMax: {
      currency: 'USD',
      issuer:   bob.classicAddress,
      value:    '5',
    },
    Flags: 0x00020000, // tfPartialPayment
  });
  tx.validate();
  const res = await submitTx(client, tx, alice);
  assertSuccess(res);
});

// [5] Offer ───────────────────────────────────────────────────────────────────
console.log('\n[5] OfferCreate / OfferCancel');

let offerSequence;

await runTest('create a DEX offer (XRP for USD)', async () => {
  const tx = new OfferCreateTx({
    Account:   alice.classicAddress,
    TakerPays: { currency: 'USD', issuer: bob.classicAddress, value: '10' },
    TakerGets: xrpToDrops('50'),
  });
  tx.validate();
  const res = await submitTx(client, tx, alice);
  assertSuccess(res);
  offerSequence = res.result.tx_json.Sequence;
});

await runTest('cancel the offer', async () => {
  if (!offerSequence) throw new Error('No offerSequence from prior test');
  const tx = new OfferCancelTx({
    Account:        alice.classicAddress,
    OfferSequence:  offerSequence,
  });
  tx.validate();
  const res = await submitTx(client, tx, alice);
  assertSuccess(res);
});

// [6] Escrow ──────────────────────────────────────────────────────────────────
console.log('\n[6] EscrowCreate / EscrowFinish / EscrowCancel');

// XRPL epoch = Unix epoch − 946684800
function xrplNow() { return Math.floor(Date.now() / 1000) - 946684800; }

// 6a — EscrowFinish: FinishAfter in the past by the time we submit
let escrowFinishSeq;

await runTest('create an escrow with FinishAfter +8s', async () => {
  const tx = new EscrowCreateTx({
    Account:     alice.classicAddress,
    Destination: bob.classicAddress,
    Amount:      xrpToDrops('3'),
    FinishAfter: xrplNow() + 8,
    CancelAfter: xrplNow() + 3600,
  });
  tx.validate();
  const res = await submitTx(client, tx, alice);
  assertSuccess(res);
  escrowFinishSeq = res.result.tx_json.Sequence;
});

await runTest('finish the escrow after FinishAfter has elapsed', async () => {
  if (!escrowFinishSeq) throw new Error('No escrowFinishSeq from prior test');
  console.log('    (waiting 15 s for FinishAfter to pass …)');
  await new Promise(r => setTimeout(r, 15_000));
  const tx = new EscrowFinishTx({
    Account:       alice.classicAddress,
    Owner:         alice.classicAddress,
    OfferSequence: escrowFinishSeq,
  });
  tx.validate();
  const res = await submitTx(client, tx, alice);
  assertSuccess(res);
});

// 6b — EscrowCancel: CancelAfter in the near future
// EscrowCreate requires Condition OR FinishAfter — pair CancelAfter with a
// far-future FinishAfter so the escrow is cancellable once CancelAfter passes.
let escrowCancelSeq;

await runTest('create an escrow with FinishAfter +5s, CancelAfter +10s', async () => {
  // CancelAfter must be strictly greater than FinishAfter per ledger rules.
  const now = xrplNow();
  const tx = new EscrowCreateTx({
    Account:     alice.classicAddress,
    Destination: bob.classicAddress,
    Amount:      xrpToDrops('2'),
    FinishAfter: now + 5,   // can finish after 5 s
    CancelAfter: now + 10,  // can cancel after 10 s (must be > FinishAfter)
  });
  tx.validate();
  const res = await submitTx(client, tx, alice);
  assertSuccess(res);
  escrowCancelSeq = res.result.tx_json.Sequence;
});

await runTest('cancel the escrow after CancelAfter has elapsed', async () => {
  if (!escrowCancelSeq) throw new Error('No escrowCancelSeq from prior test');
  console.log('    (waiting 15 s for CancelAfter to pass …)');
  await new Promise(r => setTimeout(r, 15_000));
  const tx = new EscrowCancelTx({
    Account:       alice.classicAddress,
    Owner:         alice.classicAddress,
    OfferSequence: escrowCancelSeq,
  });
  tx.validate();
  const res = await submitTx(client, tx, alice);
  assertSuccess(res);
});

// [7] Check ───────────────────────────────────────────────────────────────────
console.log('\n[7] CheckCreate / CheckCash / CheckCancel');

let checkId;

await runTest('Alice creates a check for 20 XRP payable to Bob', async () => {
  const tx = new CheckCreateTx({
    Account:     alice.classicAddress,
    Destination: bob.classicAddress,
    SendMax:     xrpToDrops('20'),
  });
  tx.validate();
  const res = await submitTx(client, tx, alice);
  assertSuccess(res);
  // Extract the CheckID from the created ledger object
  const node = res.result.meta.AffectedNodes
    .find(n => n.CreatedNode?.LedgerEntryType === 'Check');
  checkId = node?.CreatedNode?.NewFields?.CheckID ?? node?.CreatedNode?.LedgerIndex;
});

await runTest('Bob cashes the check for 15 XRP', async () => {
  if (!checkId) throw new Error('No checkId from prior test');
  const tx = new CheckCashTx({
    Account: bob.classicAddress,
    CheckID: checkId,
    Amount:  xrpToDrops('15'),
  });
  tx.validate();
  const res = await submitTx(client, tx, bob);
  assertSuccess(res);
});

await runTest('Alice creates and then cancels a check', async () => {
  const createTx = new CheckCreateTx({
    Account:     alice.classicAddress,
    Destination: bob.classicAddress,
    SendMax:     xrpToDrops('5'),
  });
  createTx.validate();
  const createRes = await submitTx(client, createTx, alice);
  assertSuccess(createRes);

  const node = createRes.result.meta.AffectedNodes
    .find(n => n.CreatedNode?.LedgerEntryType === 'Check');
  const cid = node?.CreatedNode?.NewFields?.CheckID ?? node?.CreatedNode?.LedgerIndex;
  if (!cid) throw new Error('Could not extract CheckID');

  const cancelTx = new CheckCancelTx({
    Account:  alice.classicAddress,
    CheckID:  cid,
  });
  cancelTx.validate();
  const cancelRes = await submitTx(client, cancelTx, alice);
  assertSuccess(cancelRes);
});

// [8] NFT ─────────────────────────────────────────────────────────────────────
console.log('\n[8] NFTokenMint / NFTokenCreateOffer / NFTokenAcceptOffer / NFTokenBurn');

let nftokenId;
let nftOfferIndex;

await runTest('Alice mints an NFT (taxon=1, transferable)', async () => {
  const tx = new NFTokenMintTx({
    Account:       alice.classicAddress,
    NFTokenTaxon:  1,
    Flags:         8,   // tfTransferable
    URI:           Buffer.from('https://example.com/nft/1').toString('hex').toUpperCase(),
  });
  tx.validate();
  const res = await submitTx(client, tx, alice);
  assertSuccess(res);
  // Extract the minted token ID
  const node = res.result.meta.AffectedNodes
    .find(n => n.ModifiedNode?.LedgerEntryType === 'NFTokenPage'
            || n.CreatedNode?.LedgerEntryType  === 'NFTokenPage');
  const page = node?.ModifiedNode?.FinalFields ?? node?.CreatedNode?.NewFields;
  nftokenId  = page?.NFTokens?.at(-1)?.NFToken?.NFTokenID;
});

await runTest('Alice creates a sell offer for her NFT', async () => {
  if (!nftokenId) throw new Error('No nftokenId from prior test');
  const tx = new NFTokenCreateOfferTx({
    Account:    alice.classicAddress,
    NFTokenID:  nftokenId,
    Amount:     xrpToDrops('1'),
    Flags:      1, // tfSellNFToken
  });
  tx.validate();
  const res = await submitTx(client, tx, alice);
  assertSuccess(res);
  const node = res.result.meta.AffectedNodes
    .find(n => n.CreatedNode?.LedgerEntryType === 'NFTokenOffer');
  nftOfferIndex = node?.CreatedNode?.LedgerIndex;
});

await runTest('Bob accepts the sell offer', async () => {
  if (!nftOfferIndex) throw new Error('No nftOfferIndex from prior test');
  const tx = new NFTokenAcceptOfferTx({
    Account:          bob.classicAddress,
    NFTokenSellOffer: nftOfferIndex,
  });
  tx.validate();
  const res = await submitTx(client, tx, bob);
  assertSuccess(res);
});

await runTest('Bob burns the NFT he received', async () => {
  if (!nftokenId) throw new Error('No nftokenId from prior test');
  const tx = new NFTokenBurnTx({
    Account:   bob.classicAddress,
    NFTokenID: nftokenId,
  });
  tx.validate();
  const res = await submitTx(client, tx, bob);
  assertSuccess(res);
});

// ─── Cleanup & Summary ────────────────────────────────────────────────────────
await client.disconnect();

console.log(`\n${'─'.repeat(50)}`);
const total = passed + failed + skipped;
console.log(`Results: ${passed}/${total} passed  |  ${failed} failed  |  ${skipped} skipped`);
if (failed > 0) {
  console.log('\nSome tests failed — see ✗ lines above for details.');
  process.exit(1);
} else {
  console.log('\nAll integration tests passed against XRPL Testnet.');
}
