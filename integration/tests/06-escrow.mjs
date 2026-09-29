import { xrpToDrops } from 'xrpl';
import { EscrowCreateTx, EscrowFinishTx, EscrowCancelTx } from '../../xrpjson.mjs';
import { createRunner, assertSuccess, submitTx, xrplNow } from '../helpers.mjs';

export async function run(client, alice, bob) {
  const { runTest, summary } = createRunner();
  console.log('[6] EscrowCreate / EscrowFinish / EscrowCancel');

  // ── 6a: EscrowFinish ───────────────────────────────────────────────────────
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
    assertSuccess(await submitTx(client, tx, alice));
  });

  // ── 6b: EscrowCancel ───────────────────────────────────────────────────────
  // CancelAfter must be strictly greater than FinishAfter (ledger rule).
  let escrowCancelSeq;

  await runTest('create an escrow with FinishAfter +5s, CancelAfter +10s', async () => {
    const now = xrplNow();
    const tx = new EscrowCreateTx({
      Account:     alice.classicAddress,
      Destination: bob.classicAddress,
      Amount:      xrpToDrops('2'),
      FinishAfter: now + 5,
      CancelAfter: now + 10,
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
    assertSuccess(await submitTx(client, tx, alice));
  });

  return summary();
}

// ── Standalone execution ──────────────────────────────────────────────────────
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { withStandaloneSetup } = await import('../setup.mjs');
  await withStandaloneSetup(run);
}
