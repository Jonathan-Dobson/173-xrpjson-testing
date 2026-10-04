/**
 * [16c] Multisign-only account — what must fail.
 *
 * Implements MS-11 and MS-12 in USER-STORIES.md, plus the `AccountDelete`
 * reminder that belongs with the other permanent refusals.
 *
 * Consumes the account built by 16a. It does not build one — see
 * multisign-only-state.mjs for why that is structural.
 *
 *   node integration/tests/16c-multisign-only-refusals.mjs
 *
 * ORDERING IS LOAD-BEARING, in one direction only. MS-12 tests clawback and
 * expects `tecOWNERS`; MS-11 then sets NoFreeze, which SUCCEEDS. If they are
 * swapped, MS-12 would see `tecNO_PERMISSION` instead — AccountSet.cpp:199-203
 * runs before the owner-directory check at :205-209 and short-circuits on
 * lsfNoFreeze. That is a different code for a different reason, and asserting
 * tecOWNERS there would be asserting a cause the ledger never reported.
 */

import { xrpToDrops, multisign } from 'xrpl';
import { accountSet, setRegularKey, payment } from '../../xrpjson.mjs';
import { Wallet } from 'xrpl';
import {
  createRunner,
  expectRejected,
  ensureConnected,
  submitMultisigned,
  assertNotExpired,
} from '../helpers.mjs';
import { requireState } from '../multisign-only-state.mjs';
import { submitNoWait } from '../no-wait.mjs';

export async function run(client, alice, bob) {
  const { runTest, skip, summary } = createRunner();
  console.log('[16c] Multisign-only — the refusals');

  const state = requireState(import.meta.url);
  if (!state.ok) {
    console.log('');
    skip('[16c] all stories', state.reason);
    return summary();
  }
  const { account, signers } = state.ctx;
  const [s1, s2] = signers.map((s) => Wallet.fromSeed(s.seed));

  console.log(`  Account: ${account}  (master disabled, no regular key, quorum 2)`);
  console.log('');

  /** Autofill for a quorum signature set, combine, submit. */
  async function submitQuorum(txObj, count = 2) {
    return submitMultisigned(client, txObj.toJSON(), [s1, s2], { count });
  }

  // ── MS-12: clawback needs an empty owner directory ─────────────────
  // MUST run before MS-11. See the file header.
  await runTest('MS-12: asfAllowTrustLineClawback is refused (tecOWNERS) — a signer list is an owner-dir node', async () => {
    const tx = accountSet({
      Account: account,
      SetFlag: 16, // asfAllowTrustLineClawback
    });
    tx.validate();

    const { ok, result } = await expectRejected(() => submitQuorum(tx));

    // If lsfNoFreeze were already set the ledger would answer
    // tecNO_PERMISSION, which is a *different* refusal with a different
    // cause. Reporting that as a pass would hide a real change in ordering.
    if (result === 'tecNO_PERMISSION') {
      throw new Error(
        'got tecNO_PERMISSION, not tecOWNERS — lsfNoFreeze is already set, so ' +
        'the owner-directory check never ran. This suite must test clawback ' +
        'BEFORE MS-11 sets NoFreeze.',
      );
    }
    if (!ok) {
      throw new Error(
        'ledger ACCEPTED asfAllowTrustLineClawback — multisign and clawback ' +
        'are supposed to be mutually exclusive',
      );
    }
    if (result !== 'tecOWNERS') {
      throw new Error(
        `expected tecOWNERS (AccountSet.cpp:205-209), got ${result}. ` +
        `This is a finding, not a flake.`,
      );
    }
    console.log(`    (refused as expected: ${result})`);
  });

  // ── MS-11: the free key reset ──────────────────────────────────────
  // NOT a refusal on authority grounds. The transaction is perfectly
  // authorized; it is simply not free, because a multisigned transaction
  // carries SigningPubKey: '' and so cannot claim the zero-fee tier
  // (SetRegularKey.cpp:20-39).
  //
  // Submitted WITHOUT waiting. An underpaid transaction is not refused — it
  // is held in the queue waiting for a better fee offer — so `submitAndWait`
  // blocks for the whole window and then reports an expiry that says nothing
  // about the fee. The synchronous `submit` returns the real verdict.
  await runTest('MS-11: the "free" key reset is charged full price, not refused for authority', async () => {
    const newKey = Wallet.generate().classicAddress;
    const tx = setRegularKey({
      Account:    account,
      RegularKey: newKey,
      // Explicitly zero. The zero-fee tier requires a master-key signature
      // AND lsfPasswordSpent unset; this account satisfies neither, so the
      // ledger charges the normal base fee and this Fee is below it.
      Fee: '0',
    });
    tx.validate();

    const lc = await client.request({ command: 'ledger_current' });
    const prepared = await client.autofill(
      { ...tx.toJSON(), LastLedgerSequence: lc.result.ledger_current_index + 20 }, 2,
    );
    const blob = multisign([s1, s2].map((w) => w.sign(prepared, w.classicAddress).tx_blob));

    const { code, accepted } = await submitNoWait(client, blob);
    console.log(`    (engine_result: ${code}, accepted: ${accepted})`);

    // The engine_result is the verdict. Do NOT treat `accepted` as one:
    // rippled can return `accepted: true` alongside a `tel*` code, and an
    // assertion that reads `accepted` as "it went through" would call this
    // test a pass for a transaction the ledger never applied.
    if (/^tes/.test(String(code))) {
      throw new Error(
        `a multisigned SetRegularKey at Fee 0 was APPLIED (${code}). The ` +
        `zero-fee tier at SetRegularKey.cpp:24-34 should not be reachable ` +
        `without a master signature — this is a finding, not a flake.`,
      );
    }
    if (!/INSUF_FEE/.test(String(code))) {
      throw new Error(
        `expected an insufficient-fee refusal, got ${code}. The story says ` +
        `this is a FEE rule and not an AUTHORITY rule; any other code means ` +
        `the ledger is enforcing something else.`,
      );
    }
  });

  // ── A regular key CAN be set — the configuration is a choice ───────
  // Repeated here rather than left to 16d because it is the mirror of the
  // two stories above: both of those refusals are about side effects
  // (owner directory, fee tier), and neither is an authority wall.
  await runTest('context: setting a regular key IS authorized — the refusal above is not an authority wall', async () => {
    const newKey = Wallet.generate().classicAddress;
    const tx = setRegularKey({
      Account:    account,
      RegularKey: newKey,
    });
    tx.validate();

    // Paid fee this time — same operation, normal price.
    const { ok, result } = await expectRejected(() => submitQuorum(tx));
    if (!ok) return; // accepted; 16d asserts the state in detail

    throw new Error(
      `a fully-paid multisigned SetRegularKey was refused (${result}); MS-13 ` +
      `says the quorum can install a regular key`,
    );
  });

  return summary();
}

// ── Standalone execution ──────────────────────────────────────────────
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { withStandaloneSetup } = await import('../setup.mjs');
  await withStandaloneSetup(run);
}
