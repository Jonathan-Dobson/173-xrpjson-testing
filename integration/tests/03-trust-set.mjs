import { TrustSetTx } from '../../xrpjson.mjs';
import { createRunner, assertSuccess, submitTx } from '../helpers.mjs';

export async function run(client, alice, bob) {
  const { runTest, summary } = createRunner();
  console.log('[3] TrustSet');

  await runTest('Alice creates a USD trust line to Bob', async () => {
    // After the [10] IOU reorder, Alice may already have a USD trust line
    // to Bob with limit 50000 and balance 10000. This TrustSet updates
    // (does not create a duplicate) — keep the limit at 50000 so the
    // existing 10000 USD balance stays within bounds.
    const tx = new TrustSetTx({
      Account: alice.classicAddress,
      LimitAmount: { currency: 'USD', issuer: bob.classicAddress, value: '50000' },
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, alice));
  });

  await runTest('Alice creates an EUR trust line to Bob', async () => {
    // Same as above: keep limit >= 10000 to accommodate [10]'s 4500 EUR
    // remaining balance after the clawback.
    const tx = new TrustSetTx({
      Account: alice.classicAddress,
      LimitAmount: { currency: 'EUR', issuer: bob.classicAddress, value: '10000' },
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
