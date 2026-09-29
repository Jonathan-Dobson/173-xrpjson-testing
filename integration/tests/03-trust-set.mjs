import { TrustSetTx } from '../../xrpjson.mjs';
import { createRunner, assertSuccess, submitTx } from '../helpers.mjs';

export async function run(client, alice, bob) {
  const { runTest, summary } = createRunner();
  console.log('[3] TrustSet');

  await runTest('Alice creates a USD trust line to Bob', async () => {
    const tx = new TrustSetTx({
      Account: alice.classicAddress,
      LimitAmount: { currency: 'USD', issuer: bob.classicAddress, value: '10000' },
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, alice));
  });

  await runTest('Alice creates an EUR trust line to Bob', async () => {
    const tx = new TrustSetTx({
      Account: alice.classicAddress,
      LimitAmount: { currency: 'EUR', issuer: bob.classicAddress, value: '5000' },
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
