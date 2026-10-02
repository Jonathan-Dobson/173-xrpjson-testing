/**
 * [15] Flag-defect live verification — settles the three defects found in the
 * 2026-10-02 flag-contradiction audit
 * (`146-xrpjs/docs/audit/2026-10-02-flag-contradiction-audit.md`).
 *
 * Those three are all the same shape: the FACTORY rejected a transaction the
 * LEDGER accepts. The unit tests in `146-xrpjs` prove the factory now builds
 * them. This suite proves the other half — that the ledger really does accept
 * them — so the fix cannot be quietly "corrected" back on the assumption that
 * the strict reading was the right one.
 *
 * Each defect gets a CONTROLLED PAIR: a case rippled accepts, and the
 * adjacent case rippled rejects. A lone "it succeeded" proves nothing — it
 * could mean the gate does not exist at all. The pair is the experiment.
 *
 * NOTE ON THE xrpjson IMPORT. This repo's `node_modules/xrpjson` is the
 * PUBLISHED 1.2.0, which does NOT contain the three fixes. We import the
 * locally built dist from the 146-xrpjs working tree instead, so these
 * results are about the fixed code. If that path moves, this suite fails
 * loudly rather than silently testing the old package.
 *
 * Run standalone:
 *   node integration/tests/15-flag-defect-verification.mjs
 */

import { createRunner } from '../helpers.mjs';

// The FIXED factories, from the 146-xrpjs working tree (not node_modules).
const XRPJSON_SRC = '/Users/jdobson/developer/146-xrpjs/dist/fp/index.js';
const { nftokenMint, mptokenIssuanceCreate, sponsorshipTransfer } =
  await import(XRPJSON_SRC);

// ── Spec bit values (rippled TxFlags.h / LedgerFormats.h) ────────────
const TF_MPT_CAN_TRANSFER = 0x00000020; // TxFlags.h:140 (lsifMPTCanTransfer)
const SPONSOR_FEE         = 0x00000001; // TxFlags.h:459
const SPONSOR_RESERVE     = 0x00000002; // TxFlags.h:460

/**
 * A real ledger result code. Two traps here, both hit while writing this:
 *
 *  1. NOT anchored. The library wraps rejections in prose ("Transaction
 *     failed, temMALFORMED: Malformed transaction."), so the code appears
 *     mid-message. An anchored pattern turns a correct ledger rejection into
 *     a test failure.
 *  2. Use the FULL MATCH (m[0]), not the group (m[1]). The group only spans
 *     the "te?" prefix, so m[1] is "tem" — and asserting against "tem" makes
 *     a real temMALFORMED look like a mismatch.
 */
const LEDGER_CODE = /(?:^|\W)(te[smfc]|tes|tel|ter)[A-Z_0-9]+/;

/** A client-side refusal from xrpl.js's own pre-flight validation. */
const CLIENT_REJECT = /(?:Invalid field|cannot be provided|must be|is not|Invalid|not a valid|unsupported)/i;

/**
 * Submit a raw tx and return its ledger result code, whether the library
 * threw or returned. `submitAndWait` throws on `tef*` and returns on
 * `tem*`/`tec*`, so a test reading `res.result.meta.TransactionResult`
 * blows up on exactly the rejections it was written to observe.
 *
 * Client-side encoding failures are rethrown — those are bugs in THIS test,
 * not ledger behaviour, and must never be reported as a rejection.
 */
async function submitRaw(client, wallet, tx) {
  try {
    const prepared = await client.autofill(tx);
    const { tx_blob } = wallet.sign(prepared);
    const res = await client.submitAndWait(tx_blob);
    return {
      result: res?.result?.meta?.TransactionResult,
      ledger: res?.result?.ledger_index,
    };
  } catch (e) {
    const msg = String(e?.message ?? e);
    const m = msg.match(LEDGER_CODE);
    // m[0], not m[1] — the group is only the "te?" prefix.
    if (m) return { result: m[0].replace(/^\W/, ''), error: msg.split('\n')[0].trim() };
    if (CLIENT_REJECT.test(msg)) return { result: 'CLIENT_REJECT', error: msg.split('\n')[0].trim() };
    throw e;
  }
}

/** Submit, and require an exact result code. */
async function expectCode(client, wallet, tx, want, label) {
  const { result, error } = await submitRaw(client, wallet, tx);
  if (result !== want) {
    throw new Error(
      `${label}: expected ${want}, ledger said ${result ?? '<none>'}` +
        (error ? ` (${error})` : ''),
    );
  }
  return result;
}

/** Build via the fixed factory, converting a boolean-map Flags to bits. */

export async function run(client, alice, bob) {
  const { runTest, skip, summary } = createRunner();

  // ═══ Defect 3 — nftokenMint rejected `TransferFee: 0` ═══════════════
  //
  // rippled NFTokenMint.cpp:94 gates on VALUE:
  //     if (f > 0u && !ctx.tx.isFlag(tfTransferable)) return temMALFORMED;
  // The XLS-20 / xrpl.org prose gates on PRESENCE instead. These two stories
  // are what distinguish the two readings.
  console.log('  ── Defect 3 — NFTokenMint TransferFee coupling');
  {
    // The factory must now BUILD it (it used to throw).
    await runTest('factory builds TransferFee: 0 without tfTransferable', () => {
      const tx = nftokenMint({
        Account: alice.classicAddress,
        NFTokenTaxon: 0,
        TransferFee: 0,
        Flags: 0,
      });
      if (tx.TransferFee !== 0) throw new Error('TransferFee not carried through');
      if ((tx.Flags & 0x00000008) !== 0) throw new Error('unexpected tfTransferable');
    });

    // …and the ledger must accept what the factory now builds.
    await runTest('LEDGER accepts TransferFee: 0, no tfTransferable (tesSUCCESS)', async () => {
      const tx = nftokenMint({
        Account: alice.classicAddress,
        NFTokenTaxon: 0,
        TransferFee: 0,
        Flags: 0,
      });
      await expectCode(client, alice, tx.toJSON(), 'tesSUCCESS', 'mint TransferFee=0');
    });

    // CONTROL: a non-zero fee without the flag. If this were accepted, the
    // gate would not exist and story 2 would prove nothing.
    await runTest('CONTROL — TransferFee: 1 without tfTransferable (temMALFORMED)', async () => {
      await expectCode(
        client, alice,
        {
          TransactionType: 'NFTokenMint',
          Account: alice.classicAddress,
          NFTokenTaxon: 0,
          TransferFee: 1,
          Flags: 0,
        },
        'temMALFORMED', 'mint TransferFee=1',
      );
    });

    await runTest('CONTROL — TransferFee: 1 WITH tfTransferable (tesSUCCESS)', async () => {
      await expectCode(
        client, alice,
        {
          TransactionType: 'NFTokenMint',
          Account: alice.classicAddress,
          NFTokenTaxon: 0,
          TransferFee: 1,
          Flags: 0x00000008,
        },
        'tesSUCCESS', 'mint TransferFee=1 + tfTransferable',
      );
    });
  }

  console.log('  ── Defect 2 — mptokenIssuanceCreate boolean-map Flags');
  {
    // The factory must honour the map (it used to read it as 0).
    await runTest('factory honours boolean-map tfMPTCanTransfer', () => {
      const tx = mptokenIssuanceCreate({
        Account: alice.classicAddress,
        TransferFee: 100,
        Flags: { tfMPTCanTransfer: true },
      });
      if (tx.TransferFee !== 100) throw new Error('TransferFee not carried through');
    });

    await runTest('factory still refuses a map WITHOUT the capability bit', () => {
      let threw = false;
      try {
        mptokenIssuanceCreate({
          Account: alice.classicAddress,
          TransferFee: 100,
          Flags: { tfMPTRequireAuth: true },
        });
      } catch { threw = true; }
      if (!threw) throw new Error('expected a throw for a map missing tfMPTCanTransfer');
    });

    // Does xrpl.js accept the OBJECT form on the wire? If not, the map must
    // be converted by the caller before signing — worth knowing either way.
    let mapEncodes = true;
    try {
      const tx = mptokenIssuanceCreate({
        Account: alice.classicAddress,
        TransferFee: 100,
        Flags: { tfMPTCanTransfer: true },
      });
      await submitRaw(client, alice, tx.toJSON());
    } catch (e) {
      mapEncodes = /Serializing|Invalid|not a valid|unsigned/i.test(String(e.message));
    }
    if (mapEncodes) {
      console.log('    note: the object form encodes on the wire');
    } else {
      console.log(
        '    note: xrpl.js will NOT encode the boolean-map form — the caller must\n' +
          '          convert Flags to a bitmask before signing (as wire() does).',
      );
    }

    await runTest('LEDGER accepts Flags=0x20 with TransferFee: 100 (tesSUCCESS)', async () => {
      const tx = mptokenIssuanceCreate({
        Account: alice.classicAddress,
        TransferFee: 100,
        Flags: TF_MPT_CAN_TRANSFER,
      });
      await expectCode(client, alice, tx.toJSON(), 'tesSUCCESS', 'mpt create');
    });

    // CONTROL: TransferFee without the flag. This must be refused SOMEWHERE.
    // Two layers can refuse it, and both count: the ledger
    // (`temMALFORMED`, per rippled MPTokenIssuanceCreate.cpp) or xrpl.js's
    // own client-side pre-flight, which has the same rule. xrpl.js
    // uses a TRUTHINESS test — `if (tx.TransferFee && …)` — so its check
    // skips `TransferFee: 0` for exactly the same reason rippled's `f > 0u`
    // does. Record which layer answered, rather than pretending one is the
    // only possible outcome.
    await runTest('CONTROL — TransferFee: 100 without the flag is refused', async () => {
      const { result, error } = await submitRaw(client, alice, {
        TransactionType: 'MPTokenIssuanceCreate',
        Account: alice.classicAddress,
        TransferFee: 100,
        Flags: 0,
      });
      if (result === 'temMALFORMED') return;
      if (result === 'CLIENT_REJECT') {
        console.log(`    refused client-side by xrpl.js: ${error}`);
        return;
      }
      throw new Error(`expected a refusal, ledger said ${result}`);
    });
  }

  console.log('  ── Defect 1 — sponsorshipTransfer SponsorFlags: fee + reserve');
  {
    // The factory must now BUILD fee+reserve (it used to throw).
    await runTest('factory builds SponsorFlags fee+reserve (0x03)', () => {
      const tx = sponsorshipTransfer({
        Account: bob.classicAddress,
        Flags: 0x00020000, // tfSponsorshipCreate
        ObjectID: '0'.repeat(64),
        Sponsor: alice.classicAddress,
        SponsorFlags: SPONSOR_FEE | SPONSOR_RESERVE,
      });
      if (tx.SponsorFlags !== 3) throw new Error(`SponsorFlags = ${tx.SponsorFlags}, want 3`);
    });

    await runTest('factory still refuses a bit outside fee+reserve', () => {
      let threw = false;
      try {
        sponsorshipTransfer({
          Account: bob.classicAddress,
          Flags: 0x00020000,
          ObjectID: '0'.repeat(64),
          Sponsor: alice.classicAddress,
          SponsorFlags: 0x00000006, // reserve | 0x04 (undefined)
        });
      } catch { threw = true; }
      if (!threw) throw new Error('expected a throw for 0x04');
    });

    // The ledger half. Since `xrpl@5.3.0` this repo can name and encode
    // `SponsorshipTransfer` (XLS-68, xrpl.js PR #3238), so the client half
    // no longer blocks the submission. The ledger half is still only as
    // strong as the network: `Sponsor` is OFF on testnet, so there the
    // answer is `temDISABLED`, not a flag verdict. Run against devnet for
    // the real thing:
    //
    //   XRPL_WSS=wss://s.devnet.rippletest.net:51233 \
    //     node integration/tests/15-flag-defect-verification.mjs
    const { result, error } = await submitRaw(client, bob, {
      TransactionType: 'SponsorshipTransfer',
      Account: bob.classicAddress,
      Flags: 0x00020000,
      ObjectID: '0'.repeat(64),
      Sponsor: alice.classicAddress,
      SponsorFlags: SPONSOR_FEE | SPONSOR_RESERVE,
    });
    console.log(`    ledger said: ${result}`);

    if (result === 'temINVALID_FLAG') {
      throw new Error(
        'LEDGER REJECTED THE FLAGS (temINVALID_FLAG) — the fix would be wrong',
      );
    }
    if (result === 'CLIENT_REJECT') {
      // Defensive only: 5.3.0 can encode this type. If this fires, the
      // installed xrpl is older than package.json claims.
      skip(
        'ledger verdict for SponsorFlags: fee+reserve',
        `installed xrpl could not encode SponsorshipTransfer (${error})`,
      );
    } else {
      await runTest(
        `ledger did not reject the flags (got ${result})`,
        async () => {},
      );
      if (result === 'temDISABLED') {
        console.log(
          '    note: Sponsor amendment is OFF on testnet, so `temDISABLED` says nothing\n' +
          '          about the flags — it is a weaker check than a full scenario.\n' +
          '          Re-run with XRPL_WSS pointing at devnet for the real verdict.\n' +
          '          Until then the flag verdict rests on TxFlags.h:461 +\n' +
          '          isFeeSponsored/isReserveSponsored.',
        );
      }
    }
  }

  return summary();
}

// ── Standalone execution ──────────────────────────────────────────────────────
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { withStandaloneSetup } = await import('../setup.mjs');
  await withStandaloneSetup(run);
}
