/**
 * IOU (Issued Currency) deep-dive test suite.
 *
 * Covers scenarios beyond the basics in 04-payment-iou:
 *   - Multiple currencies (3-letter + 20-byte hex currency codes)
 *   - NoRipple on a trust line (set before issuance when balance = 0)
 *   - Individual trust line freeze / unfreeze by issuer
 *   - Cross-currency payment routed through DefaultRipple
 *   - Clawback of issued tokens (requires asfAllowTrustLineClawback, set
 *     before any trust lines exist on the account)
 *
 * SETUP ORDER MATTERS — see comments throughout.
 */

import { xrpToDrops } from 'xrpl';
import {
  AccountSetTx,
  TrustSetTx,
  PaymentTx,
  OfferCreateTx,
  ClawbackTx,
  TrustSetFlags,
  AccountSetAsfFlags,
} from 'xrplt';
import { createRunner, assertSuccess, submitTx } from '../helpers.mjs';

function ica(currency, issuer, value) {
  return { currency, issuer, value };
}

async function getTrustLine(client, account, peer, currency) {
  const res = await client.request({
    command: 'account_lines',
    account,
    peer,
  });
  return res.result.lines.find(l => l.currency === currency) ?? null;
}

export async function run(client, alice, bob) {
  const { runTest, summary } = createRunner();
  console.log('[10] IOU — trust lines, freeze, NoRipple, cross-currency, clawback');

  // ── 1. Account-level flags on Bob — MUST come before any trust lines ─────
  // asfAllowTrustLineClawback: once set, cannot be unset; requires zero trust lines
  // asfDefaultRipple: lets payments ripple through Bob (needed for cross-currency)
  await runTest('Bob enables AllowTrustLineClawback (no trust lines yet)', async () => {
    const tx = new AccountSetTx({
      Account: bob.classicAddress,
      SetFlag: AccountSetAsfFlags.asfAllowTrustLineClawback,
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, bob));
  });

  await runTest('Bob enables DefaultRipple (required for cross-currency routing)', async () => {
    const tx = new AccountSetTx({
      Account: bob.classicAddress,
      SetFlag: AccountSetAsfFlags.asfDefaultRipple,
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, bob));
  });

  // ── 2. Open trust lines ──────────────────────────────────────────────────
  await runTest('Alice opens USD and EUR trust lines to Bob', async () => {
    for (const currency of ['USD', 'EUR']) {
      const tx = new TrustSetTx({
        Account:     alice.classicAddress,
        LimitAmount: ica(currency, bob.classicAddress, '50000'),
      });
      tx.validate();
      assertSuccess(await submitTx(client, tx, alice));
    }
  });

  await runTest('Alice opens a 20-byte hex currency trust line to Bob', async () => {
    // "TST" padded to 20 bytes in hex
    const hexCurrency = '5453540000000000000000000000000000000000';
    const tx = new TrustSetTx({
      Account:     alice.classicAddress,
      LimitAmount: ica(hexCurrency, bob.classicAddress, '1000'),
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, alice));
  });

  // ── 3. NoRipple — set while balance is 0, BEFORE any issuance ───────────
  await runTest('Alice sets NoRipple on her EUR trust line (balance = 0)', async () => {
    // Alice sets NoRipple on her own side of the trust line.
    // XRPL requires balance = 0 (in Alice's direction) at the time of setting.
    const tx = new TrustSetTx({
      Account:     alice.classicAddress,
      LimitAmount: ica('EUR', bob.classicAddress, '50000'),
      Flags:       TrustSetFlags.tfSetNoRipple,
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, alice));
  });

  await runTest('verify NoRipple is set on Alice EUR trust line', async () => {
    const line = await getTrustLine(client, alice.classicAddress, bob.classicAddress, 'EUR');
    if (!line) throw new Error('EUR trust line not found');
    if (!line.no_ripple) throw new Error(`Expected no_ripple=true, got: ${JSON.stringify(line)}`);
  });

  await runTest('Alice clears NoRipple on her EUR trust line', async () => {
    const tx = new TrustSetTx({
      Account:     alice.classicAddress,
      LimitAmount: ica('EUR', bob.classicAddress, '50000'),
      Flags:       TrustSetFlags.tfClearNoRipple,
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, alice));
  });

  // ── 4. Issuance ──────────────────────────────────────────────────────────
  await runTest('Bob issues 10 000 USD and 5 000 EUR to Alice', async () => {
    for (const [currency, value] of [['USD', '10000'], ['EUR', '5000']]) {
      const tx = new PaymentTx({
        Account:     bob.classicAddress,
        Destination: alice.classicAddress,
        Amount:      ica(currency, bob.classicAddress, value),
      });
      tx.validate();
      assertSuccess(await submitTx(client, tx, bob));
    }
  });

  // ── 5. Carol — needed for freeze + cross-currency tests ──────────────────
  let carol;

  await runTest('Carol opens USD and EUR trust lines to Bob', async () => {
    ({ wallet: carol } = await client.fundWallet());
    for (const currency of ['USD', 'EUR']) {
      const tx = new TrustSetTx({
        Account:     carol.classicAddress,
        LimitAmount: ica(currency, bob.classicAddress, '50000'),
      });
      tx.validate();
      assertSuccess(await submitTx(client, tx, carol));
    }
  });

  await runTest('Bob issues 1 000 EUR to Carol', async () => {
    if (!carol) throw new Error('No carol from prior test');
    const tx = new PaymentTx({
      Account:     bob.classicAddress,
      Destination: carol.classicAddress,
      Amount:      ica('EUR', bob.classicAddress, '1000'),
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, bob));
  });

  // ── 6. Freeze ────────────────────────────────────────────────────────────
  // Bob (issuer) freezes Alice's USD trust line from his side.
  // Frozen trust lines still allow transfers BACK to the issuer but block
  // all other paths — Alice → Carol should fail.
  await runTest('Bob freezes Alice USD trust line (issuer-side freeze)', async () => {
    const tx = new TrustSetTx({
      Account:     bob.classicAddress,
      // LimitAmount.issuer = counterparty (Alice) when Bob is modifying his side
      LimitAmount: ica('USD', alice.classicAddress, '0'),
      Flags:       TrustSetFlags.tfSetFreeze,
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, bob));
  });

  await runTest('frozen trust line blocks Alice from sending USD to Carol', async () => {
    if (!carol) throw new Error('No carol from prior test');
    // Route Alice→Bob→Carol is blocked because Alice's trust line is frozen
    const tx = new PaymentTx({
      Account:     alice.classicAddress,
      Destination: carol.classicAddress,
      Amount:      ica('USD', bob.classicAddress, '100'),
    });
    const res = await submitTx(client, tx, alice);
    const result = res?.result?.meta?.TransactionResult;
    if (result === 'tesSUCCESS') {
      throw new Error('Expected freeze error, but payment succeeded');
    }
  });

  await runTest('Bob unfreezes Alice USD trust line', async () => {
    const tx = new TrustSetTx({
      Account:     bob.classicAddress,
      LimitAmount: ica('USD', alice.classicAddress, '0'),
      Flags:       TrustSetFlags.tfClearFreeze,
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, bob));
  });

  await runTest('Alice can send USD to Carol after unfreeze', async () => {
    if (!carol) throw new Error('No carol from prior test');
    const tx = new PaymentTx({
      Account:     alice.classicAddress,
      Destination: carol.classicAddress,
      Amount:      ica('USD', bob.classicAddress, '100'),
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, alice));
  });

  // ── 7. Cross-currency payment via DefaultRipple ──────────────────────────
  // Alice (holds EUR) pays EUR to Carol — routed through Bob who has DefaultRipple.
  // No explicit path needed: Bob's DefaultRipple flag enables this automatically.
  await runTest('Alice pays 200 EUR to Carol (cross-currency via DefaultRipple)', async () => {
    if (!carol) throw new Error('No carol from prior test');
    const tx = new PaymentTx({
      Account:     alice.classicAddress,
      Destination: carol.classicAddress,
      Amount:      ica('EUR', bob.classicAddress, '200'),
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, alice));
  });

  // ── 8. DEX offer bridging USD ↔ EUR ─────────────────────────────────────
  await runTest('Bob posts a DEX offer: sell 500 USD for 450 EUR', async () => {
    const tx = new OfferCreateTx({
      Account:   bob.classicAddress,
      TakerPays: ica('EUR', bob.classicAddress, '450'),
      TakerGets: ica('USD', bob.classicAddress, '500'),
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, bob));
  });

  // ── 9. Clawback ──────────────────────────────────────────────────────────
  // asfAllowTrustLineClawback was enabled in step 1, so this is now permitted.
  // ClawbackTx.Amount.issuer = the holder (Alice), not the issuer (Bob).
  await runTest('Bob claws back 500 EUR from Alice', async () => {
    const tx = new ClawbackTx({
      Account: bob.classicAddress,
      Amount:  ica('EUR', alice.classicAddress, '500'),
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, bob));
  });

  await runTest('Alice EUR balance reflects the clawback', async () => {
    const line = await getTrustLine(client, alice.classicAddress, bob.classicAddress, 'EUR');
    if (!line) throw new Error('EUR trust line not found');
    const balance = parseFloat(line.balance);
    // Issued 5000, paid 200 to Carol, clawed back 500 → expect 4300
    if (balance < 4200 || balance > 4400) {
      throw new Error(`Unexpected EUR balance: ${balance} (expected ~4300)`);
    }
  });

  return summary();
}

// ── Standalone execution ──────────────────────────────────────────────────────
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { withStandaloneSetup } = await import('../setup.mjs');
  await withStandaloneSetup(run);
}
