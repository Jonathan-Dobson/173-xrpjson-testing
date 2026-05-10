/**
 * Run all integration test suites against XRPL Testnet.
 * Funds a single pair of wallets shared across all suites.
 *
 * Usage: node integration/run-all.mjs
 */

import { createClient, fundWallets } from './setup.mjs';
import { run as runPaymentXrp  } from './tests/01-payment-xrp.mjs';
import { run as runAccountSet  } from './tests/02-account-set.mjs';
import { run as runTrustSet    } from './tests/03-trust-set.mjs';
import { run as runPaymentIou  } from './tests/04-payment-iou.mjs';
import { run as runOffer       } from './tests/05-offer.mjs';
import { run as runEscrow      } from './tests/06-escrow.mjs';
import { run as runCheck       } from './tests/07-check.mjs';
import { run as runNft         } from './tests/08-nft.mjs';

const client = await createClient();
const [alice, bob] = await fundWallets(client, 2);

const totals = { passed: 0, failed: 0, skipped: 0 };

function accumulate(stats) {
  if (!stats) return;
  totals.passed  += stats.passed;
  totals.failed  += stats.failed;
  totals.skipped += stats.skipped;
}

// [1–2] No prerequisites
accumulate(await runPaymentXrp(client, alice, bob));
console.log('');
accumulate(await runAccountSet(client, alice, bob));
console.log('');

// [3] TrustSet — must run before IOU payment tests
accumulate(await runTrustSet(client, alice, bob));
console.log('');

// [4] IOU payments — depend on trust line from [3]
accumulate(await runPaymentIou(client, alice, bob));
console.log('');

// [5–8] Independent of each other (but share wallets/funds)
accumulate(await runOffer (client, alice, bob));
console.log('');
accumulate(await runEscrow(client, alice, bob));
console.log('');
accumulate(await runCheck (client, alice, bob));
console.log('');
accumulate(await runNft   (client, alice, bob));

await client.disconnect();

const total = totals.passed + totals.failed + totals.skipped;
console.log(`\n${'═'.repeat(50)}`);
console.log(`Grand total: ${totals.passed}/${total} passed  |  ${totals.failed} failed  |  ${totals.skipped} skipped`);
if (totals.failed > 0) {
  console.log('Some tests failed — see ✗ lines above for details.');
  process.exit(1);
} else {
  console.log('All integration tests passed against XRPL Testnet.');
}
