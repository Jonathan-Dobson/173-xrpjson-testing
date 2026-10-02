/**
 * Shared helpers for the xrp-tx integration test suite.
 * Stateless utilities + a per-suite runner factory.
 */

/**
 * The ledger the integration suites run against.
 *
 * Defaults to XRPL Testnet. Override with XRPL_WSS to point the whole suite
 * at another network — devnet in particular, because it is the only public
 * network with the `Sponsor` amendment enabled (testnet has it off, so
 * amendment-gated families can only get a `temDISABLED` verdict there).
 *
 *   XRPL_WSS=wss://s.devnet.rippletest.net:51233 node integration/tests/15-....mjs
 */
export const TESTNET_WSS =
  process.env.XRPL_WSS ?? 'wss://s.altnet.rippletest.net:51233';
export const NETWORK_NAME = process.env.XRPL_WSS ? 'the XRPL_WSS target' : 'XRPL Testnet';
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

/**
 * Submit something that is EXPECTED to be rejected, and report whether it was.
 *
 * Needed because `submitAndWait` does not return uniformly on failure: it
 * throws for `tef*` results (tefBAD_AUTH, tefPAST_LEDGER_SEQ, …) and returns
 * normally for `tem*`/`tec*` ones. A test that just reads
 * `res.result.meta.TransactionResult` therefore blows up on exactly the
 * rejections it was written to observe.
 *
 * Returns `{ ok, result }`:
 *   - `ok: true`  → the ledger rejected it, as intended
 *   - `ok: false` → it unexpectedly succeeded; the caller should fail
 *
 * Any error that is NOT a tef rejection is rethrown, so a genuine bug in the
 * test still surfaces instead of being swallowed as "rejected".
 */
export async function expectRejected(submitFn) {
  try {
    const res = await submitFn();
    const result = res?.result?.meta?.TransactionResult;
    return { ok: result !== 'tesSUCCESS', result };
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (!/\btef[A-Z_]+\b/.test(msg)) throw e;
    return { ok: true, result: msg.split('\n')[0].trim() };
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
 * Extract the NFTokenID minted by a transaction.
 *
 * Deliberately does NOT use `extractCreatedIndex`: an NFToken is not created
 * as its own ledger entry. It is appended to an `NFTokenPage`, which shows up
 * as a Modified (or Created, for the first page) node, and the ID is the last
 * entry of `NFTokens`. Looking for `CreatedNode.LedgerEntryType === 'NFToken'`
 * finds nothing and yields undefined.
 */
export function extractNFTokenId(response) {
  const node = response.result.meta.AffectedNodes
    .find(n => n.ModifiedNode?.LedgerEntryType === 'NFTokenPage'
            || n.CreatedNode?.LedgerEntryType  === 'NFTokenPage');
  const page = node?.ModifiedNode?.FinalFields ?? node?.CreatedNode?.NewFields;
  return page?.NFTokens?.at(-1)?.NFToken?.NFTokenID;
}

/**
 * Extract the index of a newly created NFTokenOffer.
 *
 * Deliberately does NOT reuse `extractCreatedIndex`: an NFTokenOffer's
 * NewFields carry the *token's* NFTokenID, so the generic helper would hand
 * back the token id instead of the offer id. The offer index is what
 * NFTokenAcceptOffer / NFTokenCancelOffer take.
 */
export function extractOfferIndex(response) {
  const node = response.result.meta.AffectedNodes
    .find(n => n.CreatedNode?.LedgerEntryType === 'NFTokenOffer');
  return node?.CreatedNode?.LedgerIndex;
}

/** Current XRP balance of `address`, in drops, as a BigInt. */
export async function balanceDrops(client, address) {
  const res = await client.request({
    command: 'account_info',
    account: address,
    ledger_index: 'validated',
  });
  return BigInt(res.result.account_data.Balance);
}

/**
 * Reconnect the client if the socket has dropped.
 *
 * Long waits (notably ADM-12 waiting out the 256-ledger AccountDelete delay)
 * outlive an idle testnet WebSocket. Without this, the reconnect is attempted
 * implicitly by the next request and fails with "WebSocket is not open".
 * Returns true if a reconnect was performed.
 */
export async function ensureConnected(client) {
  const state = client.getWebsocket?.()?.readyState;
  // WebSocket.OPEN === 1
  if (state === undefined || state === 1) return false;
  await client.connect();
  return true;
}

/**
 * Poll an arbitrary async probe until it returns a truthy value.
 *
 * General sibling of `waitForAccountState`, for things that are not
 * account_data fields — e.g. reading an account's reserved tickets out of the
 * owner directory.
 */
export async function waitFor(
  probe,
  { timeoutMs = 30_000, intervalMs = 500, label = 'condition' } = {},
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

/**
 * Poll `account_info` until `predicate(accountData)` returns true.
 *
 * Needed because `submitAndWait` returning does NOT guarantee that a
 * subsequent `autofill` will observe the change. Setting a regular key and
 * immediately signing with it can race the account-state update and fail with
 * `tefBAD_AUTH` — the ledger still has the previous key at the moment it
 * validates the signature. This waits for the state instead of sleeping an
 * arbitrary amount.
 */
export async function waitForAccountState(
  client,
  address,
  predicate,
  { timeoutMs = 30_000, intervalMs = 500, label = 'account state' } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    const res = await client.request({
      command: 'account_info',
      account: address,
      ledger_index: 'validated',
    });
    last = res.result.account_data;
    if (predicate(last)) return last;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for ${label} on ${address}`,
      );
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
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

  async function runTest(name, fn, opts = {}) {
    const budgetMs = opts.timeoutMs ?? TIMEOUT_MS;
    try {
      await Promise.race([
        fn(),
        new Promise((_, rej) =>
          setTimeout(
            () => rej(new Error(`Timed out after ${budgetMs / 1000}s`)),
            budgetMs,
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
