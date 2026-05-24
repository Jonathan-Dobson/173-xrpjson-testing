import { PaymentTx, TrustSetTx } from 'xrplt';
import { createRunner, assertSuccess, submitTx } from '../helpers.mjs';

/**
 * Prerequisite: Alice must have a USD trust line to Bob.
 * When run standalone this is set up silently before the tests begin.
 */
async function setupTrustLine(client, alice, bob) {
  const tx = new TrustSetTx({
    Account: alice.classicAddress,
    LimitAmount: { currency: 'USD', issuer: bob.classicAddress, value: '10000' },
  });
  const prepared = await client.autofill(tx.toJSON());
  const { tx_blob } = alice.sign(prepared);
  await client.submitAndWait(tx_blob);
}

export async function run(client, alice, bob) {
  const { runTest, summary } = createRunner();
  console.log('[4] Payment (IOU)');

  await runTest('Bob issues 100 USD to Alice', async () => {
    const tx = new PaymentTx({
      Account:     bob.classicAddress,
      Destination: alice.classicAddress,
      Amount: { currency: 'USD', issuer: bob.classicAddress, value: '100' },
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, bob));
  });

  await runTest('Alice sends 10 USD back to Bob', async () => {
    const tx = new PaymentTx({
      Account:     alice.classicAddress,
      Destination: bob.classicAddress,
      Amount: { currency: 'USD', issuer: bob.classicAddress, value: '10' },
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, alice));
  });

  await runTest('partial IOU payment with SendMax (tfPartialPayment)', async () => {
    const tx = new PaymentTx({
      Account:     alice.classicAddress,
      Destination: bob.classicAddress,
      Amount:  { currency: 'USD', issuer: bob.classicAddress, value: '5' },
      SendMax: { currency: 'USD', issuer: bob.classicAddress, value: '5' },
      Flags: 0x00020000, // tfPartialPayment
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
  await withStandaloneSetup(async (client, alice, bob) => {
    process.stdout.write('Setting up USD trust line (prerequisite) … ');
    await setupTrustLine(client, alice, bob);
    console.log('done.\n');
    return run(client, alice, bob);
  });
}
