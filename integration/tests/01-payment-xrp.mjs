import { xrpToDrops } from 'xrpl';
import { PaymentTx } from 'xrplt';
import { createRunner, assertSuccess, submitTx } from '../helpers.mjs';

export async function run(client, alice, bob) {
  const { runTest, summary } = createRunner();
  console.log('[1] Payment (XRP)');

  await runTest('send 10 XRP from Alice to Bob', async () => {
    const tx = new PaymentTx({
      Account:     alice.classicAddress,
      Destination: bob.classicAddress,
      Amount:      xrpToDrops('10'),
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, alice));
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
    assertSuccess(await submitTx(client, tx, alice));
  });

  await runTest('payment with explicit Fee + LastLedgerSequence via .with()', async () => {
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
    const prepared   = await client.autofill(tx.toJSON());
    const { tx_blob } = alice.sign(prepared);
    assertSuccess(await client.submitAndWait(tx_blob));
  });

  return summary();
}

// ── Standalone execution ──────────────────────────────────────────────────────
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { withStandaloneSetup } = await import('../setup.mjs');
  await withStandaloneSetup(run);
}
