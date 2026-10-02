/**
 * [13] Security & account admin — regular keys, multisig, deposit preauth,
 * tickets, and account deletion.
 *
 * Implements the stories in USER-STORIES.md § "[13] Security & account admin".
 *
 * Suites [1]–[12] all assume one key controls one account. This suite covers
 * the primitives that assumption rests on, and the ones an exchange or
 * custodian runs constantly.
 *
 * ORDERING IS LOAD-BEARING. AccountDelete (ADM-12) fails unless the account
 * owns nothing:
 *   - regular key set      → tecNO_REGULAR_KEY  ← cleared by ADM-4
 *   - signer list present  → tecNO_SIGNER_LIST  ← cleared by ADM-7
 *   - trust lines / offers / NFT pages / negative UNL → tecINCOMPLETE_INDICATOR
 *
 * ADM-4 and ADM-7 are therefore prerequisites of ADM-12, not merely good
 * hygiene. The delete runs on a dedicated throwaway wallet that never
 * accumulates any of those objects.
 *
 * Run standalone: node integration/tests/13-account-admin.mjs
 */

import { Wallet, xrpToDrops, multisign } from 'xrpl';
// Canonical fp factory names, not the legacy `XxxTx` aliases. The shim's
// aliases are a migration shim for suites [1]–[11]; new suites use the
// documented functional API directly.
import {
  payment,
  setRegularKey,
  signerListSet,
  depositPreauth,
  ticketCreate,
  accountDelete,
  ValidationError,
} from '../../xrpjson.mjs';
import {
  createRunner,
  assertSuccess,
  submitTx,
  balanceDrops,
  ensureConnected,
  expectRejected,
  waitFor,
  waitForAccountState,
} from '../helpers.mjs';

// How long ADM-12 will wait for the ledger to age past the throwaway's
// Sequence before giving up and skipping. 256 ledgers at testnet's ~4s ledger
// close is ~17 minutes; allow a little headroom on top.
const ACCOUNT_DELETE_WAIT_MS = 20 * 60_000;

export async function run(client, alice, bob) {
  const { runTest, skip, summary } = createRunner();
  console.log('[13] Security & account admin — regular key, multisig, preauth, tickets, delete');

  // Carol receives the multisigned payment and is the AccountDelete
  // destination. Dave is a third party whose signature must NOT satisfy
  // Alice's signer-list quorum.
  const { wallet: carol } = await client.fundWallet();
  const { wallet: dave } = await client.fundWallet();
  console.log(`  Carol: ${carol.classicAddress}`);
  console.log(`  Dave:  ${dave.classicAddress}`);

  // Funded FIRST, on purpose. The testnet faucet sets a new account's
  // Sequence to the current ledger index, and AccountDelete refuses to act
  // until the ledger has advanced 256 past it (~17 min at ~4s/ledger).
  // Funding at the top gives the rest of the suite that time to elapse.
  // See Part E for the full explanation.
  const { wallet: throwaway } = await client.fundWallet();
  console.log(`  Throwaway: ${throwaway.classicAddress}`);

  /**
   * Submit a payment signed by a key OTHER than the account's master key.
   * xrpl 4.6.0's Wallet.sign() sets SigningPubKey from the signing wallet's
   * own public key and leaves `Account` untouched, so a regular-key wallet
   * signing an `Account: alice` tx produces exactly the wire form the ledger
   * expects. Returns the raw submit result (success is NOT asserted).
   */
  async function signAs(wallet, txJson) {
    const prepared = await client.autofill(txJson);
    const { tx_blob } = wallet.sign(prepared);
    return client.submitAndWait(tx_blob);
  }

  // ── Part A: regular key (ADM-1 → ADM-4) ───────────────────────────
  console.log('\n  ── Regular key (ADM-1 … ADM-4) ──');

  // Keys we control, used to act as Alice's hot keys. Deliberately never
  // funded — a regular key needs no balance, only the ability to sign.
  const hotKey   = Wallet.generate();
  const hotKey2  = Wallet.generate();

  // The account ADM-12 destroys, funded at the top of the suite so the
  // ledger-age requirement can elapse before Part E.
  let throwawayRef = { wallet: throwaway };

  await runTest('ADM-1: Alice sets a regular key', async () => {
    const tx = setRegularKey({
      Account:    alice.classicAddress,
      RegularKey: hotKey.classicAddress,
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, alice));
  });

  // The story that makes ADM-1 real: the delegation must actually sign.
  await runTest('ADM-2: Alice signs a payment with the REGULAR key, not the master key', async () => {
    const tx = payment({
      Account:     alice.classicAddress,
      Destination: carol.classicAddress,
      Amount:      xrpToDrops('1'),
    });
    tx.validate();

    const carolBefore = await balanceDrops(client, carol.classicAddress);
    const res = await signAs(hotKey, tx.toJSON());
    assertSuccess(res);
    const carolAfter = await balanceDrops(client, carol.classicAddress);

    if (carolAfter !== carolBefore + BigInt(xrpToDrops('1'))) {
      throw new Error(
        `Carol received ${carolAfter - carolBefore} drops, expected ${xrpToDrops('1')}`,
      );
    }
  });

  await runTest('ADM-3: Alice rotates to a new regular key — new works, old stops working', async () => {
    const rotate = setRegularKey({
      Account:    alice.classicAddress,
      RegularKey: hotKey2.classicAddress,
    });
    rotate.validate();
    assertSuccess(await submitTx(client, rotate, alice));

    // submitAndWait returning does NOT mean autofill will observe the new key.
    // Without this wait, the next sign races the account-state update and the
    // ledger still holds the old key when it validates the signature —
    // which surfaces as a confusing tefBAD_AUTH on the *correct* key.
    await waitForAccountState(
      client,
      alice.classicAddress,
      a => a.RegularKey === hotKey2.classicAddress,
      { label: 'the rotated regular key to become visible' },
    );

    // New key must work…
    const pay = payment({
      Account:     alice.classicAddress,
      Destination: carol.classicAddress,
      Amount:      xrpToDrops('1'),
    });
    pay.validate();
    assertSuccess(await signAs(hotKey2, pay.toJSON()));

    // …and the old key must now be refused. Asserting only the first half
    // would make this a cosmetic test. This submit is *expected* to fail, so
    // it must not go through assertSuccess, and submitAndWait throwing on a
    // tef code has to be caught rather than allowed to escape.
    const stale = payment({
      Account:     alice.classicAddress,
      Destination: carol.classicAddress,
      Amount:      xrpToDrops('1'),
    });
    stale.validate();
    const { ok, result } = await expectRejected(() => signAs(hotKey, stale.toJSON()));
    if (!ok) {
      throw new Error('Expected the rotated-away regular key to be rejected, got tesSUCCESS');
    }
    console.log(`    (ledger refused the old key as expected: ${result})`);
  });

  // ADM-4 — clears tecNO_REGULAR_KEY so ADM-12 can succeed later.
  await runTest('ADM-4: Alice removes the regular key (prerequisite for ADM-12)', async () => {
    const tx = setRegularKey({
      Account: alice.classicAddress,
      // RegularKey deliberately absent — this is the removal path
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, alice));

    // Wait for the removal to be observable, so the multisig part that
    // follows is not racing it.
    await waitForAccountState(
      client,
      alice.classicAddress,
      a => !a.RegularKey,
      { label: 'the regular key to be cleared' },
    );
  });

  // ── Part B: multisig (ADM-5 → ADM-7) ──────────────────────────────
  console.log('\n  ── Multisigning (ADM-5 … ADM-7) ──');

  await runTest('ADM-5: Alice creates a 1-of-1 signer list with Bob', async () => {
    const tx = signerListSet({
      Account:      alice.classicAddress,
      SignerQuorum: 1,
      SignerEntries: [
        { SignerEntry: { Account: bob.classicAddress, SignerWeight: 1 } },
      ],
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, alice));
  });

  // The story that makes ADM-5 real: the quorum must be enforced on a payment.
  await runTest('ADM-6: Alice submits a MULTISIGNED payment that succeeds', async () => {
    const tx = payment({
      Account:     alice.classicAddress,
      Destination: carol.classicAddress,
      Amount:      xrpToDrops('1'),
    });
    tx.validate();

    // autofill's second arg is the SIGNER COUNT, and it is not optional for
    // multisigned transactions. xrpl.org multi-signing.md: "The transaction
    // cost (specified in the Fee field) must be at least (N+1) times the
    // normal transaction cost, where N is the number of signatures provided."
    // Autofill only computes the incremental (base) cost, so omitting this
    // produces telINSUF_FEE_P.
    const prepared = await client.autofill(tx.toJSON(), 1);
    // Passing an explicit signer address makes Wallet.sign() emit
    // SigningPubKey: '' plus a one-entry Signers array.
    const partial = bob.sign(prepared, bob.classicAddress);
    // multisign() combines and validates. NOTE: client.multisign() and
    // client.signers do not exist in xrpl 4.6.0 — older examples won't run.
    const tx_blob = multisign([partial.tx_blob]);
    assertSuccess(await client.submitAndWait(tx_blob));
  });

  await runTest('ADM-6: a multisignature from a NON-listed account is refused', async () => {
    const tx = payment({
      Account:     alice.classicAddress,
      Destination: carol.classicAddress,
      Amount:      xrpToDrops('1'),
    });
    tx.validate();

    // Dave is NOT in Alice's signer list, so his signature must not satisfy
    // the quorum. This is the constraint that actually proves ADM-5 did
    // something.
    //
    // NOTE: a master-key-only payment is NOT the right negative test here.
    // The signer list does not disable the master key on its own — per
    // xrpl.org multi-signing.md, an account "can have any combination of
    // authorization methods enabled", and you must explicitly disable the
    // master key with AccountSet to make multi-signing the only route.
    const prepared = await client.autofill(tx.toJSON(), 1);
    const partial = dave.sign(prepared, dave.classicAddress);
    const tx_blob = multisign([partial.tx_blob]);

    const { ok, result } = await expectRejected(() => client.submitAndWait(tx_blob));
    if (!ok) {
      throw new Error('Expected a non-listed signer to be refused, got tesSUCCESS');
    }
    console.log(`    (ledger refused the non-listed signer as expected: ${result})`);
  });

  // ADM-7 — clears tecNO_SIGNER_LIST so ADM-12 can succeed later.
  await runTest('ADM-7: Alice removes the signer list (SignerQuorum 0, entries omitted)', async () => {
    const tx = signerListSet({
      Account:      alice.classicAddress,
      SignerQuorum: 0,
      // SignerEntries deliberately absent — xrpl.org: quorum 0 alone is
      // temMALFORMED; the field must be omitted too.
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, alice));
  });

  await runTest('ADM-7: single-signature works again once the list is gone', async () => {
    const tx = payment({
      Account:     alice.classicAddress,
      Destination: carol.classicAddress,
      Amount:      xrpToDrops('1'),
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, alice));
  });

  // ── Part C: deposit preauthorization (ADM-8, ADM-9) ────────────────
  console.log('\n  ── Deposit preauthorization (ADM-8, ADM-9) ──');

  await runTest('ADM-8: Alice preauthorizes Bob to send her funds', async () => {
    const tx = depositPreauth({
      Account:   alice.classicAddress,
      Authorize: bob.classicAddress,
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, alice));
  });

  await runTest('ADM-9: Alice revokes Bob\'s preauthorization', async () => {
    const tx = depositPreauth({
      Account:     alice.classicAddress,
      Unauthorize: bob.classicAddress,
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, alice));
  });

  // ── Part D: tickets (ADM-10, ADM-11) ──────────────────────────────
  console.log('\n  ── Tickets (ADM-10, ADM-11) ──');

  // A ticket's number is NOT `1`, and it is not simply "the account's next
  // sequence" either — computing it from account state races the ledger and
  // fails with terPRE_TICKET ("Ticket is not yet in ledger"), which is a
  // retriable code that reads like a propagation problem rather than a wrong
  // number. So read the tickets the ledger actually created instead of
  // deriving them.
  //
  // Reference: rippled TicketCreate.cpp::doApply —
  //   "The starting ticket sequence is the same as the current account root
  //    sequence. Before we got here to doApply(), the transaction machinery
  //    already incremented the account root sequence if that was appropriate."
  //   std::uint32_t const firstTicketSeq = (*sleAccountRoot)[sfSequence];
  let firstTicket;

  await runTest('ADM-10: Alice pre-creates a batch of 5 tickets', async () => {
    const tx = ticketCreate({
      Account:     alice.classicAddress,
      TicketCount: 5,
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, alice));
  });

  await runTest('setup: read the 5 reserved ticket numbers straight from the ledger', async () => {
    // Poll rather than read once: account_objects is a server read and the
    // TicketCreate may not be in the queried view yet.
    const tickets = await waitFor(
      async () => {
        const res = await client.request({
          command: 'account_objects',
          account: alice.classicAddress,
          type: 'ticket',
        });
        const objs = res.result.account_objects ?? [];
        return objs.length >= 5 ? objs : null;
      },
      { timeoutMs: 30_000, label: '5 tickets to appear in the owner directory' },
    );
    const seqs = tickets.map(t => t.TicketSequence).sort((a, b) => a - b);
    firstTicket = seqs[0];
    console.log(`  (tickets reserved: ${seqs.join(', ')})`);
  });

  // ADM-11 — documents a real xrpjson gap: no top-level factory exposes
  // TicketSequence, so the field is merged in after construction, outside the
  // validated path. See USER-STORIES.md "Finding A" / DIVERGENCES.md Bug #5.
  await runTest('ADM-11: a payment spends a ticket (Sequence 0 + TicketSequence)', async () => {
    if (!firstTicket) throw new Error('No firstTicket from prior test');
    // NOTE: `payment()` has no TicketSequence prop — verified against
    // xrpjson@1.1.0. Sequence: 0 is how a ticketed tx signals "do not
    // advance my sequence number".
    const tx = payment({
      Account:     alice.classicAddress,
      Destination: carol.classicAddress,
      Amount:      xrpToDrops('1'),
    });
    tx.validate();

    const prepared = await client.autofill(tx.toJSON());
    // autofill resolves Sequence/Fee against the current account; overwrite
    // Sequence with 0 (the "this is ticketed" marker) and add the ticket.
    prepared.Sequence = 0;
    prepared.TicketSequence = firstTicket;

    const { tx_blob } = alice.sign(prepared);
    assertSuccess(await client.submitAndWait(tx_blob));
  });

  await runTest('ADM-11: reusing the same ticket is rejected — it was really consumed', async () => {
    if (!firstTicket) throw new Error('No firstTicket from prior test');
    const tx = payment({
      Account:     alice.classicAddress,
      Destination: carol.classicAddress,
      Amount:      xrpToDrops('1'),
    });
    tx.validate();

    const prepared = await client.autofill(tx.toJSON());
    prepared.Sequence = 0;
    prepared.TicketSequence = firstTicket;   // already consumed by the story above

    const { tx_blob } = alice.sign(prepared);
    const { ok, result } = await expectRejected(() => client.submitAndWait(tx_blob));
    if (!ok) {
      throw new Error('Expected reuse of a consumed ticket to be rejected, got tesSUCCESS');
    }
    console.log(`    (ledger refused the reused ticket as expected: ${result})`);
  });

  // ── Part E: account deletion (ADM-12) ──────────────────────────────
  // Runs on a throwaway so the shared Alice/Bob are never at risk.
  //
  // The throwaway is funded back in Part A, NOT here, and the reason is
  // non-obvious. The XRPL testnet faucet sets a new account's `Sequence` to
  // the current ledger index (measured: Sequence 21195755 at ledger
  // 21195800), and rippled's AccountDelete::doApply refuses to delete while
  //
  //     account.Sequence + 255 > currentLedgerIndex
  //
  // so a freshly funded account cannot be deleted for 256 ledgers — roughly
  // 17 minutes at testnet's ~4s ledger close. That wait only has a chance of
  // succeeding if the account is funded at the TOP of the suite and the
  // remaining parts spend the time.
  console.log('\n  ── Account deletion (ADM-12) ──');

  await runTest('ADM-12: Alice deletes the throwaway account and reclaims the XRP', async () => {
    if (!throwawayRef) throw new Error('No throwaway from Part A');
    const { wallet: throwaway } = throwawayRef;

    await ensureConnected(client);
    const info = await client.request({
      command: 'account_info',
      account: throwaway.classicAddress,
      ledger_index: 'current',
    });
    const seq = info.result.account_data.Sequence;
    const required = seq + 256;
    let ledger = info.result.ledger_current_index;

    if (ledger < required) {
      const ledgersAway = required - ledger;
      console.log(
        `    (waiting for ${ledgersAway} more ledgers — the faucet sets a new` +
        ` account's Sequence to the funding ledger index, and AccountDelete` +
        ` requires Sequence + 255 < ledger)`,
      );
      ledger = await waitFor(
        async () => {
          // The wait can outlive an idle testnet socket, so re-check it every
          // probe rather than letting the next request blow up.
          try {
            const r = await client.request({ command: 'ledger_current' });
            return r.result.ledger_current_index >= required ? r.result.ledger_current_index : null;
          } catch (e) {
            if (/not open|CLOSING|CLOSED/i.test(String(e?.message))) {
              await client.connect();
              return null;
            }
            throw e;
          }
        },
        { timeoutMs: ACCOUNT_DELETE_WAIT_MS, label: `ledger ${required} (${ledgersAway} away)` },
      );
    }
    console.log(`    (ledger ${ledger} ≥ ${required}; delete is unblocked)`);

    await ensureConnected(client);
    const carolBefore = await balanceDrops(client, carol.classicAddress);

    const tx = accountDelete({
      Account:     throwaway.classicAddress,
      Destination: carol.classicAddress,   // funded, and not the sender
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, throwaway));

    const carolAfter = await balanceDrops(client, carol.classicAddress);
    const received = carolAfter - carolBefore;
    if (received <= 0n) {
      throw new Error(`Carol received ${received} drops — expected the leftover XRP`);
    }
    console.log(`    (Carol reclaimed ${received} drops)`);
    throwawayRef = null;   // the account no longer exists
  }, { timeoutMs: ACCOUNT_DELETE_WAIT_MS });   // the ledger wait needs more than the 90s default

  // ── Part F: construction-time guards ───────────────────────────────
  // Every one of these is an acceptance criterion in USER-STORIES.md that
  // xrpjson should catch before anything reaches the ledger. They need no
  // wallet and no network, but they live here because they are the guard half
  // of the stories above — a story that only asserts the happy path would
  // pass even if the guard silently regressed.
  console.log('\n  ── Construction-time guards (no ledger interaction) ──');

  const rejects = (fn, label) => {
    let threw;
    try { fn(); } catch (e) { threw = e; }
    if (!threw) throw new Error(`${label}: expected a throw, got none`);
    if (!(threw instanceof ValidationError)) {
      throw new Error(`${label}: expected ValidationError, got ${threw.constructor.name}: ${threw.message}`);
    }
  };

  await runTest('guard: SetRegularKey rejects a regular key equal to the account (temBAD_REGKEY)', () => {
    rejects(
      () => setRegularKey({
        Account:    alice.classicAddress,
        RegularKey: alice.classicAddress,
      }),
      'SetRegularKey self-assignment',
    );
  });

  await runTest('guard: DepositPreauth rejects self-preauthorization (temCANNOT_PREAUTH_SELF)', () => {
    rejects(
      () => depositPreauth({
        Account:   alice.classicAddress,
        Authorize: alice.classicAddress,
      }),
      'DepositPreauth self-preauth',
    );
  });

  await runTest('guard: SignerListSet rejects quorum 0 *with* SignerEntries (temMALFORMED)', () => {
    rejects(
      () => signerListSet({
        Account:      alice.classicAddress,
        SignerQuorum: 0,
        SignerEntries: [{ SignerEntry: { Account: bob.classicAddress, SignerWeight: 1 } }],
      }),
      'SignerListSet quorum 0 with entries',
    );
  });

  await runTest('guard: SignerListSet rejects a quorum above the sum of weights (temBAD_QUORUM)', () => {
    rejects(
      () => signerListSet({
        Account:      alice.classicAddress,
        SignerQuorum: 5,
        SignerEntries: [{ SignerEntry: { Account: bob.classicAddress, SignerWeight: 1 } }],
      }),
      'SignerListSet quorum > sum(weights)',
    );
  });

  await runTest('guard: SignerListSet rejects the sending account as its own signer (temBAD_SIGNER)', () => {
    rejects(
      () => signerListSet({
        Account:      alice.classicAddress,
        SignerQuorum: 1,
        SignerEntries: [{ SignerEntry: { Account: alice.classicAddress, SignerWeight: 1 } }],
      }),
      'SignerListSet self-signer',
    );
  });

  await runTest('guard: TicketCreate rejects a TicketCount outside 1..256', () => {
    rejects(
      () => ticketCreate({ Account: alice.classicAddress, TicketCount: 0 }),
      'TicketCreate TicketCount=0',
    );
    rejects(
      () => ticketCreate({ Account: alice.classicAddress, TicketCount: 257 }),
      'TicketCreate TicketCount=257',
    );
  });

  await runTest('guard: AccountDelete rejects a destination equal to the sender (temDST_IS_SRC)', () => {
    rejects(
      () => accountDelete({
        Account:     alice.classicAddress,
        Destination: alice.classicAddress,
      }),
      'AccountDelete self-destination',
    );
  });

  return summary();
}

// ── Standalone execution ──────────────────────────────────────────────────────
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { withStandaloneSetup } = await import('../setup.mjs');
  await withStandaloneSetup(run);
}
