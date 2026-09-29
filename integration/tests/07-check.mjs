import { xrpToDrops } from 'xrpl';
import { CheckCreateTx, CheckCashTx, CheckCancelTx } from '../../xrpjson.mjs';
import { createRunner, assertSuccess, submitTx, extractCreatedIndex } from '../helpers.mjs';

export async function run(client, alice, bob) {
  const { runTest, summary } = createRunner();
  console.log('[7] CheckCreate / CheckCash / CheckCancel');

  let checkId;

  await runTest('Alice creates a check for 20 XRP payable to Bob', async () => {
    const tx = new CheckCreateTx({
      Account:     alice.classicAddress,
      Destination: bob.classicAddress,
      SendMax:     xrpToDrops('20'),
    });
    tx.validate();
    const res = await submitTx(client, tx, alice);
    assertSuccess(res);
    checkId = extractCreatedIndex(res, 'Check');
  });

  await runTest('Bob cashes the check for 15 XRP', async () => {
    if (!checkId) throw new Error('No checkId from prior test');
    const tx = new CheckCashTx({
      Account: bob.classicAddress,
      CheckID: checkId,
      Amount:  xrpToDrops('15'),
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, bob));
  });

  await runTest('Alice creates and immediately cancels a check', async () => {
    const createTx = new CheckCreateTx({
      Account:     alice.classicAddress,
      Destination: bob.classicAddress,
      SendMax:     xrpToDrops('5'),
    });
    createTx.validate();
    const createRes = await submitTx(client, createTx, alice);
    assertSuccess(createRes);

    const cid = extractCreatedIndex(createRes, 'Check');
    if (!cid) throw new Error('Could not extract CheckID');

    const cancelTx = new CheckCancelTx({
      Account: alice.classicAddress,
      CheckID: cid,
    });
    cancelTx.validate();
    assertSuccess(await submitTx(client, cancelTx, alice));
  });

  return summary();
}

// ── Standalone execution ──────────────────────────────────────────────────────
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { withStandaloneSetup } = await import('../setup.mjs');
  await withStandaloneSetup(run);
}
