/**
 * [12] NFT lifecycle — metadata, offer withdrawal, and the buy/broker side.
 *
 * Implements the stories in USER-STORIES.md § "[12] NFT lifecycle".
 *
 * Suite [8] covers mint → sell → accept → burn. This suite covers the three
 * things [8] does not:
 *   - editing and clearing a token's metadata URI (NFToken-1, NFT-2)
 *   - withdrawing an offer, sell side and buy side (NFT-4, NFT-5)
 *   - accepting a *bid* and brokering a match (NFT-6, NFT-7, NFT-8)
 *
 * Ordering matters within the suite: NFT-3 modifies a token that NFT-6
 * transferred, so Part B depends on Part A having minted it.
 *
 * Self-contained: funds its own broker wallet, mints its own tokens. Does not
 * depend on [8]'s state. Shares Alice and Bob with the rest of the run.
 *
 * Run standalone: node integration/tests/12-nft-lifecycle.mjs
 */

import { xrpToDrops } from 'xrpl';
// Canonical fp factory names, not the legacy `XxxTx` aliases. The shim's
// aliases are a migration shim for suites [1]–[11]; new suites use the
// documented functional API directly.
import {
  nftokenMint,
  nftokenCreateOffer,
  nftokenAcceptOffer,
  nftokenCancelOffer,
  nftokenModify,
  ValidationError,
  NFTokenCreateOfferFlags,
} from '../../xrpjson.mjs';
import {
  createRunner,
  assertSuccess,
  submitTx,
  extractNFTokenId,
  extractOfferIndex,
  balanceDrops,
  expectRejected,
} from '../helpers.mjs';

const hex = s => Buffer.from(s).toString('hex').toUpperCase();

// Every token this suite mints must be BOTH transferable (the buy-side and
// brokered stories move the token between accounts) and mutable (the NFT-1 /
// NFT-2 / NFT-3 metadata stories modify the URI). tfTransferable = 0x8,
// tfMutable = 0x10 — see NFTokenMintFlags in xrpjson/flags.
const NFTOKEN_FLAGS = 0x8 | 0x10;

export async function run(client, alice, bob) {
  const { runTest, summary } = createRunner();
  console.log('[12] NFT lifecycle — metadata, offer withdrawal, buy + broker side');

  // Carol is the marketplace broker. Funded fresh so her balance delta is
  // attributable to the broker fee alone.
  const { wallet: carol } = await client.fundWallet();
  console.log(`  Broker wallet: ${carol.classicAddress}`);

  // ── Part A: metadata on a freshly minted token (NFT-1, NFT-2) ─────
  console.log('\n  ── Metadata (NFT-1, NFT-2) ──');
  let nftA;

  await runTest('setup: Alice mints a fresh NFT for the metadata stories', async () => {
    const tx = nftokenMint({
      Account: alice.classicAddress,
      NFTokenTaxon: 0,
      URI:        hex('https://example.com/nft/metadata-original'),
      Flags:      NFTOKEN_FLAGS,
    });
    tx.validate();
    const res = await submitTx(client, tx, alice);
    assertSuccess(res);
    nftA = extractNFTokenId(res);
    if (!nftA) throw new Error('Could not extract NFTokenID');
  });

  // NFT-1 — update the URI in place, same token ID.
  await runTest('NFT-1: Alice updates the metadata URI in place', async () => {
    if (!nftA) throw new Error('No nftA from prior test');
    const tx = nftokenModify({
      Account:   alice.classicAddress,
      NFTokenID: nftA,
      URI:       hex('https://example.com/nft/metadata-updated'),
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, alice));
  });

  // NFT-2 — clear the URI by omitting the field entirely.
  await runTest('NFT-2: Alice clears the metadata URI by omitting it', async () => {
    if (!nftA) throw new Error('No nftA from prior test');
    const tx = nftokenModify({
      Account:   alice.classicAddress,
      NFTokenID: nftA,
      // URI deliberately absent — this is the "clear" path, not URI: ''
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, alice));
  });

  // ── Part B: buy-side accept (NFT-6) then post-transfer modify (NFT-3)
  console.log('\n  ── Buy side + ownership-gated metadata (NFT-6, NFT-3) ──');
  let nftB;
  let buyOfferIndex;

  await runTest('setup: Alice mints a second NFT to sell to a bidder', async () => {
    const tx = nftokenMint({
      Account:      alice.classicAddress,
      NFTokenTaxon: 0,
      URI:          hex('https://example.com/nft/buy-side'),
      Flags:        NFTOKEN_FLAGS,
    });
    tx.validate();
    const res = await submitTx(client, tx, alice);
    assertSuccess(res);
    nftB = extractNFTokenId(res);
    if (!nftB) throw new Error('Could not extract NFTokenID');
  });

  await runTest('setup: Bob places a BUY offer on Alice\'s NFT (no tfSellNFToken, Owner set)', async () => {
    if (!nftB) throw new Error('No nftB from prior test');
    const tx = nftokenCreateOffer({
      Account:  bob.classicAddress,
      NFTokenID: nftB,
      Amount:    xrpToDrops('4'),
      Owner:     alice.classicAddress,   // required for a buy offer
    });
    tx.validate();
    const res = await submitTx(client, tx, bob);
    assertSuccess(res);
    buyOfferIndex = extractOfferIndex(res);
    if (!buyOfferIndex) throw new Error('Could not extract buy-offer index');
  });

  // NFT-6 — the owner accepts a bid via NFTokenBuyOffer.
  await runTest('NFT-6: Alice accepts Bob\'s bid (NFTokenBuyOffer) and the token moves', async () => {
    if (!buyOfferIndex) throw new Error('No buyOfferIndex from prior test');
    const tx = nftokenAcceptOffer({
      Account:         alice.classicAddress,
      NFTokenBuyOffer: buyOfferIndex,
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, alice));
  });

  // NFT-3 — who may modify metadata AFTER the token has been sold.
  //
  // The intuitive guess ("the new owner controls the metadata") is wrong.
  // rippled NFTokenModify::preflight:
  //   // Check if the NFT is mutable
  //   if ((nft::getFlags(ctx.tx[sfNFTokenID]) & nft::kFlagMutable) == 0)
  //       return tecNO_PERMISSION;
  //   // Verify permissions for the issuer
  //   if (AccountID const issuer = nft::getIssuer(ctx.tx[sfNFTokenID]); issuer != account)
  //   { ... if (auto const minter = (*sle)[~sfNFTokenMinter]; minter != account)
  //       return tecNO_PERMISSION; }
  // The gate is ISSUER-OR-AUTHORIZED-MINTER, not owner. The owner field of the
  // token is only needed so the issuer can name who holds it.
  await runTest('NFT-3: the ISSUER can still update metadata after the token is sold', async () => {
    if (!nftB) throw new Error('No nftB from prior test');
    // Alice is the issuer; Bob is now the holder, so Owner must be supplied.
    const tx = nftokenModify({
      Account:   alice.classicAddress,
      NFTokenID: nftB,
      Owner:     bob.classicAddress,   // current holder, differs from Account
      URI:       hex('https://example.com/nft/issuer-updated-while-sold'),
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, alice));
  });

  await runTest('NFT-3: the new OWNER cannot update metadata — issuer-gated, not owner-gated', async () => {
    if (!nftB) throw new Error('No nftB from prior test');
    // Bob holds the token but is neither its issuer nor an authorized minter,
    // so the ledger must refuse. This is the half that would have failed had
    // the story been written on the "metadata follows ownership" assumption.
    const tx = nftokenModify({
      Account:   bob.classicAddress,
      NFTokenID: nftB,
      URI:       hex('https://example.com/nft/owner-should-not-win'),
    });
    tx.validate();
    const { ok, result } = await expectRejected(() => submitTx(client, tx, bob));
    if (!ok) {
      throw new Error('Expected the owner (non-issuer) to be refused, got tesSUCCESS');
    }
    console.log(`    (ledger refused the non-issuer owner as expected: ${result})`);
  });

  // Carol is an unrelated third party — neither issuer, minter, nor holder.
  await runTest('NFT-3: an unrelated third party is refused', async () => {
    if (!nftB) throw new Error('No nftB from prior test');
    const tx = nftokenModify({
      Account:   carol.classicAddress,
      NFTokenID: nftB,
      URI:       hex('https://example.com/nft/carol-should-not-win'),
    });
    tx.validate();
    const { ok, result } = await expectRejected(() => submitTx(client, tx, carol));
    if (!ok) {
      throw new Error('Expected the ledger to refuse an unrelated third party, got tesSUCCESS');
    }
    console.log(`    (ledger refused the third party as expected: ${result})`);
  });

  // ── Part C: withdrawing offers (NFT-4 sell side, NFT-5 buy side) ───
  console.log('\n  ── Offer withdrawal (NFT-4, NFT-5) ──');
  let nftC;
  let sellOfferIndex;
  let bidOfferIndex;

  await runTest('setup: Alice mints a third NFT for the withdrawal stories', async () => {
    const tx = nftokenMint({
      Account:      alice.classicAddress,
      NFTokenTaxon: 0,
      URI:          hex('https://example.com/nft/withdrawal'),
      Flags:        NFTOKEN_FLAGS,
    });
    tx.validate();
    const res = await submitTx(client, tx, alice);
    assertSuccess(res);
    nftC = extractNFTokenId(res);
    if (!nftC) throw new Error('Could not extract NFTokenID');
  });

  await runTest('NFT-4: Alice posts a sell offer, then withdraws it', async () => {
    if (!nftC) throw new Error('No nftC from prior test');
    const offer = nftokenCreateOffer({
      Account:  alice.classicAddress,
      NFTokenID: nftC,
      Amount:    xrpToDrops('3'),
      Flags:     NFTokenCreateOfferFlags.tfSellNFToken,
    });
    offer.validate();
    const posted = await submitTx(client, offer, alice);
    assertSuccess(posted);
    sellOfferIndex = extractOfferIndex(posted);
    if (!sellOfferIndex) throw new Error('Could not extract sell-offer index');

    const cancel = nftokenCancelOffer({
      Account:      alice.classicAddress,
      NFTokenOffers: [sellOfferIndex],
    });
    cancel.validate();
    assertSuccess(await submitTx(client, cancel, alice));
  });

  await runTest('NFT-4: the withdrawn sell offer is actually gone from the ledger', async () => {
    if (!sellOfferIndex) throw new Error('No sellOfferIndex from prior test');
    // Note: re-submitting NFTokenCancelOffer for the same index does NOT fail
    // — rippled treats it as a no-op and returns tesSUCCESS. So the useful
    // assertion is not "the second cancel is rejected" but "the offer is
    // really gone", which is checked by reading the owner directory.
    const res = await client.request({
      command: 'account_objects',
      account: alice.classicAddress,
      type: 'NFTokenOffer',
    });
    const stillThere = (res.result.account_objects ?? [])
      .some(o => o.LedgerIndex === sellOfferIndex);
    if (stillThere) {
      throw new Error(`Offer ${sellOfferIndex} still exists after cancellation`);
    }
  });

  await runTest('NFT-5: Bob posts a BUY offer, then withdraws it himself', async () => {
    if (!nftC) throw new Error('No nftC from prior test');
    const offer = nftokenCreateOffer({
      Account:   bob.classicAddress,
      NFTokenID: nftC,
      Amount:     xrpToDrops('2'),
      Owner:      alice.classicAddress,   // buy offer → Owner required
    });
    offer.validate();
    const posted = await submitTx(client, offer, bob);
    assertSuccess(posted);
    bidOfferIndex = extractOfferIndex(posted);
    if (!bidOfferIndex) throw new Error('Could not extract bid-offer index');

    const cancel = nftokenCancelOffer({
      Account:      bob.classicAddress,
      NFTokenOffers: [bidOfferIndex],
    });
    cancel.validate();
    assertSuccess(await submitTx(client, cancel, bob));
  });

  // ── Part D: brokered sale (NFT-7, NFT-8) ──────────────────────────
  console.log('\n  ── Brokered sale (NFT-7, NFT-8) ──');
  let nftD;
  let dSellOffer;
  let dBuyOffer;
  const BROKER_FEE = xrpToDrops('1');

  await runTest('setup: Alice mints a fourth NFT for the brokered sale', async () => {
    const tx = nftokenMint({
      Account:      alice.classicAddress,
      NFTokenTaxon: 0,
      URI:          hex('https://example.com/nft/brokered'),
      Flags:        NFTOKEN_FLAGS,
    });
    tx.validate();
    const res = await submitTx(client, tx, alice);
    assertSuccess(res);
    nftD = extractNFTokenId(res);
    if (!nftD) throw new Error('Could not extract NFTokenID');
  });

  await runTest('setup: Alice sells at 10 XRP, Bob bids 12 XRP', async () => {
    if (!nftD) throw new Error('No nftD from prior test');

    const sell = nftokenCreateOffer({
      Account:   alice.classicAddress,
      NFTokenID: nftD,
      Amount:     xrpToDrops('10'),
      Flags:      NFTokenCreateOfferFlags.tfSellNFToken,
    });
    sell.validate();
    const sellRes = await submitTx(client, sell, alice);
    assertSuccess(sellRes);
    dSellOffer = extractOfferIndex(sellRes);
    if (!dSellOffer) throw new Error('Could not extract sell-offer index');

    const buy = nftokenCreateOffer({
      Account:   bob.classicAddress,
      NFTokenID: nftD,
      Amount:     xrpToDrops('12'),
      Owner:      alice.classicAddress,
    });
    buy.validate();
    const buyRes = await submitTx(client, buy, bob);
    assertSuccess(buyRes);
    dBuyOffer = extractOfferIndex(buyRes);
    if (!dBuyOffer) throw new Error('Could not extract buy-offer index');
  });

  // NFT-7 — Carol matches the two offers and takes a fee out of the spread.
  await runTest('NFT-7: Carol brokers the match and earns a fee, without taking custody', async () => {
    if (!dSellOffer || !dBuyOffer) throw new Error('No offers from prior test');
    const carolBefore = await balanceDrops(client, carol.classicAddress);

    const tx = nftokenAcceptOffer({
      Account:           carol.classicAddress,
      NFTokenSellOffer:  dSellOffer,
      NFTokenBuyOffer:   dBuyOffer,
      NFTokenBrokerFee:  BROKER_FEE,
    });
    tx.validate();
    const res = await submitTx(client, tx, carol);
    assertSuccess(res);

    const carolAfter = await balanceDrops(client, carol.classicAddress);
    const gained = carolAfter - carolBefore;
    // The broker nets out the transaction fee it paid to make the match, so
    // gained == BROKER_FEE - fee exactly. Asserting `gained >= BROKER_FEE` is
    // wrong by precisely that fee (measured: 999988 against a 1000000 fee on
    // a 12-drop fee) and would fail on every run.
    const paidFee = BigInt(res.result.tx_json.Fee ?? 0);
    const net = gained + paidFee;
    if (net !== BigInt(BROKER_FEE)) {
      throw new Error(
        `Broker netted ${net} drops (gained ${gained} + fee ${paidFee}), expected ${BROKER_FEE}`,
      );
    }
    console.log(`    (broker netted ${net} drops = ${BROKER_FEE} fee − ${paidFee} tx fee)`);

    // Proof the token went straight from Alice to Bob and never to the broker.
    const info = await client.request({ command: 'account_nfts', account: carol.classicAddress });
    const held = (info.result.account_nfts ?? []).length;
    if (held !== 0) {
      throw new Error(`Broker holds ${held} NFT(s) — custody model violated`);
    }
  });

  // NFT-8 — the fee guard is a construction-time guarantee.
  await runTest('NFT-8: a zero broker fee is rejected at construction', async () => {
    if (!dSellOffer || !dBuyOffer) throw new Error('No offers from prior test');
    let threw;
    try {
      nftokenAcceptOffer({
        Account:          carol.classicAddress,
        NFTokenSellOffer: dSellOffer,
        NFTokenBuyOffer:  dBuyOffer,
        NFTokenBrokerFee: '0',
      });
    } catch (e) { threw = e; }
    if (!threw) throw new Error('Expected NFTokenBrokerFee=0 to throw');
    if (!(threw instanceof ValidationError)) {
      throw new Error(`Expected ValidationError, got ${threw.constructor.name}: ${threw.message}`);
    }
  });

  await runTest('NFT-8: a negative broker fee is rejected at construction', async () => {
    if (!dSellOffer || !dBuyOffer) throw new Error('No offers from prior test');
    let threw;
    try {
      nftokenAcceptOffer({
        Account:          carol.classicAddress,
        NFTokenSellOffer: dSellOffer,
        NFTokenBuyOffer:  dBuyOffer,
        NFTokenBrokerFee: { currency: 'XRP', value: '-1' },
      });
    } catch (e) { threw = e; }
    if (!threw) throw new Error('Expected a negative NFTokenBrokerFee to throw');
    if (!(threw instanceof ValidationError)) {
      throw new Error(`Expected ValidationError, got ${threw.constructor.name}: ${threw.message}`);
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
