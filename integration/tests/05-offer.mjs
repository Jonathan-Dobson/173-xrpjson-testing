import { xrpToDrops } from 'xrpl';
import { OfferCreateTx, OfferCancelTx } from 'xrp-tx';
import { createRunner, assertSuccess, submitTx } from '../helpers.mjs';

export async function run(client, alice, bob) {
  const { runTest, summary } = createRunner();
  console.log('[5] OfferCreate / OfferCancel');

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
      Account:       alice.classicAddress,
      OfferSequence: offerSequence,
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
