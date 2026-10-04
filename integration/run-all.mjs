/**
 * Run all integration test suites against XRPL Testnet.
 * Funds a single pair of wallets shared across all suites.
 *
 * Usage: node integration/run-all.mjs
 */

import { createClient, fundWallets } from './setup.mjs';
import { run as runPaymentXrp  } from './tests/01-payment-xrp.mjs';
import { run as runAccountSet  } from './tests/02-account-set.mjs';
import { run as runIOU         } from './tests/10-iou.mjs';
import { run as runTrustSet    } from './tests/03-trust-set.mjs';
import { run as runPaymentIou  } from './tests/04-payment-iou.mjs';
import { run as runOffer       } from './tests/05-offer.mjs';
import { run as runEscrow      } from './tests/06-escrow.mjs';
import { run as runCheck       } from './tests/07-check.mjs';
import { run as runNft         } from './tests/08-nft.mjs';
import { run as runMPToken     } from './tests/09-mptoken.mjs';
import { run as runCheckIou    } from './tests/11-check-iou.mjs';
import { run as runNftLifecycle} from './tests/12-nft-lifecycle.mjs';
import { run as runAccountAdmin} from './tests/13-account-admin.mjs';
import { run as runAmmDepositFlags } from './tests/14-amm-deposit-flags.mjs';
import { run as runFlagDefectVerification } from './tests/15-flag-defect-verification.mjs';

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

// [10] IOU — must run BEFORE TrustSet: the suite enables
// asfAllowTrustLineClawback on Bob, which requires zero trust lines.
// Running it first avoids `tecOWNERS` from the TrustSet that [3] does.
accumulate(await runIOU(client, alice, bob));
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
accumulate(await runNft     (client, alice, bob));
console.log('');
accumulate(await runMPToken (client, alice, bob));
console.log('');
accumulate(await runCheckIou(client, alice, bob));
console.log('');

// [12] NFT lifecycle — self-contained (mints its own tokens, funds its own
// broker), so it only has to run after Alice/Bob are funded.
accumulate(await runNftLifecycle(client, alice, bob));
console.log('');

// [14] AMM deposit flag contract — self-contained and non-destructive: it
// submits hand-built AMMDeposit transactions that are all rejected at preflight,
// so it creates no AMM and mutates no account state. Must still run before [13],
// which mutates Alice.
accumulate(await runAmmDepositFlags(client, alice, bob));
console.log('');

// [15] Flag-defect live verification — settles the three over-strict
// factories found by the 2026-10-02 flag-contradiction audit. Each defect
// gets a controlled pair: a case rippled accepts beside one it rejects, so a
// lone "it succeeded" cannot be mistaken for the gate having disappeared.
//
// NOTE: this suite imports the FIXED dist from the 175-xrpjson working tree,
// not this repo's published node_modules copy. It is the one suite that does,
// because the three fixes it verifies are not released yet.
accumulate(await runFlagDefectVerification(client, alice, bob));
console.log('');

// [13] Account admin — MUST be last. It mutates Alice's signing setup
// (regular key → removed, signer list → created → removed) and finally
// deletes a throwaway account. Both mutations are cleaned up by the suite
// itself, but running it last keeps the blast radius off every other suite.
accumulate(await runAccountAdmin(client, alice, bob));

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
