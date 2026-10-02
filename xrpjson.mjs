// xrpjson 1.1.0 exposes its functional factories, errors, and flag enums
// via the public exports map. Use the documented bare-specifier subpaths
// so the shim doesn't depend on internal dist/ paths.
//
// NB: `ValidationError` and the `*Flags` enums are NOT on the root entry —
// they live on the `xrpjson/errors` and `xrpjson/flags` subpaths. Any code
// importing them from bare `xrpjson` gets `undefined`, which makes
// `err instanceof ValidationError` silently false. Always route through
// this shim rather than the root specifier.
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