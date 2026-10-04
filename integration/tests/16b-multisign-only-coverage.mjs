/**
 * [16b] Multisign-only account — coverage.
 *
 * Implements the Category 1 table in USER-STORIES.md: the transaction types
 * that provably work on an account whose master key is disabled, with no
 * regular key, controlled only by a 2-of-3 quorum.
 *
 * The value here is the LIST, not the individual assertions. A run that passes
 * produces "N of these work" — and 16c produces "M of these do not, each for
 * a named reason with a recorded result code". Together they are a
 * specification. Neither half is useful alone.
 *
 * Consumes the account built by 16a. Must run BEFORE 16d, which re-enables the
 * master key and invalidates the premise of every story here.
 *
 *   node integration/tests/16b-multisign-only-coverage.mjs
 *
 * ## This suite is NOT idempotent, and cannot be
 *
 * It accumulates ledger objects on the shared restricted account every time it
 * runs — escrows, payment channels, tickets, MPT issuances, credentials, DIDs.
 * Nothing here cleans up, because the objects ARE the evidence: 16b's claim is
 * that these types work for this account, and deleting them would delete the
 * proof. The cost is that the account's owner count climbs (28 objects and
 * ~79 XRP on the run that found this), and owner reserve is charged on every
 * one. Eventually `AMMCreate` — which funds its pool from the account's own
 * balance — will answer `tecUNFUNDED_AMM` for a wallet that is merely poorer
 * than the test assumes.
 *
 * The fix when that happens is to re-run 16a, which mints a fresh account. That
 * is a one-way door by design, so it is a real cost, not an incantation.
 */

import { Wallet, xrpToDrops, multisign } from 'xrpl';
import {
  payment,
  trustSet,
  offerCreate,
  offerCancel,
  escrowCreate,
  escrowFinish,
  escrowCancel,
  checkCreate,
  checkCash,
  checkCancel,
  nftokenMint,
  nftokenCreateOffer,
  nftokenCancelOffer,
  paymentChannelCreate,
  paymentChannelClaim,
  paymentChannelFund,
  ticketCreate,
  depositPreauth,
  accountSet,
  ammCreate,
  mptokenIssuanceSet,
  credentialCreate,
  didSet,
} from '../../xrpjson.mjs';
import {
  createRunner,
  assertSuccess,
  submitMultisigned,
  balanceDrops,
  ensureConnected,
  extractCreatedIndex,
  extractMPTokenIssuanceId,
  extractNFTokenId,
  extractOfferIndex,
  requireCreatedIndex,
  waitFor,
  waitForAccountState,
  xrplNow,
} from '../helpers.mjs';
import { requireState } from '../multisign-only-state.mjs';
import { submitNoWait } from '../no-wait.mjs';

const XRP = (n) => xrpToDrops(n);
const IOU = {
  currency: 'USD',
  issuer: null, // filled from the recipient at runtime
  // Deliberately far more than anything this suite moves. The IOU Payment
  // below used to send this whole figure straight back to the issuer, which
  // left the account holding ZERO of the very currency AMMCreate then tried to
  // deposit — and the AMM answered terNO_RIPPLE, a correct ledger answer about
  // an account with no balance. Issuing generously and paying back a small
  // amount keeps a float on the trust line for the AMM deposit.
  value: '1000000',
};
// What the restricted account actually returns to the issuer. Small on
// purpose — see the note on IOU.value.
const IOU_RETURNED = '10';

export async function run(client, alice, bob) {
  const { runTest, skip, summary } = createRunner();
  console.log('[16b] Multisign-only — coverage of the transaction types that work');

  const state = requireState(import.meta.url);
  if (!state.ok) {
    console.log('');
    skip('[16b] all stories', state.reason);
    return summary();
  }
  const { account, recipient, recipientSeed, signers } = state.ctx;
  const [s1, s2] = signers.map((s) => Wallet.fromSeed(s.seed));
  // The recipient is an ordinary account and must act AS ITSELF — issuing an
  // IOU, cashing a check addressed to it. Signing those with alice produced a
  // signature mismatch, which read as a timeout and then as tecPATH_DRY.
  const rcpt = recipientSeed ? Wallet.fromSeed(recipientSeed) : null;
  IOU.issuer = recipient;

  console.log(`  Account: ${account}`);
  console.log(`  Recipient: ${recipient}`);
  console.log('');

  // ── Repair: clear a stray DestinationTag requirement ────────────────
  //
  // Runs unconditionally and first, because the recipient is shared state
  // that outlives this suite, and a previous run of this file left it
  // broken. Escrow, Checks and PaymentChannels all name the recipient as
  // their destination, so a `lsfRequireDestTag` on it makes every one of
  // them answer `tecDST_TAG_NEEDED` — six failures that all look like
  // factory bugs and are none of them.
  //
  // The flag came from an earlier draft of the AMM precondition below,
  // which passed `Flags: 0x00010000`. That is the legal `tfRequireDestTag`
  // bit, so the transaction SUCCEEDED and changed real account state.
  // Nothing errored. See DIVERGENCES.md Bug #S13.
  //
  // `ClearFlag` takes an asf* index — asfRequireDest = 1. Read the flag
  // first so a clean account does not pay for a pointless transaction.
  {
    const info = await client.request({
      command: 'account_info', account: recipient, ledger_index: 'validated',
    });
    if (info.result.account_data.Flags & 0x00020000) {
      console.log('  repair: clearing a stray lsfRequireDestTag on the recipient');
      // `rcpt`, not a fresh `Wallet.fromSeed`. Two shapes are in play and they
      // are not the same: `client.fundWallet()` resolves to `{ wallet }`,
      // while `Wallet.fromSeed()` returns a Wallet directly. Destructuring the
      // latter as `{ wallet }` yields `undefined`, and submitAndWait then
      // fails with "Wallet must be provided" — which reads as a signing
      // problem and is a one-word typo.
      assertSuccess(await client.submitAndWait(
        accountSet({ Account: recipient, ClearFlag: 1 }), { wallet: rcpt },
      ));
    }
  }
  console.log('');

  /**
   * Autofill for a quorum signature set, combine, submit, and assert success.
   * `count` is the signature count autofill must price for — it is not
   * optional, and it is not the same as the number of wallets signing.
   */
  async function submitQuorum(txObj, count = 2) {
    txObj.validate();
    return submitMultisigned(client, txObj.toJSON(), [s1, s2], { count });
  }

  /**
   * Sign and submit with alice/bob instead — they are ordinary accounts.
   *
   * The explicit LastLedgerSequence window matters here for the same reason it
   * does for the quorum path: these calls sit behind tests that can stall, and
   * autofill's ~20-ledger default gets consumed. The first run had CheckCash
   * fail with an expiry, which reads as a check problem and is not one.
   */
  async function submitAs(wallet, txObj) {
    txObj.validate();
    const lc = await client.request({ command: 'ledger_current' });
    const prepared = await client.autofill({
      ...txObj.toJSON(),
      LastLedgerSequence: lc.result.ledger_current_index + 60,
    });
    const { tx_blob } = wallet.sign(prepared);
    return client.submitAndWait(tx_blob);
  }

  /**
   * Quorum-submit WITHOUT waiting, returning the synchronous engine result.
   *
   * Used for the amendment-gated families, where a disabled amendment answers
   * `temDISABLED` immediately. `submitAndWait` would instead sit polling a
   * transaction the ledger has already decided about — and for a
   * never-validating type, block for the whole window before reporting an
   * expiry that says nothing about amendments.
   */
  async function submitQuorumNoWait(txObj, count = 2) {
    const lc = await client.request({ command: 'ledger_current' });
    const prepared = await client.autofill(
      { ...txObj.toJSON(), LastLedgerSequence: lc.result.ledger_current_index + 40 }, count,
    );
    const partials = [s1, s2].map((w) => w.sign(prepared, w.classicAddress).tx_blob);
    const { code } = await submitNoWait(client, multisign(partials));
    return String(code);
  }

  // ── Payments ───────────────────────────────────────────────────────
  console.log('  ── Payments ──');

  await runTest('Payment (XRP) — the baseline every other authority check assumes', async () => {
    const before = await balanceDrops(client, recipient);
    assertSuccess(await submitQuorum(
      payment({ Account: account, Destination: recipient, Amount: XRP('1') }),
    ));
    const after = await balanceDrops(client, recipient);
    if (after !== before + BigInt(XRP('1'))) {
      throw new Error(`recipient got ${after - before} drops, expected ${XRP('1')}`);
    }
  });

  // The recipient issues an IOU to the restricted account, which already has
  // a trust line to it — so TrustSet must come FIRST.
  //
  // The earlier ordering issued the IOU to alice, who holds no trust line for
  // it, so rippled had no path to a recipient that could hold USD and answered
  // tecPATH_DRY. That reads as "the quorum cannot send IOU" when it means
  // "nowhere to put it".
  await runTest('TrustSet — the restricted account opens a trust line', async () => {
    assertSuccess(await submitQuorum(trustSet({
      Account:     account,
      LimitAmount: { currency: IOU.currency, issuer: IOU.issuer, value: '1000000' },
    })));
  });

  await runTest('setup: recipient issues an IOU to the restricted account', async () => {
    if (!rcpt) throw new Error('no recipientSeed in the [16] state — re-run 16a');
    // `.classicAddress` matters: `alice` is a Wallet, and passing the object
    // where the factory wants an address string fails as "missing or invalid
    // Destination". And the sender must be the RECIPIENT — it is the issuer.
    assertSuccess(await submitAs(rcpt, payment({
      Account:     recipient,
      Destination: account,
      Amount:      { currency: IOU.currency, issuer: IOU.issuer, value: '1000' },
    })));
  });

  await runTest('Payment (IOU) — moves value that is not the account\'s own XRP', async () => {
    // Spelled out rather than passing `IOU` whole — sending the full
    // issuance back to the issuer leaves nothing on the trust line for the
    // AMM deposit later in this suite.
    assertSuccess(await submitQuorum(payment({
      Account:     account,
      Destination: recipient,
      Amount:      { currency: IOU.currency, issuer: IOU.issuer, value: IOU_RETURNED },
    })));
  });

  // ── DEX ────────────────────────────────────────────────────────────
  console.log('\n  ── DEX ──');

  let offerSequence;
  await runTest('OfferCreate — places an offer into the order book', async () => {
    const res = await submitQuorum(offerCreate({
      Account:   account,
      TakerPays: { currency: IOU.currency, issuer: IOU.issuer, value: '2' },
      TakerGets: XRP('1'),
    }));
    assertSuccess(res);
    // Read the sequence off the response rather than deriving it from
    // account state — the derivation races propagation and surfaces as a
    // confusing ter. This is the same pattern suite [5] uses.
    offerSequence = res.result.tx_json.Sequence;
  });

  await runTest('OfferCancel — withdraws it again', async () => {
    if (!offerSequence) throw new Error('No offerSequence from the prior test');
    assertSuccess(await submitQuorum(offerCancel({
      Account:       account,
      OfferSequence: offerSequence,
    })));
  });

  // ── Escrow ─────────────────────────────────────────────────────────
  console.log('\n  ── Escrow ──');

  let escrowSequence;
  let escrowCancelAfter = 0;
  await runTest('EscrowCreate — locks funds under a condition', async () => {
    const res = await submitQuorum(escrowCreate({
      Account:     account,
      Destination: recipient,
      Amount:      XRP('1'),
      // Three rules constrain these two times, and until the third was found
      // this test failed twice for two unrelated-looking reasons.
      //
      //   1. `FinishAfter` must be STRICTLY LESS THAN `CancelAfter`
      //      (escrow-create.ts:33-39, citing escrowcreate.md). Getting this
      //      backwards fails at CONSTRUCTION, not on the ledger.
      //   2. The SOURCE is the authorised canceller only once `CancelAfter`
      //      has passed (escrow-cancel.ts:5-6).
      //   3. rippled REFUSES TO CREATE an escrow whose FinishAfter OR
      //      CancelAfter has already elapsed — `EscrowCreate::doApply`,
      //      EscrowCreate.cpp:430-434:
      //          if (ctx_.tx[~sfCancelAfter]  && after(closeTime, …CancelAfter))
      //              return tecNO_PERMISSION;
      //          if (ctx_.tx[~sfFinishAfter] && after(closeTime, …FinishAfter))
      //              return tecNO_PERMISSION;
      //
      // Rules 1+2+3 together make a fresh escrow uncancellable by its source:
      // cancelling needs CancelAfter < now, but creating needs
      // CancelAfter > now. The two cannot both hold. The only way the quorum
      // is the authorised canceller is to create the escrow and then WAIT for
      // its own CancelAfter to elapse.
      //
      // So both times are set just ahead, and the cancel story below sleeps
      // past CancelAfter before submitting. Two earlier attempts each produced
      // a tecNO_PERMISSION that read like "the quorum cannot cancel":
      //   - CancelAfter two days out  -> source is not yet the canceller.
      //   - both times in the past    -> rippled refuses to CREATE it.
      // Same code, opposite causes, which is why this spells out all three.
      FinishAfter: xrplNow() + 5,
      CancelAfter:  xrplNow() + 15,
    }));
    assertSuccess(res);
    escrowCancelAfter = xrplNow() + 15;

    // The Escrow object's OWN Sequence is what EscrowCancel wants as
    // OfferSequence. Neither `tx_json.Sequence` nor `account_objects[0]` is
    // reliable here: the account accumulates escrows across runs, so
    // positional lookup picks up a stale one. Read the node the create just
    // wrote — that one is unambiguous.
    const node = (res.result.meta.AffectedNodes ?? [])
      .find((n) => n.CreatedNode?.LedgerEntryType === 'Escrow');
    escrowSequence = node?.CreatedNode?.NewFields?.Sequence;
    if (!escrowSequence) {
      throw new Error('no Escrow CreatedNode with a Sequence in the create response');
    }
  });

  await runTest('EscrowCancel — the sequence can also be cancelled', async () => {
    if (!escrowSequence) throw new Error('No escrowSequence from the prior test');

    // Wait out the escrow's own CancelAfter. See the three rules on
    // EscrowCreate above — this wait is the ONLY way the quorum is the
    // authorised canceller, and skipping it yields tecNO_PERMISSION.
    //
    // The wait must finish BEFORE the EscrowCancel is submitted, not merely
    // before it lands. tecNO_PERMISSION is a `tec*`: it claims the fee rather
    // than requeueing, so a transaction that races the boundary loses its fee
    // instead of retrying. There is no ripple to ride here.
    const waitFor = Math.max(0, escrowCancelAfter + 3 - xrplNow());
    if (waitFor > 0) {
      console.log(`    (waiting ${waitFor}s for the escrow's CancelAfter to pass)`);
      await new Promise((r) => setTimeout(r, waitFor * 1000));
    }

    const res = await submitQuorum(escrowCancel({
      Account:       account,
      Owner:         account,
      OfferSequence: escrowSequence,
    }));
    assertSuccess(res);
  });

  // ── Checks ─────────────────────────────────────────────────────────
  console.log('\n  ── Checks ──');

  let checkId;
  await runTest('CheckCreate — writes a check the recipient may cash', async () => {
    const res = await submitQuorum(checkCreate({
      Account: account,
      Destination: recipient,
      SendMax: XRP('1'),
    }));
    assertSuccess(res);
    checkId = extractCreatedIndex(res, 'Check');
    if (!checkId) throw new Error('no CheckID in the affected nodes');
  });

  await runTest('CheckCash — the recipient cashes it', async () => {
    if (!rcpt) throw new Error('no recipientSeed in the [16] state — re-run 16a');
    // The check is addressed to the recipient, so the recipient must sign.
    assertSuccess(await submitAs(rcpt, checkCash({
      Account: recipient,
      CheckID: checkId,
      Amount:  XRP('1'),
    })));
  });

  await runTest('CheckCreate + CheckCancel — a check can be withdrawn', async () => {
    const created = await submitQuorum(checkCreate({
      Account: account,
      Destination: recipient,
      SendMax: XRP('1'),
    }));
    assertSuccess(created);
    const id = extractCreatedIndex(created, 'Check');
    assertSuccess(await submitQuorum(checkCancel({
      Account: account, CheckID: id,
    })));
  });

  // ── NFTs ───────────────────────────────────────────────────────────
  console.log('\n  ── NFTs ──');

  let nftId;
  let offerId;
  await runTest('NFTokenMint — the account mints its own token', async () => {
    // NFTokenTaxon is REQUIRED by the factory (UInt32), even though the
    // protocol treats it as optional. 0 is the documented "no common name".
    const res = await submitQuorum(nftokenMint({
      Account: account,
      NFTokenTaxon: 0,
    }));
    assertSuccess(res);
    nftId = extractNFTokenId(res);
    if (!nftId) throw new Error('no NFTokenID in the affected nodes');
  });

  await runTest('NFTokenCreateOffer — lists it for sale', async () => {
    // Without tfSellNFToken this is a BUY offer, which requires `Owner`.
    // 0x1 makes it a sell offer of the account's own token.
    const res = await submitQuorum(nftokenCreateOffer({
      Account:   account,
      NFTokenID: nftId,
      Amount:    XRP('1'),
      Flags:     0x00000001, // tfSellNFToken
    }));
    assertSuccess(res);
    offerId = extractOfferIndex(res);
    if (!offerId) throw new Error('no NFTokenOffer index in the affected nodes');
  });

  await runTest('NFTokenCancelOffer — withdraws the listing', async () => {
    // It takes `NFTokenOffers`, an ARRAY of offer ids as strings — not an
    // `OfferIndex` scalar. The id is the NFTokenOffer ledger object, which is
    // what extractOfferIndex returns. Deriving it from the token id would
    // hand back the wrong object — see helpers.mjs.
    assertSuccess(await submitQuorum(nftokenCancelOffer({
      Account: account,
      NFTokenOffers: [String(offerId)],
    })));
  });

  // ── Payment channels ───────────────────────────────────────────────
  console.log('\n  ── Payment channels ──');

  let channelId;
  await runTest('PaymentChannelCreate — opens a channel from the restricted account', async () => {
    const res = await submitQuorum(paymentChannelCreate({
      Account:      account,
      Destination:  recipient,
      Amount:       XRP('1'),
      SettleDelay:  86400,
      PublicKey:    s1.publicKey,
    }));
    assertSuccess(res);
    // The ledger entry type is `PayChannel`, NOT `PaymentChannel` — the
    // transaction type and the ledger object type differ here. The first run
    // guessed the latter and extractCreatedIndex silently returned undefined,
    // which surfaced two stories later as "no channelId from the prior test".
    channelId = requireCreatedIndex(res, 'PayChannel', 'PaymentChannelCreate');
  });

  // The destination claims against a real channel ID read from the ledger.
  // An earlier draft passed an empty Channel and asserted only that it was
  // "refused" — which proves nothing about the restricted account, since the
  // request was malformed for everyone.
  await runTest('PaymentChannelClaim — the destination claims against the real channel', async () => {
    // Balance is omitted rather than set to 0: the factory requires a
    // STRICTLY positive drops string, and a zero claim is expressed by
    // leaving the field off (the destination claims everything owed).
    assertSuccess(await submitAs(rcpt, paymentChannelClaim({
      Account: recipient,
      Channel: channelId,
    })));
  });

  await runTest('PaymentChannelFund — the restricted account adds to its own channel', async () => {
    assertSuccess(await submitQuorum(paymentChannelFund({
      Account: account,
      Channel: channelId,
      Amount:  XRP('1'),
    })));
  });

  // ── Tickets ────────────────────────────────────────────────────────
  // Relevant to the device's sequence counter: a ticket consumes a sequence
  // number from the account root without the device having to predict it.
  console.log('\n  ── Tickets ──');

  await runTest('TicketCreate — reserves a batch of sequence numbers', async () => {
    assertSuccess(await submitQuorum(ticketCreate({
      Account: account, TicketCount: 2,
    })));
  });

  // ── Account-level ──────────────────────────────────────────────────
  console.log('\n  ── Account ──');

  await runTest('AccountSet (non-key flags) — an ordinary flag change', async () => {
    // TransferRate is a plain uint, has no cross-field requirements, and is
    // settable on any account. EmailHash is a Hash with a codec-enforced
    // width; TickSize needs issuer balances; NFTokenBrokerFee is constructed
    // through the Amount path and rejects a bare number.
    assertSuccess(await submitQuorum(accountSet({
      Account: account, TransferRate: 1_000_000_000, // 1.0 in Q32.32 — no discount
    })));
  });

  await runTest('DepositPreauth — the account preauthorizes a depositor', async () => {
    assertSuccess(await submitQuorum(depositPreauth({
      Account: account, Authorize: bob.classicAddress,
    })));
  });

  await runTest('DepositPreauth — and revokes it', async () => {
    assertSuccess(await submitQuorum(depositPreauth({
      Account: account, Unauthorize: bob.classicAddress,
    })));
  });

  // ── Amendment-gated ────────────────────────────────────────────────
  // Submitted once each. A temDISABLED is recorded as a SKIP with a reason,
  // never as a pass — the same discipline suite [15] uses for Sponsorship.
  //
  // The build happens OUTSIDE runTest, deliberately. An earlier draft called
  // skip() from inside the test body, so every amendment-gated item was
  // counted TWICE — once as skipped, then again as a pass when the callback
  // returned normally. That inflated the total by four and would have made
  // "14/29 passed" partly a counting artefact.
  console.log('\n  ── Amendment-gated (submitted, not assumed) ──');

  const gated = [
    // AMM amounts are plain drops strings for XRP (see xrpl.org ammcreate.md's
    // example). `{ xrp: "..." }` is the typed-SDK form and is correctly
    // rejected — isAmount accepts string | IssuedCurrencyAmount | MPTAmount,
    // the same union xrpl.js uses.
    ['AMMCreate', () => ammCreate({
      Account: account,
      // Small legs, and deliberately so. The account funds an AMM out of its
      // OWN balance, and it has been paying owner reserve on 28 ledger
      // objects accumulated across runs of this suite — it held ~79 XRP on
      // the run that first reached this line. Asking for 100 XRP answered
      // `tecUNFUNDED_AMM` ("The sender does not hold enough of the assets"),
      // which is a correct ledger verdict about a wallet that is simply
      // poorer than the test assumed.
      //
      // Note the progression: before the Default Ripple fix this answered
      // `terNO_RIPPLE` and never got far enough to look at balances. Fixing
      // the rippling precondition revealed the funding one underneath.
      Amount:  XRP('10'),
      Amount2: { currency: IOU.currency, issuer: IOU.issuer, value: '10' },
      TradingFee: 500,
    })],
    ['MPTokenIssuanceSet', () => mptokenIssuanceSet({
      Account: account,
      // Mutates an EXISTING issuance, so this only runs if MPTokenIssuanceSet
      // follows MPTokenIssuanceCreate (below). A zero id is rejected, and a
      // made-up one would be a lie in a coverage suite.
      //
      // There is deliberately no fallback here. An earlier draft wrote
      // `mptIssuanceId ?? '0'.repeat(48)`, which turned a failed lookup into
      // a plausible-looking temMALFORMED and hid the real problem. If the
      // create below did not produce an id, this must throw.
      MPTokenIssuanceID: mptIssuanceId ?? (() => {
        throw new Error('no MPTokenIssuanceID from MPTokenIssuanceCreate');
      })(),
      // `TransferFee` only. An earlier draft also passed `MaximumAmount` and
      // `AssetScale`, which are MPTokenIssuance**Create** fields —
      // MPTokenIssuanceSet has no such fields (xrpl.js's MPTokenIssuanceSet
      // interface lists neither). The factory accepted them silently and the
      // codec rejected the transaction at submit:
      //   "Field 'MaximumAmount' found in disallowed location."
      // That was a real library defect, not a test error; see DIVERGENCES.md
      // Bug #11. The test no longer relies on the hole.
      TransferFee: 1000,
    })],
    ['CredentialCreate', () => credentialCreate({
      Account: account,
      Subject: bob.classicAddress,
      // The props are FLAT — CredentialType is a top-level field, not nested
      // inside a `Credential` object. The nested shape reads as undefined and
      // is reported as "must be a hex string", which points at the wrong thing.
      CredentialType: 'a1b2c3d4'.repeat(4), // 32 hex chars, 16 bytes
      // There is deliberately no CredentialValues here: it is not a field on
      // CredentialCreate at all (it lives on the Credential ledger object),
      // and the codec rejects it by name.
    })],
    ['DIDSet', () => didSet({
      Account: account,
      // DIDDocument must be valid hex — '{}' is not.
      DIDDocument: Buffer.from('{"@context":"https://www.w3.org/ns/did/v1"}').toString('hex'),
    })],
  ];

  // ── AMM precondition: the ISSUER must have Default Ripple enabled ──
  //
  // AMMCreate answered terNO_RIPPLE, which reads as "the account cannot fund an
  // AMM" and is really a rule about the *issuer*, not the creator. Per
  // xrpl-dev-portal `ammcreate.md` (Error Cases):
  //
  //   terNO_RIPPLE — "The issuer of at least one of the assets has not enabled
  //   the Default Ripple flag."
  //
  // and the same page's requirements section: "The tokens' issuers must have
  // Default Ripple enabled." The USD issuer here is the recipient, a plain
  // faucet wallet with no trust lines, so it does not have the flag.
  //
  // This is deliberately signed by the RECIPIENT, not the quorum: it is an
  // ordinary flag change on an account that still has a live master key. The
  // restriction under test belongs to `account`, and this is not it.
  console.log('\n  ── AMM precondition (issuer side) ──');

  await runTest('setup: recipient enables Default Ripple — an AMM precondition', async () => {
    if (!rcpt) throw new Error('no recipientSeed in the [16] state — re-run 16a');
    assertSuccess(await submitAs(rcpt, accountSet({
      Account: recipient,
      // `SetFlag`, NOT `Flags`. AccountSet carries two flag namespaces and
      // they are not interchangeable:
      //   - `SetFlag` takes an asf* INDEX (xrpl.js `AccountSetAsfFlags`).
      //     asfDefaultRipple = 8.
      //   - `Flags` takes a tf* BITMASK (`AccountSetTfFlags`), and those bits
      //     toggle account-root flags in their own right.
      //
      // An earlier draft passed `Flags: 0x00010000`, which is
      // `tfRequireDestTag` — a legal bit, so it succeeded, and it silently
      // set `lsfRequireDestTag` (0x00020000) on the recipient. Measured on a
      // fresh wallet: Flags 0x00010000 -> tesSUCCESS with root Flags
      // 0x00020000. The AMM stayed refused, correctly, because the flag that
      // actually matters was never set.
      //
      // The value that matters, per rippled `LedgerFormats.h:145`:
      //   lsfDefaultRipple = 0x00800000
      // and per `AMMCreate.cpp:131-146` it is read off the ISSUER's root:
      //   noDefaultRipple = … return !issuerAccount->isFlag(lsfDefaultRipple)
      //   … return terNO_RIPPLE
      SetFlag: 8,
    })));
  });

  // MPTokenIssuanceSet is not amendment-gated in the same way — it needs a
  // prior MPTokenIssuanceCreate. Create one first, by quorum, and read the ID.
  let mptIssuanceId = null;  await runTest('setup: MPTokenIssuanceCreate — the account issues an MPT', async () => {
    const { mptokenIssuanceCreate } = await import('../../xrpjson.mjs');
    const res = await submitQuorum(mptokenIssuanceCreate({
      Account: account,
      MaximumAmount: '100',
      AssetScale: 2,
      TransferFee: 1000,
      // A non-zero TransferFee requires tfMPTCanTransfer. It is 0x20, not
      // 0x1 — 0x1 is tfMPTCanLock (flags.ts:217-219).
      Flags: 0x00000020,
    }));
    assertSuccess(res);
    mptIssuanceId = await extractMPTokenIssuanceId(client, res);
  });

  for (const [name, build] of gated) {
    const label = `${name} — submitted by the quorum`;

    let tx;
    try {
      tx = build();
      tx.validate();
    } catch (e) {
      // The factory refused client-side. The ledger never saw it, so this is
      // a skip and NOT a pass.
      skip(label, `xrpjson rejected it client-side: ${e.message}`);
      continue;
    }

    // Submitted OUTSIDE runTest, because the verdict decides whether this is
    // a pass, a skip, or a failure, and skip() must not be called from inside a
    // test body. An earlier draft called skip() from inside, so every
    // amendment-gated item was counted TWICE — once skipped, then again as a
    // pass when the callback returned.
    //
    // It also threw on temDISABLED rather than skipping, which inverted the
    // rule this suite states: a `temDISABLED` is the network saying the
    // amendment is off. That is a skip with a reason, never a pass AND never a
    // failure — the transaction is well-formed and the ledger never judged it.
    const code = await submitQuorumNoWait(tx);
    if (code === 'temDISABLED') {
      skip(label, `AMENDMENT_OFF: ${code} — ${name} is not enabled on this network`);
      continue;
    }

    await runTest(label, async () => {
      // NOT `const { code } = await ...` — submitQuorumNoWait returns a
      // STRING, and destructuring a string yields `code: undefined` with no
      // error. That is where two runs' worth of "AMMCreate returned undefined"
      // came from: a shape mismatch, not a ledger answer.
      if (!/^tes/.test(String(code))) {
        throw new Error(`${name} returned ${code} — investigate before recording`);
      }
      console.log(`    (${name} succeeded)`);
    });
  }

  return summary();
}

// ── Standalone execution ──────────────────────────────────────────────
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { withStandaloneSetup } = await import('../setup.mjs');
  await withStandaloneSetup(run);
}
