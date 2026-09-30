// xrpjson 1.0.5 exposes its functional factories, errors, and flag enums
// via the public exports map. Use the documented bare-specifier subpaths
// so the shim doesn't depend on internal dist/ paths.
export * from 'xrpjson';
export { ValidationError, TransactionError } from 'xrpjson/errors';
export * from 'xrpjson/flags';

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