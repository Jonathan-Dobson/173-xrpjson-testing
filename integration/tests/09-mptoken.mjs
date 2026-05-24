/**
 * MPToken (XLS-33) lifecycle test suite.
 *
 * Full flow:
 *   Create issuance → Alice opts in → Issue tokens (×2) →
 *   Lock issuance → Unlock issuance →
 *   Alice returns tokens → Alice opts out → Destroy issuance
 *
 * Key gotcha: the 48-char UInt192 `mpt_issuance_id` used in subsequent
 * transactions is NOT the 64-char LedgerIndex of the MPTokenIssuance object.
 * It must be fetched from account_objects after creation.
 */

import { MPTokenIssuanceCreateFlags, MPTokenIssuanceSetFlags } from 'xrpl';
import {
  MPTokenIssuanceCreateTx,
  MPTokenIssuanceSetTx,
  MPTokenIssuanceDestroyTx,
  MPTokenAuthorizeTx,
  PaymentTx,
} from 'xrplt';
import { createRunner, assertSuccess, submitTx } from '../helpers.mjs';

const tfMPTUnauthorize = 1; // MPTokenAuthorize — not exported by xrpl.js

/**
 * Fetch the 48-char UInt192 mpt_issuance_id for the most-recently-created
 * MPTokenIssuance owned by `account`.
 */
async function fetchIssuanceID(client, account) {
  const res = await client.request({
    command: 'account_objects',
    account,
    type: 'mpt_issuance',
  });
  // Most recently created issuance is last in the list
  const issuance = res.result.account_objects.at(-1);
  return issuance?.mpt_issuance_id ?? null;
}

export async function run(client, alice, bob) {
  const { runTest, summary } = createRunner();
  console.log('[9] MPToken — IssuanceCreate / Authorize / Payment / IssuanceSet / IssuanceDestroy');

  let issuanceID;

  // ── 1. Create issuance ───────────────────────────────────────────────────
  await runTest('Bob creates an MPT issuance (AssetScale=2, transferable)', async () => {
    // Metadata must be valid JSON per XLS-89; use compact keys to stay tidy
    // XLS-89 compliant metadata (compact keys)
    const metadata = Buffer.from(JSON.stringify({
      n:  'Test Token',
      t:  'TST',
      in: 'Test Issuer',
      ac: 'other',
      i:  'https://example.com/tst.png',
    })).toString('hex').toUpperCase();

    const tx = new MPTokenIssuanceCreateTx({
      Account:         bob.classicAddress,
      AssetScale:      2,
      MaximumAmount:   '100000000',
      TransferFee:     0,
      MPTokenMetadata: metadata,
      // tfMPTCanLock (2) is required to lock/unlock later; tfMPTCanTransfer (32) allows holder transfers
      Flags:           MPTokenIssuanceCreateFlags.tfMPTCanLock | MPTokenIssuanceCreateFlags.tfMPTCanTransfer,
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, bob));

    issuanceID = await fetchIssuanceID(client, bob.classicAddress);
    if (!issuanceID) throw new Error('Could not fetch mpt_issuance_id from account_objects');
    console.log(`    mpt_issuance_id: ${issuanceID}`);
  });

  // ── 2. Alice opts in ─────────────────────────────────────────────────────
  await runTest('Alice opts in (MPTokenAuthorize without Holder)', async () => {
    if (!issuanceID) throw new Error('No issuanceID from prior test');
    const tx = new MPTokenAuthorizeTx({
      Account:           alice.classicAddress,
      MPTokenIssuanceID: issuanceID,
      // No Holder field = Alice is authorising herself as a token holder
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, alice));
  });

  // ── 3. Bob issues tokens to Alice ────────────────────────────────────────
  await runTest('Bob pays 500 MPT to Alice', async () => {
    if (!issuanceID) throw new Error('No issuanceID from prior test');
    const tx = new PaymentTx({
      Account:     bob.classicAddress,
      Destination: alice.classicAddress,
      Amount:      { mpt_issuance_id: issuanceID, value: '500' },
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, bob));
  });

  await runTest('Bob pays 250 more MPT to Alice', async () => {
    if (!issuanceID) throw new Error('No issuanceID from prior test');
    const tx = new PaymentTx({
      Account:     bob.classicAddress,
      Destination: alice.classicAddress,
      Amount:      { mpt_issuance_id: issuanceID, value: '250' },
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, bob));
  });

  // ── 4. Lock the issuance ─────────────────────────────────────────────────
  await runTest('Bob locks the issuance (tfMPTLock)', async () => {
    if (!issuanceID) throw new Error('No issuanceID from prior test');
    const tx = new MPTokenIssuanceSetTx({
      Account:           bob.classicAddress,
      MPTokenIssuanceID: issuanceID,
      Flags:             MPTokenIssuanceSetFlags.tfMPTLock,
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, bob));
  });

  // ── 5. Unlock the issuance ───────────────────────────────────────────────
  await runTest('Bob unlocks the issuance (tfMPTUnlock)', async () => {
    if (!issuanceID) throw new Error('No issuanceID from prior test');
    const tx = new MPTokenIssuanceSetTx({
      Account:           bob.classicAddress,
      MPTokenIssuanceID: issuanceID,
      Flags:             MPTokenIssuanceSetFlags.tfMPTUnlock,
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, bob));
  });

  // ── 6. Alice returns all tokens to Bob ───────────────────────────────────
  await runTest('Alice returns all 750 MPT to Bob (zeroes her balance)', async () => {
    if (!issuanceID) throw new Error('No issuanceID from prior test');
    const tx = new PaymentTx({
      Account:     alice.classicAddress,
      Destination: bob.classicAddress,
      Amount:      { mpt_issuance_id: issuanceID, value: '750' },
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, alice));
  });

  // ── 7. Alice opts out ────────────────────────────────────────────────────
  await runTest('Alice opts out (MPTokenAuthorize with tfMPTUnauthorize)', async () => {
    if (!issuanceID) throw new Error('No issuanceID from prior test');
    const tx = new MPTokenAuthorizeTx({
      Account:           alice.classicAddress,
      MPTokenIssuanceID: issuanceID,
      Flags:             tfMPTUnauthorize,
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, alice));
  });

  // ── 8. Destroy the issuance ──────────────────────────────────────────────
  await runTest('Bob destroys the issuance (outstanding supply = 0)', async () => {
    if (!issuanceID) throw new Error('No issuanceID from prior test');
    const tx = new MPTokenIssuanceDestroyTx({
      Account:           bob.classicAddress,
      MPTokenIssuanceID: issuanceID,
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, bob));
  });

  return summary();
}

// ── Standalone execution ──────────────────────────────────────────────────────
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { withStandaloneSetup } = await import('../setup.mjs');
  await withStandaloneSetup(run);
}
