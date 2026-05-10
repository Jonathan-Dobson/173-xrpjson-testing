import { AccountSetTx, AccountSetAsfFlags } from 'xrp-tx';
import { createRunner, assertSuccess, submitTx } from '../helpers.mjs';

export async function run(client, alice, bob) {
  const { runTest, summary } = createRunner();
  console.log('[2] AccountSet');

  await runTest('set account Domain', async () => {
    const tx = new AccountSetTx({
      Account: alice.classicAddress,
      Domain:  Buffer.from('example.com').toString('hex').toUpperCase(),
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, alice));
  });

  await runTest('enable RequireDest flag (asfRequireDest)', async () => {
    const tx = new AccountSetTx({
      Account: alice.classicAddress,
      SetFlag: AccountSetAsfFlags.asfRequireDest,
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, alice));
  });

  await runTest('clear RequireDest flag (asfRequireDest)', async () => {
    const tx = new AccountSetTx({
      Account:   alice.classicAddress,
      ClearFlag: AccountSetAsfFlags.asfRequireDest,
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, alice));
  });

  await runTest('set TransferRate and TickSize', async () => {
    const tx = new AccountSetTx({
      Account:      bob.classicAddress,
      TransferRate: 1_005_000_000, // 0.5 % fee
      TickSize:     5,
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, bob));
  });

  return summary();
}

// ── Standalone execution ──────────────────────────────────────────────────────
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { withStandaloneSetup } = await import('../setup.mjs');
  await withStandaloneSetup(run);
}
