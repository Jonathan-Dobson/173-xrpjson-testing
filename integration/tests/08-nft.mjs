import { xrpToDrops } from 'xrpl';
import { NFTokenMintTx, NFTokenBurnTx, NFTokenCreateOfferTx, NFTokenAcceptOfferTx } from 'xrp-tx';
import { createRunner, assertSuccess, submitTx } from '../helpers.mjs';

function extractNFTokenId(response) {
  const node = response.result.meta.AffectedNodes
    .find(n => n.ModifiedNode?.LedgerEntryType === 'NFTokenPage'
            || n.CreatedNode?.LedgerEntryType  === 'NFTokenPage');
  const page = node?.ModifiedNode?.FinalFields ?? node?.CreatedNode?.NewFields;
  return page?.NFTokens?.at(-1)?.NFToken?.NFTokenID;
}

function extractNFTOfferIndex(response) {
  const node = response.result.meta.AffectedNodes
    .find(n => n.CreatedNode?.LedgerEntryType === 'NFTokenOffer');
  return node?.CreatedNode?.LedgerIndex;
}

export async function run(client, alice, bob) {
  const { runTest, summary } = createRunner();
  console.log('[8] NFTokenMint / NFTokenCreateOffer / NFTokenAcceptOffer / NFTokenBurn');

  let nftokenId;
  let nftOfferIndex;

  await runTest('Alice mints an NFT (taxon=1, transferable)', async () => {
    const tx = new NFTokenMintTx({
      Account:      alice.classicAddress,
      NFTokenTaxon: 1,
      Flags:        8, // tfTransferable
      URI:          Buffer.from('https://example.com/nft/1').toString('hex').toUpperCase(),
    });
    tx.validate();
    const res = await submitTx(client, tx, alice);
    assertSuccess(res);
    nftokenId = extractNFTokenId(res);
  });

  await runTest('Alice creates a sell offer for her NFT (1 XRP)', async () => {
    if (!nftokenId) throw new Error('No nftokenId from prior test');
    const tx = new NFTokenCreateOfferTx({
      Account:   alice.classicAddress,
      NFTokenID: nftokenId,
      Amount:    xrpToDrops('1'),
      Flags:     1, // tfSellNFToken
    });
    tx.validate();
    const res = await submitTx(client, tx, alice);
    assertSuccess(res);
    nftOfferIndex = extractNFTOfferIndex(res);
  });

  await runTest('Bob accepts the sell offer', async () => {
    if (!nftOfferIndex) throw new Error('No nftOfferIndex from prior test');
    const tx = new NFTokenAcceptOfferTx({
      Account:          bob.classicAddress,
      NFTokenSellOffer: nftOfferIndex,
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, bob));
  });

  await runTest('Bob burns the NFT he received', async () => {
    if (!nftokenId) throw new Error('No nftokenId from prior test');
    const tx = new NFTokenBurnTx({
      Account:   bob.classicAddress,
      NFTokenID: nftokenId,
    });
    tx.validate();
    assertSuccess(await submitTx(client, tx, bob));
  });

  return summary();
}

// ── Standalone execution ──────────────────────────────────────────────────────
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { withStandaloneSetup } = await import('../setup.mjs');
  await withStandaloneSetup(run);
}
