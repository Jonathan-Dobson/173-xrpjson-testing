// xrpjson 1.0.2 exposes its functional factories from the documented root.
export * from 'xrpjson';
export { ValidationError, TransactionError } from './node_modules/xrpjson/dist/errors.js';
export * from './node_modules/xrpjson/dist/types/flags.js';

// Temporary aliases for the integration suites. Calling an xrpjson factory
// with `new` still returns its frozen result, which lets the ledger tests
// migrate independently from their existing transaction setup.
export {
  payment as PaymentTx,
  accountSet as AccountSetTx,
  trustSet as TrustSetTx,
  escrowCreate as EscrowCreateTx,
  escrowFinish as EscrowFinishTx,
  escrowCancel as EscrowCancelTx,
  nftokenMint as NFTokenMintTx,
  nftokenBurn as NFTokenBurnTx,
  nftokenCreateOffer as NFTokenCreateOfferTx,
  nftokenAcceptOffer as NFTokenAcceptOfferTx,
  offerCreate as OfferCreateTx,
  offerCancel as OfferCancelTx,
  checkCreate as CheckCreateTx,
  checkCash as CheckCashTx,
  checkCancel as CheckCancelTx,
  mptokenIssuanceCreate as MPTokenIssuanceCreateTx,
  mptokenIssuanceSet as MPTokenIssuanceSetTx,
  mptokenIssuanceDestroy as MPTokenIssuanceDestroyTx,
  mptokenAuthorize as MPTokenAuthorizeTx,
  clawback as ClawbackTx,
  ammCreate as AMMCreateTx,
} from 'xrpjson';