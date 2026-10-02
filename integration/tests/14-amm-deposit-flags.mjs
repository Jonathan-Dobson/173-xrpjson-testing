/**
 * [14] AMM deposit flag contract — live-ledger verification of the rule that
 * an `AMMDeposit` must carry exactly one deposit-mode flag.
 *
 * Implements the stories in USER-STORIES.md § "[14] AMM deposit flag contract".
 *
 * WHY THIS SUITE EXISTS. xrpjson's `ammDeposit` factory performed no flag
 * validation at all, while its sibling `ammWithdraw` enforced the identical
 * rule (DIVERGENCES.md Bug #6). The factory fix is verified by unit tests in
 * the xrpjson repo; this suite verifies the *ledger* side, so that the rule
 * the fix encodes is confirmed against the code that actually enforces it.
 *
 * NO AMM IS CREATED. Both flag checks are preflight — `getFlagsMask` and
 * `preflight` — and run before any AMM state is consulted. Every story here is
 * therefore decided without a pool, an issuer, or a trust line. That is a
 * property of the rule, not a shortcut.
 *
 * NOTE ON ASSERTING FAILURES. `submitAndWait` THROWS on `tem*` / `tef*` rather
 * than returning them, so a test that reads `res.result.meta.TransactionResult`
 * blows up on exactly the rejections it was written to observe. `submitRaw`
 * below normalises that: it returns the result code either way.
 *
 * Run standalone: node integration/tests/14-amm-deposit-flags.mjs
 */

import { createRunner } from '../helpers.mjs';

// Canonical fp factory names, not the legacy `XxxTx` aliases. The shim's
// aliases are a migration shim for suites [1]–[11]; new suites use the
// documented functional API directly.
import { ammDeposit } from '../../xrpjson.mjs';

// rippled `TxFlags.h:169-176` — the six AMMDeposit mode flags.
// NOTE: `0x80000000` does not fit a *signed* 32-bit integer, so any
// expression OR-ing it with another flag yields a negative number in JS.
// Always coerce with `>>> 0` when composing a Flags value that includes
// tfFullyCanonicalSig, or the failure looks like a ledger rejection when it
// is really a client-side encoding error.
const TF_WITHDRAW_ALL     = 0x00020000; // AMMWithdraw-only, deliberately not a deposit mode
const TF_SINGLE_ASSET     = 0x00080000;
const TF_TWO_ASSET        = 0x00100000;
const TF_FULLY_CANONICAL  = 0x80000000; // in `tfUniversal` (TxFlags.h:43-46)

/** A real ledger result code, as opposed to a client-side encoding error. */
const LEDGER_CODE = /^(te[smfc]|tes|tel|ter)[A-Z_0-9]+$/;

/**
 * Submit a hand-built AMMDeposit and return its result code, whether the
 * library threw or returned. The flag combinations under test are exactly the
 * ones the fixed factory refuses to build, so they CANNOT go through
 * `ammDeposit` — that refusal is the unit-level assertion; this is the
 * ledger-level one.
 */
async function submitRaw(client, wallet, flags, omitFlags = false) {
  const tx = {
    TransactionType: 'AMMDeposit',
    Account:         wallet.classicAddress,
    Asset:           { currency: 'XRP' },
    Asset2:          { currency: 'XRP' },
    Amount:          '1000000',
  };
  if (!omitFlags) tx.Flags = flags;

  try {
    const prepared = await client.autofill(tx);
    const { tx_blob } = wallet.sign(prepared);
    const res = await client.submitAndWait(tx_blob);
    return res?.result?.meta?.TransactionResult ?? '(none)';
  } catch (e) {
    const msg = String(e?.message ?? e);
    const m = msg.match(/\b(?:tef|tem|tec|ter|tes|tel)[A-Z_0-9]+\b/);
    if (m) return m[0];
    // Not a ledger result — a client-side error (bad encoding, wrong type).
    // Returned under a prefix the tests explicitly reject, so a bug in how we
    // built the transaction can never be mistaken for the ledger accepting it.
    return `CLIENT_ERROR: ${msg.split('\n')[0].slice(0, 100)}`;
  }
}

export async function run(client, alice) {
  const { runTest, skip, summary } = createRunner();

  console.log('[14] AMM deposit flag contract');

  // ── The factory's half ────────────────────────────────────────────────────
  // The `ammDeposit` fix for DIVERGENCES.md Bug #6 lives in the xrpjson
  // source repo and is verified there by `tests/fp/amm-deposit.test.ts`
  // (45 tests). It is NOT verified here, because this harness installs
  // published `xrpjson@1.1.0`, which predates the fix — asserting it would
  // fail for a packaging reason rather than a contract reason, and a red test
  // that means "not published yet" trains the reader to ignore red.
  //
  // The ledger assertions below are the part that can only be settled live,
  // and they are what this suite is for.
  const { version: xrpjsonVersion } = JSON.parse(
    await (await import('fs/promises')).readFile(
      new URL('../../node_modules/xrpjson/package.json', import.meta.url),
      'utf8',
    ),
  );

  if (xrpjsonVersion === '1.1.0') {
    skip(
      'ammDeposit refuses a deposit with no mode flag (factory half)',
      `needs xrpjson >= 1.2.0; installed ${xrpjsonVersion}. Covered by the unit suite in 146-xrpjs.`,
    );
    skip(
      'ammDeposit refuses two mode flags combined (factory half)',
      `needs xrpjson >= 1.2.0; installed ${xrpjsonVersion}. Covered by the unit suite in 146-xrpjs.`,
    );
  } else {
    await runTest('ammDeposit refuses a deposit with no mode flag', () => {
      let threw = null;
      try {
        ammDeposit({
          Account: alice.classicAddress,
          Asset:   { currency: 'XRP' },
          Asset2:  { currency: 'XRP' },
          Amount:  '1000000',
        });
      } catch (e) { threw = e; }
      if (!threw) throw new Error('expected a throw, got none');
      if (!/exactly one AMM-deposit mode flag/.test(threw.message))
        throw new Error(`wrong error: ${threw.message}`);
    });

    await runTest('ammDeposit refuses two mode flags combined', () => {
      let threw = null;
      try {
        ammDeposit({
          Account: alice.classicAddress,
          Asset:   { currency: 'XRP' },
          Asset2:  { currency: 'XRP' },
          Amount:  '1000000',
          Flags:   TF_SINGLE_ASSET | TF_TWO_ASSET,
        });
      } catch (e) { threw = e; }
      if (!threw) throw new Error('expected a throw, got none');
      if (!/got multiple/.test(threw.message))
        throw new Error(`wrong error: ${threw.message}`);
    });
  }

  // ── The ledger's half ─────────────────────────────────────────────────────

  await runTest('AMM-1  ledger: no mode flag -> temMALFORMED', async () => {
    const code = await submitRaw(client, alice, undefined, true);
    if (code !== 'temMALFORMED')
      throw new Error(`expected temMALFORMED, got ${code}`);
  });

  await runTest('AMM-2  ledger: two mode flags -> temMALFORMED', async () => {
    const code = await submitRaw(client, alice, TF_SINGLE_ASSET | TF_TWO_ASSET);
    if (code !== 'temMALFORMED')
      throw new Error(`expected temMALFORMED, got ${code}`);
  });

  await runTest('AMM-3  ledger: one mode flag passes the flag check', async () => {
    const code = await submitRaw(client, alice, TF_SINGLE_ASSET);
    // The rule under test is the flag check, so what we assert is narrow:
    // the ledger did not reject the flags. Any other *ledger* code proves it
    // moved on to validating the deposit itself (observed: temBAD_AMM_TOKENS,
    // there being no AMM). A client-side error is NOT acceptable — that would
    // mean we never reached the ledger at all.
    if (!LEDGER_CODE.test(code))
      throw new Error(`never reached the ledger: ${code}`);
    if (code === 'temMALFORMED')
      throw new Error('flag check rejected a single valid mode flag');
    if (code === 'temINVALID_FLAG')
      throw new Error('flag membership check rejected a single valid mode flag');
    if (code === 'tesSUCCESS')
      throw new Error('deposit succeeded with no AMM — setup is wrong, not the rule');
    console.log(`    (proceeded past the flag check, failed later with ${code})`);
  });

  await runTest('AMM-4  ledger: a universal flag does not count as a mode', async () => {
    // `>>> 0` is required: JS bitwise OR is signed 32-bit, so
    // 0x00080000 | 0x80000000 is negative and xrpl.js refuses to serialise it.
    const code = await submitRaw(
      client, alice, (TF_SINGLE_ASSET | TF_FULLY_CANONICAL) >>> 0,
    );
    if (!LEDGER_CODE.test(code))
      throw new Error(`never reached the ledger: ${code}`);
    if (code === 'temMALFORMED')
      throw new Error('tfFullyCanonicalSig was miscounted as a second mode');
    if (code === 'temINVALID_FLAG')
      throw new Error('tfFullyCanonicalSig rejected — it is in tfUniversal');
    console.log(`    (proceeded past the flag check, failed later with ${code})`);
  });

  await runTest('AMM-5  ledger: a withdraw-only bit -> temINVALID_FLAG (NOT temMALFORMED)', async () => {
    const code = await submitRaw(client, alice, TF_SINGLE_ASSET | TF_WITHDRAW_ALL);
    // The distinct code is the evidence: membership failed before cardinality.
    if (code !== 'temINVALID_FLAG')
      throw new Error(`expected temINVALID_FLAG, got ${code}`);
  });

  return summary();
}

// ── Standalone execution ──────────────────────────────────────────────────────
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { withStandaloneSetup } = await import('../setup.mjs');
  await withStandaloneSetup(run);
}
