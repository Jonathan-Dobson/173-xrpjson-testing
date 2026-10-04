/**
 * [16d] Multisign-only account — the boundary.
 *
 * Implements MS-13, MS-14 and MS-15 in USER-STORIES.md.
 *
 * These are the operations that look like refusals and are not. Each one is
 * the flip side of a story in 16c, and together they are the honest shape of
 * the configuration: the quorum is powerful enough to add a single-key path
 * back in, and to undo the restriction protecting itself.
 *
 * Consumes the account built by 16a. Runs after 16b and 16c, because MS-15
 * re-enables the master key and every earlier suite assumes it is disabled.
 *
 *   node integration/tests/16d-multisign-only-boundary.mjs
 */

import { Wallet, multisign } from 'xrpl';
import { accountSet, setRegularKey } from '../../xrpjson.mjs';
import {
  createRunner,
  assertSuccess,
  submitMultisigned,
  expectRejected,
  waitForAccountState,
  accountFlags,
} from '../helpers.mjs';
import { requireState } from '../multisign-only-state.mjs';

export async function run(client, alice, bob) {
  const { runTest, skip, summary } = createRunner();
  console.log('[16d] Multisign-only — the boundary (what looks refused but is not)');

  const state = requireState(import.meta.url);
  if (!state.ok) {
    console.log('');
    skip('[16d] all stories', state.reason);
    return summary();
  }
  const { account, signers } = state.ctx;
  const [s1, s2] = signers.map((s) => Wallet.fromSeed(s.seed));

  console.log(`  Account: ${account}`);
  console.log('');

  async function submitQuorum(txObj, count = 2) {
    return submitMultisigned(client, txObj.toJSON(), [s1, s2], { count });
  }

  // The key 16d installs. Never funded — a regular key needs no balance,
  // only the ability to sign.
  const hotKey = Wallet.generate();

  // ── MS-13 ──────────────────────────────────────────────────────────
  // The most important row in the Category 1 table. A quorum CAN install a
  // regular key, which means "no regular key" is a choice the operator makes,
  // not an invariant the ledger enforces. A product implying the account is
  // stuck in this state would be wrong.
  await runTest('MS-13: the quorum can install a regular key', async () => {
    const tx = setRegularKey({
      Account:    account,
      RegularKey: hotKey.classicAddress,
    });
    tx.validate();
    assertSuccess(await submitQuorum(tx));

    await waitForAccountState(
      client,
      account,
      (d) => d.RegularKey === hotKey.classicAddress,
      { label: 'the regular key to become visible' },
    );
  });

  // ── the key must actually work ─────────────────────────────────────
  // A suite that only asserts the field was set proves nothing — the ledger
  // could be storing it and ignoring it. This is the pairing the setup
  // story owes its consumer.
  await runTest('MS-13b: the quorum-installed regular key actually signs', async () => {
    const { payment } = await import('../../xrpjson.mjs');
    const { xrpToDrops } = await import('xrpl');

    const tx = payment({
      Account:     account,
      Destination: state.ctx.recipient,
      Amount:      xrpToDrops('1'),
    });
    tx.validate();

    const prepared = await client.autofill(tx.toJSON());
    // Single signature from the regular key. `Wallet.sign()` sets
    // SigningPubKey from this wallet's own key and leaves `Account` alone,
    // which is exactly the wire form the ledger expects.
    const { tx_blob } = hotKey.sign(prepared);
    assertSuccess(await client.submitAndWait(tx_blob));
  });

  // ── MS-14 ──────────────────────────────────────────────────────────
  // Removal is safe here only because a signer list exists. On the 16a
  // configuration — master disabled, no signer list — this exact transaction
  // is refused with tecNO_ALTERNATIVE_KEY (SetRegularKey.cpp:69-71). MS-3
  // already showed the ledger refuses to create that state; this story shows
  // why the removal is not walking back into it.
  await runTest('MS-14: the quorum can remove the regular key again', async () => {
    const tx = setRegularKey({ Account: account });
    tx.validate();
    assertSuccess(await submitQuorum(tx));

    await waitForAccountState(
      client,
      account,
      (d) => d.RegularKey === undefined,
      { label: 'the regular key to be removed' },
    );
  });

  // ── MS-15 ──────────────────────────────────────────────────────────
  // THE most consequential story in the suite, and the one the original plan
  // got backwards.
  //
  // The plan asserted "the paper seed is permanently useless". That is not
  // what the ledger does. `lsfDisableMaster` is an ordinary revocable flag:
  // AccountSet.cpp:325-329 clears it with no signature check at all, and
  // rippled's authority checks consult the flag rather than any burned
  // state (compare XChainBridge.cpp:134-138, which refuses a master-key
  // attestation only while the flag is set). The canonical doc is careful
  // here too — accountset.md:81 says "Disallow use of the master key pair",
  // with none of the "permanently" language it uses for `asfNoFreeze` two
  // rows below ("This flag can never be disabled after being enabled").
  //
  // So the restriction protects the master key from everyone EXCEPT the
  // quorum, and the quorum can hand it back on request.
  await runTest('MS-15: the quorum can re-enable the master key', async () => {
    const tx = accountSet({
      Account:  account,
      ClearFlag: 4, // asfDisableMaster
    });
    tx.validate();
    assertSuccess(await submitQuorum(tx));

    const data = await waitForAccountState(
      client,
      account,
      (d) => (accountFlags(d) & 0x00100000) === 0,
      { label: 'lsfDisableMaster to be cleared' },
    );

    if (data.RegularKey) {
      throw new Error('a regular key is present, so this is no longer the [16] configuration');
    }
    console.log('    (lsfDisableMaster cleared — the master key is NOT permanently dead)');
  });

  // And the asymmetry that makes it worse: `asfNoFreeze` IS permanent, and
  // MS-10 showed the quorum can set it. So the quorum holds a key to undo the
  // restriction protecting the master key, and only irreversible levers
  // against itself.
  console.log('');
  console.log('  This account is no longer master-disabled. Any later suite that');
  console.log('  assumes the restriction is in force must not use it.');

  return summary();
}

// ── Standalone execution ──────────────────────────────────────────────
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { withStandaloneSetup } = await import('../setup.mjs');
  await withStandaloneSetup(run);
}
