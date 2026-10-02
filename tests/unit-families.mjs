/**
 * Per-family unit tests — happy-path coverage for every factory.
 *
 * For each of the 79 factories, this file:
 *   1. Constructs the factory with a minimal valid input.
 *   2. Verifies the result is frozen and has the correct TransactionType.
 *   3. Verifies toJSON() includes the user-supplied fields.
 *   4. Verifies with() returns a new frozen object that re-validates.
 *
 * Each fixture was built by reading the factory source to determine the
 * minimal set of required fields, then cross-checking against xrpl.js,
 * xrpl.org docs, and the relevant XLS spec.
 *
 * Run: node tests/unit-families.mjs
 */

import {
  ValidationError,
} from '../xrpjson.mjs';

import * as xrpjson from 'xrpjson';

const ACCOUNT_A = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const ACCOUNT_B = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';
const ACCOUNT_C = 'rJVUe5S1zQ2Cznm5y7RZHN9fYEc6pN1aXu';

// Standard Ripple Epoch values — from xrpl-dev-portal/escrowcreate.md
// example: FinishAfter: 533171558, CancelAfter: 533257958
const FINISH_AFTER = 533171558;
const CANCEL_AFTER = 533257958;

// MPT issuance IDs are 192-bit (48 hex chars) per XLS-33
const MPT_ISSUANCE_ID = '0142C4969A74271B27CFC1899C8F1DE30ED9C41A8DEE6E49';

// Ledger entry IDs are 64 hex chars
const LEDGER_ENTRY_ID = 'D77A30CB6C2C20E45CE5FE2CFA7E8D5E2D4F8E3A4B5C6D7E8F9A0B1C2D3E4F50';

// Hex-encoded strings
const HEX_DOMAIN = Buffer.from('example.com').toString('hex').toUpperCase();
const HEX_URI = Buffer.from('https://example.com/nft/1').toString('hex').toUpperCase();
const HEX_MEMO = Buffer.from('test memo').toString('hex').toUpperCase();
const HEX_META = Buffer.from(JSON.stringify({ n: 'Test', t: 'TST' })).toString('hex').toUpperCase();
const HEX_CRED_TYPE = Buffer.from('Passport').toString('hex').toUpperCase();

// Generic 64-char hex IDs (LedgerEntryID, LoanID, etc.)
const HEX_64 = 'A'.repeat(64);

// AMM Flags (XLS-30 / XLS-37d)
// tfLPToken = 0x00010000, tfWithdrawAll = 0x00020000, tfOneAssetWithdrawAll = 0x00040000,
// tfSingleAsset = 0x00080000, tfTwoAsset = 0x00100000, tfOneAssetLPToken = 0x00200000,
// tfLimitLPToken = 0x00400000
const AMM_TF_TWO_ASSET = 0x00100000;

// Batch Flags (XLS-56)
// tfAllOrNothing = 0x00010000, tfOnlyOne = 0x00020000,
// tfUntilFailure = 0x00040000, tfIndependent = 0x00080000
const BATCH_TF_INDEPENDENT = 0x00080000;

// SponsorshipTransfer Flags (XLS-0068)
// tfSponsorshipEnd = 0x00010000, tfSponsorshipCreate = 0x00020000,
// tfSponsorshipReassign = 0x00040000
const SPONSORSHIP_TF_END = 0x00010000;

// ConfidentialMPT ZK proof lengths (per ConfidentialTransfer amendment spec)
// ZKProof = 128 hex chars (64 bytes)
// HolderEncryptedAmount / SenderEncryptedAmount = 132 hex chars (66 bytes)
const ZK_PROOF = 'A'.repeat(128);
const ENCRYPTED_AMOUNT = 'A'.repeat(132);

// Delegate Permissions — one Permission value + one PermissionedDomainID
// Format per XLS-0085d: Permissions: [{ Permission: { PermissionValue: 'Payment', AuthorizingAccount: ... } }]
// Note: actual format depends on DelegateSet amendment spec; minimum required is non-empty array
const DELEGATE_PERMISSIONS = [{
  Permission: {
    PermissionValue: 'Payment',
  },
}];

// X-Chain bridge sample (4 fields per XLS-38d / XChainBridge)
const XCHAIN_BRIDGE = {
  LockingChainDoor: ACCOUNT_A,
  LockingChainIssue: { currency: 'XRP' },
  IssuingChainDoor: ACCOUNT_B,
  IssuingChainIssue: { currency: 'XRP' },
};

// ─── Test runner ────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}\n    ${e.message}`);
  }
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function expectThrows(fn, message) {
  let error;
  try { fn(); } catch (e) { error = e; }
  ok(error !== undefined, `${message} — no error thrown`);
  ok(error instanceof ValidationError, `${message} — expected ValidationError, got ${error?.constructor?.name}`);
}

// ─── Helper for happy-path factories ─────────────────────────────────
function checkFactory(name, factory, validProps, expectedType, additionalChecks) {
  test(`${name} — constructs and freezes with minimal input`, () => {
    const tx = factory(validProps);
    ok(tx.TransactionType === expectedType, `TransactionType ${tx.TransactionType} !== ${expectedType}`);
    ok(Object.isFrozen(tx), 'result not frozen');
  });

  test(`${name} — toJSON() returns canonical wire shape`, () => {
    const tx = factory(validProps);
    const json = tx.toJSON();
    ok(json.TransactionType === expectedType, 'toJSON dropped TransactionType');
    for (const [k, v] of Object.entries(validProps)) {
      ok(json[k] === v || JSON.stringify(json[k]) === JSON.stringify(v),
        `toJSON dropped or mangled field ${k}: got ${JSON.stringify(json[k])}`);
    }
  });

  test(`${name} — with({ Fee: '12' }) returns a new frozen object`, () => {
    const tx1 = factory(validProps);
    const tx2 = tx1.with({ Fee: '12' });
    ok(tx2 !== tx1, 'with() returned same reference');
    ok(Object.isFrozen(tx2), 'new tx not frozen');
    ok(tx2.Fee === '12', 'Fee override not applied');
    ok(tx1.Fee === undefined, 'original mutated');
  });

  if (additionalChecks) {
    additionalChecks(factory, validProps);
  }
}

// ─── 79 factories, one test set each ─────────────────────────────────
console.log('\n[unit-families] Happy-path coverage for 79 factories\n');

// Account
checkFactory('accountDelete', xrpjson.accountDelete, {
  Account: ACCOUNT_A,
  Destination: ACCOUNT_B,
  DestinationTag: 1,
}, 'AccountDelete');

checkFactory('accountSet', xrpjson.accountSet, {
  Account: ACCOUNT_A,
  Domain: HEX_DOMAIN,
}, 'AccountSet');

// AMM (7 — XLS-0030)
checkFactory('ammBid', xrpjson.ammBid, {
  Account: ACCOUNT_A,
  Asset: { currency: 'USD', issuer: ACCOUNT_B },
  Asset2: { currency: 'EUR', issuer: ACCOUNT_C },
  BidMin: { currency: 'USD', issuer: ACCOUNT_B, value: '1' },
  BidMax: { currency: 'EUR', issuer: ACCOUNT_C, value: '1' },
}, 'AMMBid');

checkFactory('ammClawback', xrpjson.ammClawback, {
  Account: ACCOUNT_A,
  Holder: ACCOUNT_B,
  // Account must equal Asset.issuer — issuer of one of the AMM's pair assets.
  Asset: { currency: 'USD', issuer: ACCOUNT_A },
  Asset2: { currency: 'EUR', issuer: ACCOUNT_C },
  Amount: { currency: 'USD', issuer: ACCOUNT_A, value: '100' },
}, 'AMMClawback');

checkFactory('ammCreate', xrpjson.ammCreate, {
  Account: ACCOUNT_A,
  Amount: '1000000',
  Amount2: { currency: 'USD', issuer: ACCOUNT_B, value: '500' },
  TradingFee: 500,
}, 'AMMCreate');

checkFactory('ammDelete', xrpjson.ammDelete, {
  Account: ACCOUNT_A,
  Asset: { currency: 'USD', issuer: ACCOUNT_B },
  Asset2: { currency: 'EUR', issuer: ACCOUNT_C },
}, 'AMMDelete');

checkFactory('ammDeposit', xrpjson.ammDeposit, {
  Account: ACCOUNT_A,
  Asset: { currency: 'USD', issuer: ACCOUNT_B },
  Asset2: { currency: 'EUR', issuer: ACCOUNT_C },
  Amount: '100', // Either LPTokenOut or Amount must be set.
  // A deposit mode flag is mandatory. xrpl.org `ammdeposit.md:129` — "You must
  // specify exactly one of these flags" — enforced by rippled's preflight
  // (`AMMDeposit.cpp:72`, `TxFlags.h:409-410`) and by the factory as of
  // xrpjson 1.2.0. This fixture omitted it because the factory used to accept
  // the transaction; the ledger never did.
  Flags: 0x00080000, // tfSingleAsset
}, 'AMMDeposit');

checkFactory('ammVote', xrpjson.ammVote, {
  Account: ACCOUNT_A,
  Asset: { currency: 'USD', issuer: ACCOUNT_B },
  Asset2: { currency: 'EUR', issuer: ACCOUNT_C },
  TradingFee: 100,
}, 'AMMVote');

checkFactory('ammWithdraw', xrpjson.ammWithdraw, {
  Account: ACCOUNT_A,
  Asset: { currency: 'USD', issuer: ACCOUNT_B },
  Asset2: { currency: 'EUR', issuer: ACCOUNT_C },
  // One of the seven withdraw mode flags must be set.
  Flags: AMM_TF_TWO_ASSET,
  Amount: { currency: 'USD', issuer: ACCOUNT_B, value: '100' },
  Amount2: { currency: 'EUR', issuer: ACCOUNT_C, value: '50' },
}, 'AMMWithdraw');

// Batch
checkFactory('batch', xrpjson.batch, {
  Account: ACCOUNT_A,
  Flags: BATCH_TF_INDEPENDENT,
  RawTransactions: [{
    RawTransaction: {
      Flags: 0x40000000, // tfInnerBatchTxn
      Account: ACCOUNT_A,
      TransactionType: 'Payment',
      Destination: ACCOUNT_B,
      Amount: '1000',
      Sequence: 1, // Each inner tx must set Sequence or TicketSequence
    },
  }, {
    RawTransaction: {
      Flags: 0x40000000,
      Account: ACCOUNT_A,
      TransactionType: 'Payment',
      Destination: ACCOUNT_C,
      Amount: '2000',
      Sequence: 2,
    },
  }],
}, 'Batch');

// Check (3)
checkFactory('checkCancel', xrpjson.checkCancel, {
  Account: ACCOUNT_A,
  CheckID: LEDGER_ENTRY_ID,
}, 'CheckCancel');

checkFactory('checkCash', xrpjson.checkCash, {
  Account: ACCOUNT_A,
  CheckID: LEDGER_ENTRY_ID,
  Amount: '1000',
}, 'CheckCash');

checkFactory('checkCreate', xrpjson.checkCreate, {
  Account: ACCOUNT_A,
  Destination: ACCOUNT_B,
  SendMax: '1000000',
}, 'CheckCreate');

// Clawback
checkFactory('clawback', xrpjson.clawback, {
  Account: ACCOUNT_A,
  Amount: { currency: 'USD', issuer: ACCOUNT_B, value: '100' },
}, 'Clawback');

// ConfidentialMPT (5 — ConfidentialTransfer amendment)
checkFactory('confidentialMptClawback', xrpjson.confidentialMptClawback, {
  Account: ACCOUNT_A,
  Holder: ACCOUNT_B,
  MPTokenIssuanceID: MPT_ISSUANCE_ID,
  MPTAmount: '100',
  ZKProof: ZK_PROOF, // 128 hex chars (64 bytes)
}, 'ConfidentialMPTClawback');

checkFactory('confidentialMptConvert', xrpjson.confidentialMptConvert, {
  Account: ACCOUNT_A,
  MPTokenIssuanceID: MPT_ISSUANCE_ID,
  MPTAmount: '100',
  HolderEncryptedAmount: ENCRYPTED_AMOUNT,
  IssuerEncryptedAmount: ENCRYPTED_AMOUNT,
  // BlindingFactor (32 bytes / 64 hex chars)
  BlindingFactor: HEX_64,
}, 'ConfidentialMPTConvert');

checkFactory('confidentialMptConvertBack', xrpjson.confidentialMptConvertBack, {
  Account: ACCOUNT_A,
  MPTokenIssuanceID: MPT_ISSUANCE_ID,
  MPTAmount: '100',
  HolderEncryptedAmount: ENCRYPTED_AMOUNT,
  IssuerEncryptedAmount: ENCRYPTED_AMOUNT,
  BlindingFactor: HEX_64,
  BalanceCommitment: 'A'.repeat(66),
  // ZKProof for ConvertBack is 1632 hex chars (816 bytes)
  ZKProof: 'A'.repeat(1632),
}, 'ConfidentialMPTConvertBack');

checkFactory('confidentialMptMergeInbox', xrpjson.confidentialMptMergeInbox, {
  Account: ACCOUNT_A,
  MPTokenIssuanceID: MPT_ISSUANCE_ID,
}, 'ConfidentialMPTMergeInbox');

checkFactory('confidentialMptSend', xrpjson.confidentialMptSend, {
  Account: ACCOUNT_A,
  Destination: ACCOUNT_B,
  MPTokenIssuanceID: MPT_ISSUANCE_ID,
  MPTAmount: '100',
  SenderEncryptedAmount: ENCRYPTED_AMOUNT,
  DestinationEncryptedAmount: ENCRYPTED_AMOUNT,
  IssuerEncryptedAmount: ENCRYPTED_AMOUNT,
  ZKProof: 'A'.repeat(1892),
  AmountCommitment: 'A'.repeat(66),
  // BalanceCommitment also required
  BalanceCommitment: 'A'.repeat(66),
}, 'ConfidentialMPTSend');

// Credential (3 — XLS-0070)
checkFactory('credentialAccept', xrpjson.credentialAccept, {
  Account: ACCOUNT_A,
  Issuer: ACCOUNT_B,
  // CredentialType must be a hex string per XLS-0070
  CredentialType: HEX_CRED_TYPE,
}, 'CredentialAccept');

checkFactory('credentialCreate', xrpjson.credentialCreate, {
  Account: ACCOUNT_A,
  Subject: ACCOUNT_B,
  CredentialType: HEX_CRED_TYPE,
}, 'CredentialCreate');

checkFactory('credentialDelete', xrpjson.credentialDelete, {
  Account: ACCOUNT_A,
  Subject: ACCOUNT_B,
  Issuer: ACCOUNT_C,
  CredentialType: HEX_CRED_TYPE,
}, 'CredentialDelete');

// Delegate (1 — XLS-0085d)
checkFactory('delegateSet', xrpjson.delegateSet, {
  Account: ACCOUNT_A,
  Authorize: ACCOUNT_B,
  // Permissions array is required (non-empty)
  Permissions: DELEGATE_PERMISSIONS,
}, 'DelegateSet');

// DepositPreauth
checkFactory('depositPreauth', xrpjson.depositPreauth, {
  Account: ACCOUNT_A,
  Authorize: ACCOUNT_B,
}, 'DepositPreauth');

// DID (2 — XLS-0040)
checkFactory('didDelete', xrpjson.didDelete, {
  Account: ACCOUNT_A,
}, 'DIDDelete');

checkFactory('didSet', xrpjson.didSet, {
  Account: ACCOUNT_A,
  URI: HEX_URI,
}, 'DIDSet');

// Escrow (3)
checkFactory('escrowCancel', xrpjson.escrowCancel, {
  Account: ACCOUNT_A,
  Owner: ACCOUNT_B,
  OfferSequence: 5,
}, 'EscrowCancel');

checkFactory('escrowCreate', xrpjson.escrowCreate, {
  Account: ACCOUNT_A,
  Destination: ACCOUNT_B,
  Amount: '1000000',
  FinishAfter: FINISH_AFTER,
  CancelAfter: CANCEL_AFTER,
}, 'EscrowCreate');

checkFactory('escrowFinish', xrpjson.escrowFinish, {
  Account: ACCOUNT_A,
  Owner: ACCOUNT_B,
  OfferSequence: 5,
}, 'EscrowFinish');

// LedgerStateFix
//
// Note: we wrap the standard 3 tests (constructs/toJSON/with) in a single
// describe because the with({Fee:12}) override would violate the
// SpecialTransaction Cost Floor (>= 2_000_000 drops). Instead of using
// checkFactory(), we write a minimal direct test.
test('ledgerStateFix — constructs and freezes with minimal input', () => {
  const tx = xrpjson.ledgerStateFix({
    Account: ACCOUNT_A,
    LedgerFixType: 1,
    Owner: ACCOUNT_B,
    Fee: '2000000',
  });
  ok(tx.TransactionType === 'LedgerStateFix', `TransactionType ${tx.TransactionType}`);
  ok(Object.isFrozen(tx), 'result not frozen');
});
test('ledgerStateFix — with({ Fee: 2000000 }) returns a new frozen object', () => {
  const tx1 = xrpjson.ledgerStateFix({
    Account: ACCOUNT_A,
    LedgerFixType: 1,
    Owner: ACCOUNT_B,
    Fee: '2000000',
  });
  const tx2 = tx1.with({ Fee: '3000000' });
  ok(tx2 !== tx1, 'with() returned same reference');
  ok(Object.isFrozen(tx2), 'new tx not frozen');
  ok(tx2.Fee === '3000000', 'Fee override not applied');
});

// Loan (4)
checkFactory('loanDelete', xrpjson.loanDelete, {
  Account: ACCOUNT_A,
  LoanID: HEX_64, // 64-char hex string (LoanID ledger entry)
}, 'LoanDelete');

checkFactory('loanManage', xrpjson.loanManage, {
  Account: ACCOUNT_A,
  LoanID: HEX_64,
}, 'LoanManage');

checkFactory('loanPay', xrpjson.loanPay, {
  Account: ACCOUNT_A,
  LoanID: HEX_64,
  Amount: '1000',
}, 'LoanPay');

checkFactory('loanSet', xrpjson.loanSet, {
  Account: ACCOUNT_A,
  LoanBrokerID: HEX_64,
  PrincipalRequested: '1000000',
}, 'LoanSet');

// LoanBroker (5)
checkFactory('loanBrokerCoverClawback', xrpjson.loanBrokerCoverClawback, {
  Account: ACCOUNT_A,
  LoanBrokerID: HEX_64,
  Amount: { currency: 'USD', issuer: ACCOUNT_B, value: '100' },
}, 'LoanBrokerCoverClawback');

checkFactory('loanBrokerCoverDeposit', xrpjson.loanBrokerCoverDeposit, {
  Account: ACCOUNT_A,
  LoanBrokerID: HEX_64,
  Amount: '1000000',
}, 'LoanBrokerCoverDeposit');

checkFactory('loanBrokerCoverWithdraw', xrpjson.loanBrokerCoverWithdraw, {
  Account: ACCOUNT_A,
  LoanBrokerID: HEX_64,
  Amount: '1000000',
  Destination: ACCOUNT_B,
}, 'LoanBrokerCoverWithdraw');

checkFactory('loanBrokerDelete', xrpjson.loanBrokerDelete, {
  Account: ACCOUNT_A,
  LoanBrokerID: HEX_64,
}, 'LoanBrokerDelete');

checkFactory('loanBrokerSet', xrpjson.loanBrokerSet, {
  Account: ACCOUNT_A,
  VaultID: HEX_64,
}, 'LoanBrokerSet');

// MPT (4 — XLS-0033)
checkFactory('mptokenAuthorize', xrpjson.mptokenAuthorize, {
  Account: ACCOUNT_A,
  MPTokenIssuanceID: MPT_ISSUANCE_ID,
}, 'MPTokenAuthorize');

checkFactory('mptokenIssuanceCreate', xrpjson.mptokenIssuanceCreate, {
  Account: ACCOUNT_A,
}, 'MPTokenIssuanceCreate');

checkFactory('mptokenIssuanceDestroy', xrpjson.mptokenIssuanceDestroy, {
  Account: ACCOUNT_A,
  MPTokenIssuanceID: MPT_ISSUANCE_ID,
}, 'MPTokenIssuanceDestroy');

checkFactory('mptokenIssuanceSet', xrpjson.mptokenIssuanceSet, {
  Account: ACCOUNT_A,
  MPTokenIssuanceID: MPT_ISSUANCE_ID,
  // One of Holder, MPTokenMetadata, or a flag-modifying flag must be set.
  MPTokenMetadata: HEX_META,
}, 'MPTokenIssuanceSet');

// NFToken (6)
checkFactory('nftokenAcceptOffer', xrpjson.nftokenAcceptOffer, {
  Account: ACCOUNT_A,
  NFTokenSellOffer: LEDGER_ENTRY_ID,
}, 'NFTokenAcceptOffer');

checkFactory('nftokenBurn', xrpjson.nftokenBurn, {
  Account: ACCOUNT_A,
  NFTokenID: LEDGER_ENTRY_ID,
}, 'NFTokenBurn');

checkFactory('nftokenCancelOffer', xrpjson.nftokenCancelOffer, {
  Account: ACCOUNT_A,
  NFTokenOffers: [LEDGER_ENTRY_ID],
}, 'NFTokenCancelOffer');

checkFactory('nftokenCreateOffer', xrpjson.nftokenCreateOffer, {
  Account: ACCOUNT_A,
  NFTokenID: LEDGER_ENTRY_ID,
  Amount: '1000000',
  // Buy offer (no tfSellNFToken) — Owner must be the NFT's issuer
  Owner: ACCOUNT_B,
}, 'NFTokenCreateOffer');

checkFactory('nftokenMint', xrpjson.nftokenMint, {
  Account: ACCOUNT_A,
  NFTokenTaxon: 1,
}, 'NFTokenMint');

checkFactory('nftokenModify', xrpjson.nftokenModify, {
  Account: ACCOUNT_A,
  NFTokenID: LEDGER_ENTRY_ID,
}, 'NFTokenModify');

// Offer (2)
checkFactory('offerCancel', xrpjson.offerCancel, {
  Account: ACCOUNT_A,
  OfferSequence: 5,
}, 'OfferCancel');

checkFactory('offerCreate', xrpjson.offerCreate, {
  Account: ACCOUNT_A,
  TakerPays: '1000000',
  TakerGets: { currency: 'USD', issuer: ACCOUNT_B, value: '100' },
}, 'OfferCreate');

// Oracle (2)
checkFactory('oracleDelete', xrpjson.oracleDelete, {
  Account: ACCOUNT_A,
  OracleDocumentID: 1,
}, 'OracleDelete');

checkFactory('oracleSet', xrpjson.oracleSet, {
  Account: ACCOUNT_A,
  OracleDocumentID: 1,
  // Provider must be hex-encoded (XLS-0073)
  Provider: '70726f76696465722d6e616d65',
  URI: '70726f76696465722d6e616d65',
  LastUpdateTime: 700000000,
  PriceDataSeries: [{
    PriceData: {
      BaseAsset: 'XRP',
      QuoteAsset: 'USD',
      AssetPrice: 100,
      Scale: 1,
    },
  }],
}, 'OracleSet');

// Payment (1)
checkFactory('payment', xrpjson.payment, {
  Account: ACCOUNT_A,
  Destination: ACCOUNT_B,
  Amount: '1000000',
}, 'Payment');

// PaymentChannel (3)
checkFactory('paymentChannelClaim', xrpjson.paymentChannelClaim, {
  Account: ACCOUNT_A,
  Channel: LEDGER_ENTRY_ID,
}, 'PaymentChannelClaim');

checkFactory('paymentChannelCreate', xrpjson.paymentChannelCreate, {
  Account: ACCOUNT_A,
  Destination: ACCOUNT_B,
  Amount: '1000000',
  SettleDelay: 60,
  PublicKey: 'A0'.repeat(33),
}, 'PaymentChannelCreate');

checkFactory('paymentChannelFund', xrpjson.paymentChannelFund, {
  Account: ACCOUNT_A,
  Channel: LEDGER_ENTRY_ID,
  Amount: '1000000',
}, 'PaymentChannelFund');

// PermissionedDomain (2 — XLS-0080)
checkFactory('permissionedDomainDelete', xrpjson.permissionedDomainDelete, {
  Account: ACCOUNT_A,
  DomainID: LEDGER_ENTRY_ID,
}, 'PermissionedDomainDelete');

checkFactory('permissionedDomainSet', xrpjson.permissionedDomainSet, {
  Account: ACCOUNT_A,
  // AcceptedCredentials required
  AcceptedCredentials: [{
    Credential: {
      Issuer: ACCOUNT_B,
      CredentialType: HEX_CRED_TYPE,
    },
  }],
}, 'PermissionedDomainSet');

// SetRegularKey
checkFactory('setRegularKey', xrpjson.setRegularKey, {
  Account: ACCOUNT_A,
  RegularKey: ACCOUNT_B,
}, 'SetRegularKey');

// SignerList
checkFactory('signerListSet', xrpjson.signerListSet, {
  Account: ACCOUNT_A,
  // SignerQuorum must not exceed sum of SignerWeights
  SignerQuorum: 1,
  SignerEntries: [{
    SignerEntry: {
      Account: ACCOUNT_B,
      SignerWeight: 1,
    },
  }],
}, 'SignerListSet');

// Sponsorship (2)
checkFactory('sponsorshipSet', xrpjson.sponsorshipSet, {
  Account: ACCOUNT_A,
  // One of: Sponsee + a fee modification field (FeeAmountDelta,
  // RemainingOwnerCountDelta, MaxFee) OR a RequireSignFor flag.
  Sponsee: ACCOUNT_B,
  FeeAmountDelta: '100',
}, 'SponsorshipSet');

checkFactory('sponsorshipTransfer', xrpjson.sponsorshipTransfer, {
  Account: ACCOUNT_A,
  // Exactly one of the three scenario flags must be set
  Flags: SPONSORSHIP_TF_END,
  // Offer / Account / LedgerEntryID target required
  Offer: ACCOUNT_B,
}, 'SponsorshipTransfer');

// Ticket
checkFactory('ticketCreate', xrpjson.ticketCreate, {
  Account: ACCOUNT_A,
  TicketCount: 1,
}, 'TicketCreate');

// TrustSet
checkFactory('trustSet', xrpjson.trustSet, {
  Account: ACCOUNT_A,
  LimitAmount: { currency: 'USD', issuer: ACCOUNT_B, value: '1000' },
}, 'TrustSet');

// Vault (6 — LendingProtocol amendment)
checkFactory('vaultClawback', xrpjson.vaultClawback, {
  Account: ACCOUNT_A,
  Holder: ACCOUNT_B,
  VaultID: LEDGER_ENTRY_ID,
  // Amount must NOT be XRP drops (must be IOU or MPT)
  Amount: { currency: 'USD', issuer: ACCOUNT_C, value: '100' },
}, 'VaultClawback');

checkFactory('vaultCreate', xrpjson.vaultCreate, {
  Account: ACCOUNT_A,
  // Asset must be a Currency (XRP object, IOU, or MPT) — not the string 'XRP'
  Asset: { currency: 'XRP' },
}, 'VaultCreate');

checkFactory('vaultDelete', xrpjson.vaultDelete, {
  Account: ACCOUNT_A,
  VaultID: LEDGER_ENTRY_ID,
}, 'VaultDelete');

checkFactory('vaultDeposit', xrpjson.vaultDeposit, {
  Account: ACCOUNT_A,
  VaultID: LEDGER_ENTRY_ID,
  Amount: '1000000',
}, 'VaultDeposit');

checkFactory('vaultSet', xrpjson.vaultSet, {
  Account: ACCOUNT_A,
  VaultID: LEDGER_ENTRY_ID,
  // At least one of Data, AssetsMaximum, DomainID required
  // AssetsMaximum must be a non-negative base-10 integer string (drops)
  AssetsMaximum: '1000000',
}, 'VaultSet');

checkFactory('vaultWithdraw', xrpjson.vaultWithdraw, {
  Account: ACCOUNT_A,
  VaultID: LEDGER_ENTRY_ID,
  Amount: '1000000',
  Destination: ACCOUNT_B,
}, 'VaultWithdraw');

// XChain (8 — XLS-38d Sidechain amendment)
checkFactory('xchainAccountCreateCommit', xrpjson.xchainAccountCreateCommit, {
  Account: ACCOUNT_A,
  XChainBridge: XCHAIN_BRIDGE,
  XChainClaimID: '00000000000000000000000000000000000000000000000000000001',
  Amount: '1000000',
  Destination: ACCOUNT_B,
  // SignatureReward required (XRP drops, ≥ 0)
  SignatureReward: '100',
}, 'XChainAccountCreateCommit');

checkFactory('xchainAddAccountCreateAttestation', xrpjson.xchainAddAccountCreateAttestation, {
  Account: ACCOUNT_A,
  XChainBridge: XCHAIN_BRIDGE,
  XChainClaimID: '00000000000000000000000000000000000000000000000000000001',
  Amount: '1000000',
  AttestationSignerAccount: ACCOUNT_B,
  Destination: ACCOUNT_C,
  Signature: 'A'.repeat(256),
  PublicKey: 'A0'.repeat(33),
  AttestationRewardAccount: ACCOUNT_A,
  AttestationRewardAmount: '100',
  OtherChainSource: ACCOUNT_B,
  SignatureReward: '100',
  WasLockingChainSend: 1,
  // XChainAccountCreateCount required (UInt64)
  XChainAccountCreateCount: '1',
}, 'XChainAddAccountCreateAttestation');

checkFactory('xchainAddClaimAttestation', xrpjson.xchainAddClaimAttestation, {
  Account: ACCOUNT_A,
  XChainBridge: XCHAIN_BRIDGE,
  XChainClaimID: '00000000000000000000000000000000000000000000000000000001',
  Amount: '1000000',
  AttestationSignerAccount: ACCOUNT_B,
  Signature: 'A'.repeat(256),
  PublicKey: 'A0'.repeat(33),
  AttestationRewardAccount: ACCOUNT_A,
  AttestationRewardAmount: '100',
  OtherChainSource: ACCOUNT_B,
  SignatureReward: '100',
  // WasLockingChainSend (UInt8 boolean)
  WasLockingChainSend: 1,
}, 'XChainAddClaimAttestation');

checkFactory('xchainClaim', xrpjson.xchainClaim, {
  Account: ACCOUNT_A,
  XChainBridge: XCHAIN_BRIDGE,
  XChainClaimID: '00000000000000000000000000000000000000000000000000000001',
  Amount: '1000000',
  Destination: ACCOUNT_B,
}, 'XChainClaim');

checkFactory('xchainCommit', xrpjson.xchainCommit, {
  Account: ACCOUNT_A,
  XChainBridge: XCHAIN_BRIDGE,
  XChainClaimID: '00000000000000000000000000000000000000000000000000000001',
  Amount: '1000000',
}, 'XChainCommit');

checkFactory('xchainCreateBridge', xrpjson.xchainCreateBridge, {
  Account: ACCOUNT_A,
  XChainBridge: XCHAIN_BRIDGE,
  SignatureReward: '100',
}, 'XChainCreateBridge');

checkFactory('xchainCreateClaimID', xrpjson.xchainCreateClaimID, {
  Account: ACCOUNT_A,
  XChainBridge: XCHAIN_BRIDGE,
  SignatureReward: '100',
  OtherChainSource: ACCOUNT_B,
}, 'XChainCreateClaimID');

checkFactory('xchainModifyBridge', xrpjson.xchainModifyBridge, {
  Account: ACCOUNT_A,
  XChainBridge: XCHAIN_BRIDGE,
  SignatureReward: '100',
}, 'XChainModifyBridge');

// ─── Summary ────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(45)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log(`\nFirst 20 failures:`);
  for (const f of failures.slice(0, 20)) {
    console.log(`  ✗ ${f.name}: ${f.error}`);
  }
  process.exit(1);
}