/**
 * [16a] Multisign-only account — setup.
 *
 * Implements MS-1 … MS-9 in USER-STORIES.md § "[16] Multisign-only account".
 *
 * RUN THIS FIRST AND ALONE. It is the only part of [16] that performs
 * one-way, unrecoverable mutations: MS-5 spends the master key, after which no
 * authority exists except the signer quorum and there is no way back to a
 * paper-key-controlled account. 16b/16c/16d load the account this suite
 * creates and never rebuild it.
 *
 *   node integration/tests/16a-multisign-only-setup.mjs
 *
 * The interesting part is not the setup — it is MS-3, which proves the ledger
 * refuses to let the account lock itself out. Everything after it is safe
 * precisely because that refusal happens first.
 */

import { Wallet, xrpToDrops, multisign } from 'xrpl';
import {
  payment,
  accountSet,
  signerListSet,
  accountDelete,
} from '../../xrpjson.mjs';
import {
  createRunner,
  assertSuccess,
  submitTx,
  balanceDrops,
  ensureConnected,
  expectRejected,
  waitForAccountState,
  submitMultisigned as submitMultisignedHelper,
  assertNotExpired,
  readSignerList,
  accountFlags,
  waitFor,
} from '../helpers.mjs';
import { saveState, clearState } from '../multisign-only-state.mjs';
import { submitNoWait } from '../no-wait.mjs';

export async function run(client, alice, bob) {
  const { runTest, skip, summary } = createRunner();
  console.log('[16a] Multisign-only — setup (run this first and alone)');

  // A previous run's state would make every assertion below describe an
  // account that is already restricted, which is not what these stories say.
  clearState();

  // ── Wallets ────────────────────────────────────────────────────────
  // The account being restricted, three signers, and a recipient that
  // proves the multisigned payments actually moved funds.
  //
  // Funded SEQUENTIALLY with a pause. The faucet rate-limits, and
  // fundWallets()'s Promise.all is fine for two but trips the limit at five.
  const fund = async (label) => {
    const { wallet } = await client.fundWallet();
    console.log(`  ${label}: ${wallet.classicAddress}`);
    await new Promise((r) => setTimeout(r, 1200));
    return wallet;
  };

  const account   = await fund('Account  ');
  const signer1   = await fund('Signer 1 ');
  const signer2   = await fund('Signer 2 ');
  const signer3   = await fund('Signer 3 ');
  const recipient = await fund('Recipient');
  console.log('');

  // Saved for 16b/16c/16d. `master` is never set — see multisign-only-state.mjs.
  // The recipient's seed IS saved: it is an ordinary faucet wallet with a live
  // master key, and 16b needs it to act AS the recipient (issue an IOU, cash a
  // check addressed to it). Without it, those stories were signed by alice
  // while claiming to be the recipient — a signature mismatch, not a test.
  const state = {
    account: account.classicAddress,
    recipient: recipient.classicAddress,
    recipientSeed: recipient.seed,
    signers: [signer1, signer2, signer3].map((w) => ({
      address: w.classicAddress,
      seed: w.seed,
    })),
  };

  /**
   * Autofill, collect `count` signatures from the given signers, combine, and
   * submit. Thin wrapper over the shared helper so the LastLedgerSequence
   * window and the signature-count argument are set in one place.
   */
  async function submitMultisigned(txObj, wallets, count = wallets.length) {
    return submitMultisignedHelper(client, txObj.toJSON(), wallets, { count });
  }

  // ── MS-1 ───────────────────────────────────────────────────────────
  await runTest('MS-1: a fresh, funded account with no signer list and no lsfDisableMaster', async () => {
    const info = await client.request({
      command: 'account_info',
      account: account.classicAddress,
      ledger_index: 'validated',
    });
    const data = info.result.account_data;

    if (Number(data.Balance) <= 0) throw new Error('account is not funded');
    // Flags is capital-F. `data.flags` is undefined, and `undefined & mask` is
    // 0, so the original `data.flags & 0x00100000` check could never fire.
    if (accountFlags(data) & 0x00100000) throw new Error('lsfDisableMaster already set');
    if (await readSignerList(client, account.classicAddress)) {
      throw new Error('new account already has a signer list');
    }
  });

  // ── MS-2 ───────────────────────────────────────────────────────────
  // An ordinary, unrestricted transaction. Everything that follows is
  // attributed to the restriction rather than to setup.
  await runTest('MS-2: one ordinary master-signed payment', async () => {
    const tx = payment({
      Account:     account.classicAddress,
      Destination: recipient.classicAddress,
      Amount:      xrpToDrops('1'),
    });
    tx.validate();

    const before = await balanceDrops(client, recipient.classicAddress);
    assertSuccess(await submitTx(client, tx, account));
    const after = await balanceDrops(client, recipient.classicAddress);

    if (after !== before + BigInt(xrpToDrops('1'))) {
      throw new Error(`recipient got ${after - before} drops, expected ${xrpToDrops('1')}`);
    }
  });

  // ── MS-3 ───────────────────────────────────────────────────────────
  // THE story. Every later suite assumes the account cannot be locked out;
  // this is the one that demonstrates the ledger enforces it.
  //
  // Sent by the MASTER, so the sigWithMaster check at AccountSet.cpp:309-313
  // passes and we reach the alternative-authority check at :315-319. With
  // neither sfRegularKey nor a signer list present, the expected code is
  // tecNO_ALTERNATIVE_KEY — not tecNEED_MASTER_KEY, which is what a
  // multisigned attempt would produce.
  await runTest('MS-3: disabling the master with no alternative authority is refused', async () => {
    const tx = accountSet({
      Account: account.classicAddress,
      SetFlag: 4, // asfDisableMaster
    });
    tx.validate();

    const { ok, result } = await expectRejected(() => submitTx(client, tx, account));
    if (!ok) {
      throw new Error(
        'ledger ACCEPTED asfDisableMaster with no signer list and no regular key — ' +
        'the account could have been locked out permanently',
      );
    }
    console.log(`    (refused as expected: ${result})`);

    if (result !== 'tecNO_ALTERNATIVE_KEY') {
      throw new Error(
        `expected tecNO_ALTERNATIVE_KEY (AccountSet.cpp:315-319), got ${result}. ` +
        `This is a finding, not a flake — record it and re-check the source.`,
      );
    }
  });

  // ── MS-4 ───────────────────────────────────────────────────────────
  await runTest('MS-4: a signer list of 3, weight 1 each, quorum 2', async () => {
    const tx = signerListSet({
      Account:      account.classicAddress,
      SignerQuorum: 2,
      SignerEntries: [
        { SignerEntry: { Account: signer1.classicAddress, SignerWeight: 1 } },
        { SignerEntry: { Account: signer2.classicAddress, SignerWeight: 1 } },
        { SignerEntry: { Account: signer3.classicAddress, SignerWeight: 1 } },
      ],
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, account));

    // WAIT rather than read. submitAndWait returning does not mean the next
    // account_info observes the change. The first run of this suite read
    // immediately and reported "no signer list visible" — while the very next
    // story's multisigned payment succeeded, which is only possible if the
    // list was there all along. A read-too-early is a test defect that looks
    // exactly like a ledger failure.
    //
    // readSignerList() passes `signer_lists: true`, which is not optional —
    // without it rippled omits the field and the wait never resolves.
    const list = await waitFor(
      async () => readSignerList(client, account.classicAddress),
      { label: 'the signer list to become visible' },
    );

    if (list.SignerQuorum !== 2) {
      throw new Error(`quorum is ${list.SignerQuorum}, expected 2`);
    }
    if (list.SignerEntries?.length !== 3) {
      throw new Error(`${list.SignerEntries?.length} signers, expected 3`);
    }
  });

  // ── MS-5 ───────────────────────────────────────────────────────────
  // The one-way door. The master seed goes out of scope here and is never
  // written to disk.
  await runTest('MS-5: the master key is now disallowed, and only the quorum is left', async () => {
    const tx = accountSet({
      Account: account.classicAddress,
      SetFlag: 4, // asfDisableMaster
    });
    tx.validate();

    // Report the actual result rather than letting a wait swallow it.
    const res = await submitTx(client, tx, account);
    const code = res?.result?.meta?.TransactionResult;
    if (code !== 'tesSUCCESS') {
      throw new Error(`SetFlag 4 was refused: ${code}`);
    }

    const data = await waitForAccountState(
      client,
      account.classicAddress,
      (d) => (accountFlags(d) & 0x00100000) !== 0,
      { label: 'lsfDisableMaster to be set' },
    );

    // No regular key, and lsfDisableMaster required an alternative authority
    // (AccountSet.cpp:315-319) — so that authority can only be the signer
    // list, which MS-4 established. This is the state every later suite
    // depends on, so assert it rather than assume it.
    if (data.RegularKey) {
      throw new Error('a regular key is present — the configuration is not what [16] claims');
    }
    const list = await readSignerList(client, account.classicAddress);
    if (!list) throw new Error('no signer list, so the account would have no authority at all');
  });

  // ── MS-6 ───────────────────────────────────────────────────────────
  await runTest('MS-6: a two-of-three quorum-signed payment succeeds', async () => {
    const tx = payment({
      Account:     account.classicAddress,
      Destination: recipient.classicAddress,
      Amount:      xrpToDrops('1'),
    });
    tx.validate();

    const before = await balanceDrops(client, recipient.classicAddress);
    assertSuccess(await submitMultisigned(tx, [signer1, signer2], 2));
    const after = await balanceDrops(client, recipient.classicAddress);

    if (after !== before + BigInt(xrpToDrops('1'))) {
      throw new Error(`recipient got ${after - before} drops, expected ${xrpToDrops('1')}`);
    }
  });

  /**
   * Submit a transaction that is EXPECTED to be refused, and return the
   * synchronous `engine_result`.
   *
   * Deliberately does NOT use `submitAndWait`. Two reasons, both learned the
   * hard way on this suite:
   *
   *  - An **incomplete** multisignature is not refused — rippled *holds* it in
   *    the queue waiting for the remaining signature. `submitAndWait` then
   *    blocks for the whole LastLedgerSequence window and finally reports an
   *    expiry, which says nothing about authority.
   *  - autofill's default window is only ~20 ledgers. A test that stalls on a
   *    preceding 90s wait can have that window consumed by the time its own
   *    transaction is applied, and an expiry is again mistaken for a verdict.
   *
   * A wide window is safe here precisely because nothing is awaited: the
   * synchronous result comes back immediately.
   */
  async function submitExpectingRefusal(txObj, wallets, count) {
    const lc = await client.request({ command: 'ledger_current' });
    const prepared = await client.autofill(
      { ...txObj.toJSON(), LastLedgerSequence: lc.result.ledger_current_index + 200 },
      count,
    );

    let blob;
    if (wallets.length === 0) {
      // Single-signature (the master key) — sign directly.
      blob = account.sign(prepared).tx_blob;
    } else {
      const partials = wallets.map((w) => w.sign(prepared, w.classicAddress).tx_blob);
      blob = multisign(partials);
    }

    const { code } = await submitNoWait(client, blob);
    return String(code);
  }

  /** Assert a rejection was an AUTHORITY refusal, not an expiry. */
  function assertNotExpiredText(result, story) {
    if (/tefPAST_LEDGER_SEQ|latest ledger sequence|ExpiredTransaction/i.test(String(result))) {
      throw new Error(
        `${story}: the transaction EXPIRED rather than being refused on ` +
        `authority grounds (${result}). This test has proven nothing.`,
      );
    }
    return result;
  }

  // ── MS-7 ───────────────────────────────────────────────────────────
  // The quorum has to be a real gate. One signature cannot reach quorum 2.
  await runTest('MS-7: a single signature is refused', async () => {
    const tx = payment({
      Account:     account.classicAddress,
      Destination: recipient.classicAddress,
      Amount:      xrpToDrops('1'),
    });
    tx.validate();

    const result = await submitExpectingRefusal(tx, [signer1], 1);
    assertNotExpiredText(result, 'MS-7');
    if (/^tes/.test(result)) throw new Error('a single signature reached quorum 2');
    console.log(`    (refused as expected: ${result})`);

    // BLOCKER: the exact code is unmeasured and the sparse rippled mirror
    // does not contain the signer-weight check, so it cannot be confirmed
    // from source. Recorded rather than hardcoded — see USER-STORIES.md.
  });

  // ── MS-8 ───────────────────────────────────────────────────────────
  // Bob is not in the signer list. A master-key-only payment is NOT the right
  // negative test — see USER-STORIES.md MS-8.
  await runTest('MS-8: a signature from an unlisted account is refused', async () => {
    const tx = payment({
      Account:     account.classicAddress,
      Destination: recipient.classicAddress,
      Amount:      xrpToDrops('1'),
    });
    tx.validate();

    const result = await submitExpectingRefusal(tx, [signer1, bob], 2);
    assertNotExpiredText(result, 'MS-8');
    if (/^tes/.test(result)) throw new Error('a non-listed signer satisfied the quorum');
    console.log(`    (refused as expected: ${result})`);

    // BLOCKER: predicted tecNO_PERMISSION or tecINSUF_SIGNER_WEIGHT. Same
    // reason as MS-7 — measured, not asserted.
  });

  // ── MS-9 ───────────────────────────────────────────────────────────
  // The most surprising consequence of the configuration: the account can
  // never be deleted, so its history can never be erased.
  //
  // The plan expected a single code, `tecNO_SIGNER_LIST`. Measurement says
  // the refusal is LAYERED, and which code you get depends on two things:
  // which authority signs, and how old the account is. Asserting one code
  // would be asserting a race between gates.
  //
  //   master-signed  -> tefMASTER_DISABLED   (signature phase; the master
  //                                           cannot authorize anything)
  //   quorum-signed  -> tecTOO_SOON          (age gate, on a fresh account)
  //                  -> tecNO_SIGNER_LIST    (once aged; suite [13])
  //
  // The first is the one this configuration uniquely produces, and it is the
  // meaningful half: the paper key is locked out of the one operation that
  // would have destroyed the account's history.
  await runTest('MS-9a: the master key cannot authorize AccountDelete at all', async () => {
    // Destination is REQUIRED by the factory and is where the remaining
    // balance would go. Omitting it throws client-side and proves nothing
    // about the ledger.
    const tx = accountDelete({
      Account:     account.classicAddress,
      Destination: recipient.classicAddress,
    });
    tx.validate();

    const result = await submitExpectingRefusal(tx, [], undefined);
    assertNotExpiredText(result, 'MS-9a');
    if (result !== 'tefMASTER_DISABLED') {
      throw new Error(
        `expected tefMASTER_DISABLED — the master key is locked out, so it ` +
        `cannot reach the apply phase at all — got ${result}`,
      );
    }
    console.log(`    (refused as expected: ${result})`);
  });

  await runTest('MS-9b: a quorum-authorized AccountDelete is also refused', async () => {
    const tx = accountDelete({
      Account:     account.classicAddress,
      Destination: recipient.classicAddress,
    });
    tx.validate();

    const result = await submitExpectingRefusal(tx, [signer1, signer2], 2);
    assertNotExpiredText(result, 'MS-9b');
    if (/^tes/.test(result)) {
      throw new Error('AccountDelete succeeded — a signer list is present and cannot be removed');
    }

    // Which gate fired depends on the account's age. The 256-ledger
    // requirement is why suite [13] takes ~20 minutes; this suite does not
    // wait for it, so on a fresh account the AGE gate answers first and
    // tecNO_SIGNER_LIST — the permanent one — is not yet reachable here.
    // Suite [13] establishes that code on an aged account.
    if (result === 'tecTOO_SOON') {
      console.log('    (refused at the AGE gate — tecTOO_SOON, not the permanent one)');
      console.log('    (tecNO_SIGNER_LIST is established by suite [13] on an aged account)');
      return;
    }
    if (result !== 'tecNO_SIGNER_LIST') {
      throw new Error(
        `expected tecTOO_SOON (fresh account) or tecNO_SIGNER_LIST (aged), got ${result}`,
      );
    }
    console.log(`    (refused as expected: ${result})`);
  });

  // ── Hand off ───────────────────────────────────────────────────────
  saveState(state);
  console.log('');
  console.log(`  Account ${state.account} is now multisign-only.`);
  console.log('  State saved for 16b/16c/16d. The master seed was discarded.');
  console.log('  Run 16b, 16c, 16d next — each loads this account.');

  return summary();
}

// ── Standalone execution ──────────────────────────────────────────────
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { withStandaloneSetup } = await import('../setup.mjs');
  await withStandaloneSetup(run);
}
