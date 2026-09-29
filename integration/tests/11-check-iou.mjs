/**
 * IOU Checks test suite — the deferred-payment equivalent of escrow for IOUs.
 *
 * XRPL native Escrow is XRP-only — EscrowCreate.Amount only accepts drops.
 * Checks fill that gap: they hold a claimable payment right on-ledger and
 * fully support IssuedCurrencyAmount values.
 *
 * Suite covers:
 *   1. Setup — trust lines + issuance (Bob issues USD to Alice)
 *   2. CheckCreate (IOU SendMax) + CheckCash exact amount
 *   3. CheckCreate + CheckCash with DeliverMin (partial cash)
 *   4. CheckCreate + CheckCancel by sender before expiry
 *   5. CheckCreate with Expiration → wait → CheckCancel by recipient
 *   6. Confirm EscrowCreate with IOU Amount is rejected (documents the limit)
 */

import { xrpToDrops } from 'xrpl';
import {
  AccountSetTx,
  TrustSetTx,
  PaymentTx,
  CheckCreateTx,
  CheckCashTx,
  CheckCancelTx,
  EscrowCreateTx,
  AccountSetAsfFlags,
} from '../../xrpjson.mjs';
import {
  createRunner,
  assertSuccess,
  submitTx,
  extractCreatedIndex,
  xrplNow,
} from '../helpers.mjs';

function ica(currency, issuer, value) {
  return { currency, issuer, value };
}

export async function run(client, alice, bob) {
  const { runTest, summary } = createRunner();
  console.log('[11] IOU Checks — deferred IOU payments (the escrow equivalent for IOUs)');

  let carol;

  // ── 1. Setup: trust lines + issuance ─────────────────────────────────────
  await runTest('Bob enables DefaultRipple (required for check cashing through Bob)', async () => {
    // When Carol cashes a USD check from Alice, the ledger routes:
    //   Alice burns USD (trust line to Bob) → Carol receives USD (trust line to Bob)
    // This path only works if Bob has DefaultRipple enabled.
    const tx = new AccountSetTx({
      Account: bob.classicAddress,
      SetFlag: AccountSetAsfFlags.asfDefaultRipple,
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, bob));
  });

  await runTest('Fund Carol and open USD trust lines (Alice + Carol → Bob)', async () => {
    ({ wallet: carol } = await client.fundWallet());

    for (const holder of [alice, carol]) {
      const tx = new TrustSetTx({
        Account:     holder.classicAddress,
        LimitAmount: ica('USD', bob.classicAddress, '50000'),
      });
      tx.validate();
      assertSuccess(await submitTx(client, tx, holder));
    }
  });

  await runTest('Bob issues 10 000 USD to Alice', async () => {
    const tx = new PaymentTx({
      Account:     bob.classicAddress,
      Destination: alice.classicAddress,
      Amount:      ica('USD', bob.classicAddress, '10000'),
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, bob));
  });

  // ── 2. CheckCreate + CheckCash exact ─────────────────────────────────────
  // Alice writes a check for up to 500 USD; Carol cashes it for exactly 500.
  let checkId;

  await runTest('Alice creates an IOU check: up to 500 USD payable to Carol', async () => {
    if (!carol) throw new Error('No carol from prior test');
    const tx = new CheckCreateTx({
      Account:     alice.classicAddress,
      Destination: carol.classicAddress,
      SendMax:     ica('USD', bob.classicAddress, '500'),
    });
    tx.validate();
    const res = await submitTx(client, tx, alice);
    assertSuccess(res);
    checkId = extractCreatedIndex(res, 'Check');
    if (!checkId) throw new Error('Could not extract CheckID');
    console.log(`    CheckID: ${checkId}`);
  });

  await runTest('Carol cashes the check for exactly 500 USD', async () => {
    if (!carol)   throw new Error('No carol from prior test');
    if (!checkId) throw new Error('No checkId from prior test');
    const tx = new CheckCashTx({
      Account: carol.classicAddress,
      CheckID: checkId,
      Amount:  ica('USD', bob.classicAddress, '500'),
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, carol));
  });

  // ── 3. CheckCreate + CheckCash with DeliverMin (partial) ─────────────────
  // Alice writes a check for up to 1 000 USD.
  // Carol cashes with DeliverMin=300 — she'll receive between 300 and 1 000.
  // Since Alice's balance covers the full amount the ledger delivers 1 000.
  let partialCheckId;

  await runTest('Alice creates a check for up to 1 000 USD', async () => {
    if (!carol) throw new Error('No carol from prior test');
    const tx = new CheckCreateTx({
      Account:     alice.classicAddress,
      Destination: carol.classicAddress,
      SendMax:     ica('USD', bob.classicAddress, '1000'),
    });
    tx.validate();
    const res = await submitTx(client, tx, alice);
    assertSuccess(res);
    partialCheckId = extractCreatedIndex(res, 'Check');
    if (!partialCheckId) throw new Error('Could not extract CheckID');
  });

  await runTest('Carol cashes with DeliverMin=300 USD (partial cash)', async () => {
    if (!carol)         throw new Error('No carol from prior test');
    if (!partialCheckId) throw new Error('No partialCheckId from prior test');
    // DeliverMin instead of Amount signals a partial cash: deliver at least
    // this much, up to the check's SendMax. The ledger delivers as much as
    // the sender's balance permits, minimum DeliverMin.
    const tx = new CheckCashTx({
      Account:    carol.classicAddress,
      CheckID:    partialCheckId,
      DeliverMin: ica('USD', bob.classicAddress, '300'),
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, carol));
  });

  // ── 4. CheckCreate + CheckCancel by sender ────────────────────────────────
  // Alice can cancel her own check at any time (before or after expiry).
  let cancelCheckId;

  await runTest('Alice creates a check for 200 USD', async () => {
    if (!carol) throw new Error('No carol from prior test');
    const tx = new CheckCreateTx({
      Account:     alice.classicAddress,
      Destination: carol.classicAddress,
      SendMax:     ica('USD', bob.classicAddress, '200'),
    });
    tx.validate();
    const res = await submitTx(client, tx, alice);
    assertSuccess(res);
    cancelCheckId = extractCreatedIndex(res, 'Check');
    if (!cancelCheckId) throw new Error('Could not extract CheckID');
  });

  await runTest('Alice cancels the check before Carol cashes it', async () => {
    if (!cancelCheckId) throw new Error('No cancelCheckId from prior test');
    const tx = new CheckCancelTx({
      Account: alice.classicAddress,
      CheckID: cancelCheckId,
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, alice));
  });

  // ── 5. Expiration rules ───────────────────────────────────────────────────
  // XRPL CheckCancel permissions:
  //   • Source (Alice)      — can cancel at ANY time
  //   • Destination (Carol) — can cancel at ANY time
  //   • Third party (Dave)  — can ONLY cancel after Expiration has passed
  //
  // This is different from Escrow, where only the creator can cancel before
  // the CancelAfter time. Checks are more flexible.

  let dave;

  await runTest('Fund Dave (3rd party) for cancellation tests', async () => {
    ({ wallet: dave } = await client.fundWallet());
  });

  let thirdPartyCheckId;

  await runTest('Alice creates a check with 300 s expiry (for 3rd-party cancel tests)', async () => {
    if (!carol) throw new Error('No carol from prior test');
    const tx = new CheckCreateTx({
      Account:     alice.classicAddress,
      Destination: carol.classicAddress,
      SendMax:     ica('USD', bob.classicAddress, '50'),
      Expiration:  xrplNow() + 300,
    });
    tx.validate();
    const res = await submitTx(client, tx, alice);
    assertSuccess(res);
    thirdPartyCheckId = extractCreatedIndex(res, 'Check');
    if (!thirdPartyCheckId) throw new Error('Could not extract CheckID');
  });

  await runTest('Dave (3rd party) cannot cancel before expiry (tecNO_PERMISSION)', async () => {
    if (!dave)             throw new Error('No dave from prior test');
    if (!thirdPartyCheckId) throw new Error('No thirdPartyCheckId from prior test');
    const tx = new CheckCancelTx({
      Account: dave.classicAddress,
      CheckID: thirdPartyCheckId,
    });
    const res = await submitTx(client, tx, dave);
    const result = res?.result?.meta?.TransactionResult;
    if (result === 'tesSUCCESS') {
      throw new Error('Expected 3rd party to be rejected before expiry, got tesSUCCESS');
    }
  });

  await runTest('Carol (destination) cancels the 300 s check early — always permitted', async () => {
    if (!carol)            throw new Error('No carol from prior test');
    if (!thirdPartyCheckId) throw new Error('No thirdPartyCheckId from prior test');
    // Source and destination can cancel at any time, regardless of Expiration.
    const tx = new CheckCancelTx({
      Account: carol.classicAddress,
      CheckID: thirdPartyCheckId,
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, carol));
  });

  let shortExpiryCheckId;

  await runTest('Alice creates a short-lived check expiring in 20 s', async () => {
    if (!carol) throw new Error('No carol from prior test');
    const tx = new CheckCreateTx({
      Account:     alice.classicAddress,
      Destination: carol.classicAddress,
      SendMax:     ica('USD', bob.classicAddress, '50'),
      Expiration:  xrplNow() + 20,
    });
    tx.validate();
    const res = await submitTx(client, tx, alice);
    assertSuccess(res);
    shortExpiryCheckId = extractCreatedIndex(res, 'Check');
    if (!shortExpiryCheckId) throw new Error('Could not extract CheckID');
  });

  await runTest('Dave (3rd party) cancels the check after it expires', async () => {
    if (!dave)             throw new Error('No dave from prior test');
    if (!shortExpiryCheckId) throw new Error('No shortExpiryCheckId from prior test');
    console.log('    (waiting 25 s for Expiration to pass …)');
    await new Promise(r => setTimeout(r, 25_000));
    const tx = new CheckCancelTx({
      Account: dave.classicAddress,
      CheckID: shortExpiryCheckId,
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, dave));
  });

  // ── 6. EscrowCreate with IOU Amount → rejected by ledger ─────────────────
  // Documents the hard ledger rule: Escrow is XRP-only.
  // The class API's validate() does not catch this (it doesn't know the ledger rule);
  // the rejection happens at submission time as a temBAD_AMOUNT / tem* error.
  await runTest('EscrowCreate with IOU Amount is rejected by the ledger (tem*)', async () => {
    if (!carol) throw new Error('No carol from prior test');
    const tx = new EscrowCreateTx({
      Account:     alice.classicAddress,
      Destination: carol.classicAddress,
      // @ts-ignore — intentionally wrong type to probe the ledger guard
      Amount:      ica('USD', bob.classicAddress, '100'),
      FinishAfter: xrplNow() + 30,
    });
    // validate() may or may not throw — either outcome is fine here
    try { tx.validate(); } catch (_) { /* library caught it early — pass */ }

    let rejected = false;
    try {
      const res = await submitTx(client, tx, alice);
      const result = res?.result?.meta?.TransactionResult ?? '';
      if (result.startsWith('tem') || result.startsWith('tef') || result.startsWith('tec')) {
        rejected = true;
      }
    } catch (e) {
      // submitAndWait throws on malformed transactions before ledger inclusion
      rejected = true;
    }

    if (!rejected) {
      throw new Error('Expected ledger to reject IOU amount for EscrowCreate, but it succeeded');
    }
  });

  return summary();
}

// ── Standalone execution ──────────────────────────────────────────────────────
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { withStandaloneSetup } = await import('../setup.mjs');
  await withStandaloneSetup(run);
}
