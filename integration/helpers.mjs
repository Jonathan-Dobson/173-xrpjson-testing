/**
 * Shared helpers for the xrp-tx integration test suite.
 * Stateless utilities + a per-suite runner factory.
 */

export const TESTNET_WSS = 'wss://s.altnet.rippletest.net:51233';
export const TIMEOUT_MS  = 90_000;

/** Current time as an XRPL epoch integer (seconds since 1 Jan 2000). */
export function xrplNow() {
  return Math.floor(Date.now() / 1000) - 946684800;
}

/**
 * Autofill, sign, and submit a transaction built with xrpjson.
 * Returns the full submitAndWait() response.
 */
export async function submitTx(client, txObj, wallet) {
  const prepared = await client.autofill(txObj.toJSON());
  const { tx_blob } = wallet.sign(prepared);
  return client.submitAndWait(tx_blob);
}

/** Throws if the response does not indicate tesSUCCESS. */
export function assertSuccess(response) {
  const result = response?.result?.meta?.TransactionResult;
  if (result !== 'tesSUCCESS') {
    throw new Error(`Expected tesSUCCESS, got: ${result}`);
  }
}

/** Extract the LedgerIndex of a newly created ledger entry by type. */
export function extractCreatedIndex(response, ledgerEntryType) {
  const node = response.result.meta.AffectedNodes
    .find(n => n.CreatedNode?.LedgerEntryType === ledgerEntryType);
  return node?.CreatedNode?.NewFields?.CheckID
      ?? node?.CreatedNode?.NewFields?.NFTokenID
      ?? node?.CreatedNode?.LedgerIndex;
}

/**
 * Creates a per-suite test runner.
 * Returns { runTest, skip, summary }.
 *
 * summary() prints the suite totals and returns { passed, failed, skipped }.
 */
export function createRunner() {
  let passed = 0, failed = 0, skipped = 0;

  function log(symbol, name, detail = '') {
    console.log(detail
      ? `  ${symbol} ${name}\n    ${detail}`
      : `  ${symbol} ${name}`);
  }

  async function runTest(name, fn) {
    try {
      await Promise.race([
        fn(),
        new Promise((_, rej) =>
          setTimeout(
            () => rej(new Error(`Timed out after ${TIMEOUT_MS / 1000}s`)),
            TIMEOUT_MS,
          ),
        ),
      ]);
      log('✓', name);
      passed++;
    } catch (e) {
      log('✗', name, e.message);
      failed++;
    }
  }

  function skip(name, reason) {
    log('○', name, `skipped — ${reason}`);
    skipped++;
  }

  function summary() {
    const total = passed + failed + skipped;
    console.log(`  ── ${passed}/${total} passed  |  ${failed} failed  |  ${skipped} skipped`);
    return { passed, failed, skipped };
  }

  return { runTest, skip, summary };
}
