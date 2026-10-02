# User stories — xrpjson integration coverage

This document is the **spec** for the user stories implemented in
`integration/tests/12-nft-lifecycle.mjs` and
`integration/tests/13-account-admin.mjs`. The tests are written against these
stories; if a test and a story disagree, the story is the intent and the test
is the bug.

Suites [1]–[11] already carry 70 user stories. They cover the *value-transfer*
core: payments, trust lines, DEX offers, escrow, checks, NFTs, MPTs, and the
IOU lifecycle. What they do not cover is **account control** — who is allowed
to move funds, and how a token's metadata is managed after minting. Those are
the two gaps this document closes.

## How to read a story

Each story carries:

- **Story** — the user-facing goal, in user language.
- **Factory** — the xrpjson factory that builds it.
- **Acceptance** — the observable, testable conditions. The integration test
  asserts every one of these.
- **Ledger** — the expected result code. `tesSUCCESS` unless noted.
- **Why** — the canonical source, cited so a behavioural question can be
  settled against the spec rather than by experiment.

## Coverage added

| Suite | Stories | Factories exercised |
|---|---|---|
| [12] NFT lifecycle | 8 | `nftokenModify`, `nftokenCancelOffer`, `nftokenAcceptOffer`, `nftokenCreateOffer`, `nftokenMint` |
| [13] Account admin | 12 | `setRegularKey`, `signerListSet`, `depositPreauth`, `ticketCreate`, `accountDelete` |

`nftokenMint` and `nftokenCreateOffer` appear in [12] as **setup**, not as
stories in their own right — [8] already covers them directly. [12] is
self-contained and mints its own tokens rather than depending on [8]'s state.

---

# [12] NFT lifecycle

Suite [8] covers mint → sell → accept → burn. It does not cover three things
that every marketplace UI has to do: **edit the metadata**, **withdraw an
offer**, and **accept the other side of a bid**. Those are [12].

## NFT-1 — Update an NFT's metadata URI

> **Story.** As the owner of an NFT, I want to change the URI that points at
> its metadata, so that I can update the artwork or details without minting a
> new token and breaking the token ID.

**Factory.** `nftokenModify({ Account, NFTokenID, URI })`

**Acceptance.**
- Submitting with a new hex-encoded `URI` returns `tesSUCCESS`.
- The ledger stores the new URI on the `NFToken` object.
- A URI longer than 256 bytes is rejected *at construction* by xrpjson, not at
  the ledger.

**Why.** xrpl.org `nftokenmodify.md`: `URI` is a "URI to retrieve the token's
metadata", hex-encoded Blob. Omitting the field removes the existing URI.

**Note.** Only the token's **owner**, or an **authorized minter / issuer**,
may modify it. Every story in this section that modifies a token is performed
by its current owner so the suite stays single-writer and order-independent.

## NFT-2 — Remove an NFT's metadata URI

> **Story.** As the owner of an NFT, I want to clear its metadata URI, so that
> I can strip the token back to a bare, metadata-free asset.

**Factory.** `nftokenModify({ Account, NFTokenID })` — `URI` omitted.

**Acceptance.**
- Submitting with `URI` absent returns `tesSUCCESS`.
- The ledger no longer stores a URI on the token.
- This is the *clear* path — it is not the same as setting `URI` to empty
  string, which xrpjson rejects as an invalid hex Blob.

**Why.** xrpl.org `nftokenmodify.md`: omitting `URI` removes the existing URI.
The older `clear` flag was removed in favour of this.

## NFT-3 — Update metadata after the token has been sold

> **Story.** As the issuer, I want to keep updating a token's metadata after it
> has been sold to someone else, so that provenance and metadata stay under my
> control rather than transferring with the token.

> **⚠️ The intuitive reading of this story is wrong**, and the integration
> suite exists partly to prove it. Metadata control does **not** follow
> ownership.
>
> **Canonical source** — xrpl.org, *Dynamic Non-Fungible Tokens (dNFTs)*:
> > "The issuer, or their authorized minter, can modify a dNFT at any time, by
> > sending a NFTokenModify transaction. Only the `URI` field of the NFT can be
> > changed this way."
>
> Confirmed in rippled `NFTokenModify::preflight`, which gates on
> **issuer or authorized minter**, not owner:
>
> ```cpp
> // Check if the NFT is mutable
> if ((nft::getFlags(ctx.tx[sfNFTokenID]) & nft::kFlagMutable) == 0)
>     return tecNO_PERMISSION;
> // Verify permissions for the issuer
> if (AccountID const issuer = nft::getIssuer(ctx.tx[sfNFTokenID]); issuer != account)
> { ... if (auto const minter = (*sle)[~sfNFTokenMinter]; minter != account)
>     return tecNO_PERMISSION; }
> ```
>
> A buyer who holds the token cannot change its URI. The issuer can, and must
> name the current holder in `Owner`.

**Factory.** `nftokenModify({ Account: issuer, NFTokenID, Owner, URI })`

**Setup.** This story follows the transfer in NFT-6: Bob bids, Alice accepts, and
Bob now holds the token.

**Acceptance.**
- The **issuer** can modify the URI after the transfer, by supplying `Owner`
  as the new holder.
- The **owner** (Bob) is refused — `tecNO_PERMISSION`.
- An unrelated third party is also refused.

The two negative cases are the point. A test that only asserted "the issuer can
still edit it" would pass under either rule and prove nothing.

**Also required.** The token must have been minted with `tfMutable` (flag
`0x00000010`) — xrpl.org *Dynamic NFTs*: "When minting a new NFT, enable the
`tfMutable` flag (`0x00000010`) to make the NFT mutable." Without it, *every*
`NFTokenModify` is refused with `tecNO_PERMISSION`, including the issuer's.
Suite [12] mints with `tfTransferable | tfMutable` because it needs both:
transfer for the buy and brokered stories, mutability for these.

## NFT-4 — Withdraw a sell offer

> **Story.** As a seller, I want to withdraw my sell offer, so that a listing
> I no longer want does not sit on the order book.

**Factory.** `nftokenCreateOffer({ ..., Flags: tfSellNFToken })` then
`nftokenCancelOffer({ Account, NFTokenOffers: [offerIndex] })`

**Acceptance.**
- The offer is created and its index is captured from the submit metadata.
- Cancelling by that index returns `tesSUCCESS`.
- The offer no longer exists in the ledger afterwards — verified by reading
  the owner's `NFTokenOffer` objects, not by re-submitting the cancel.

**Note on the obvious negative case.** Re-submitting `NFTokenCancelOffer` for
an already-cancelled index does **not** fail; rippled treats it as a no-op and
returns `tesSUCCESS`. So "the second cancel is rejected" is a false
assertion. The meaningful check is that the offer is really gone.

**Why.** xrpl.org `nftokencanceloffer.md`: `NFTokenOffers` is a required array
of the indices of the offers to cancel, and the submitter must be the offer's
creator.

## NFT-5 — Withdraw a buy offer (bid)

> **Story.** As a bidder, I want to withdraw my bid, so that I stop being
> committed to an NFT I no longer want.

**Factory.** `nftokenCreateOffer({ Account, NFTokenID, Amount, Owner })` — a
**buy** offer has no `tfSellNFToken` and requires `Owner` — then
`nftokenCancelOffer`.

**Acceptance.**
- A buy offer is created and its index captured.
- The bidder can cancel their own buy offer with `tesSUCCESS`.
- This is the same `nftokenCancelOffer` factory as NFT-4 with a different
  offer kind, which is the point: the cancellation path is kind-agnostic.

## NFT-6 — Accept a bid as the owner (the buy side)

> **Story.** As a seller, I want to accept a bidder's bid and sell my token at
> the bid price, so that a buyer who bids high does not have to wait for me to
> counter-offer.

**Factory.** `nftokenCreateOffer` (buy side, by Bob) then
`nftokenAcceptOffer({ Account: owner, NFTokenBuyOffer: offerIndex })`

**Acceptance.**
- Bob (a non-owner) creates a buy offer for Alice's token, supplying `Owner`
  as Alice.
- Alice accepts it with `tesSUCCESS` via `NFTokenBuyOffer`.
- The token's owner is Bob afterwards.
- A buy offer **requires** `Owner`; xrpjson rejects one without it at
  construction.

**Why.** xrpl.org `nftokencreateoffer.md`: for a buy offer, `Owner` is
required and `tfSellNFToken` must not be set. `nftokenacceptoffer.md`: use
`NFTokenBuyOffer` when the submitter is the token's owner accepting a bid.

**Contrast with [8].** [8] has Bob accepting Alice's **sell** offer, which is
the `NFTokenSellOffer` field. Both fields are exercised across the two suites;
neither suite covers the other side on its own.

## NFT-7 — Brokered sale with a broker fee

> **Story.** As a marketplace operator, I want to match a buyer and seller and
> take a fee from the spread, so that I can operate a venue without taking
> custody of the token.

**Factory.** `nftokenAcceptOffer({ Account: broker, NFTokenSellOffer,
NFTokenBuyOffer, NFTokenBrokerFee })`

**Setup.** Alice posts a sell offer at 10 XRP. Bob posts a buy offer at 12 XRP.
Carol (the broker) matches them.

**Acceptance.**
- The matched sale returns `tesSUCCESS`.
- The token transfers from Alice to Bob — the broker never holds it.
- Carol nets exactly `NFTokenBrokerFee` **minus the transaction fee she paid
  to make the match**. Asserting `gained >= fee` is wrong by precisely that
  fee and fails on every run; the net must be computed against the submitted
  transaction's `Fee`.
- `NFTokenBrokerFee` must be **strictly positive**, and requires **both** the
  sell and buy offer ids — xrpjson rejects a broker fee with only one of them.
- The buy price must exceed the sell price; a broker fee that would make the
  broker pay the buyer is rejected by the ledger.

**Why.** xrpl.org `nftokenacceptoffer.md`, "Brokered Sale": both
`NFTokenSellOffer` and `NFTokenBuyOffer` are required, and
`NFTokenBrokerFee` is taken from the difference between the two offers.

**Why this matters for xrpjson.** Brokered mode is the single most
marketplace-specific field in the NFToken family, and it is validated as a
strictly-positive `Amount` rather than being passed through unvalidated. It is
the clearest example of the package's "stricter than the class API" stance.

## NFT-8 — Reject a broker fee that is not positive

> **Story.** As a developer, I want a zero or negative broker fee to be
> rejected before I hit the ledger, so that a miscalculated fee surfaces as a
> clear validation error rather than a `tem*` rejection.

**Factory.** `nftokenAcceptOffer`

**Acceptance.**
- `NFTokenBrokerFee: '0'` throws `ValidationError` at construction.
- A negative broker fee throws `ValidationError` at construction.
- This is a *unit-level* assertion repeated here so the guarantee travels with
  the integration suite's story set.

---

# [13] Security & account admin

Everything in [1]–[12] assumes one key controls one account. This suite covers
the primitives that assumption is built on. These are the transactions an
exchange or custodian runs constantly and that the existing suite never
touches.

## ADM-1 — Set a regular key

> **Story.** As a custodian, I want to designate a separate regular key for an
> account, so that routine signing can use a low-value hot key while the
> master key stays offline.

**Factory.** `setRegularKey({ Account, RegularKey })`

**Acceptance.**
- Setting a regular key to a different, unfunded-but-valid address returns
  `tesSUCCESS`.
- The ledger records the regular key against the account.
- `RegularKey` must not equal `Account` — xrpjson rejects self-assignment at
  construction (`temBAD_REGKEY` would be the ledger's code).

**Why.** xrpl.org `setregularkey.md` Fields table: "Must not match the master
key pair for the address." rippled `SetRegularKey::preflight` returns
`temBAD_REGKEY` when `sfRegularKey == sfAccount`.

## ADM-2 — Sign a payment with the regular key

> **Story.** As a hot-key operator, I want to submit a payment signed by the
> regular key rather than the master key, so that the master key can be kept
> off the signing host entirely.

**This is the story that makes ADM-1 real.** A `SetRegularKey` that is never
used to sign proves nothing — the ledger could ignore it. This story
demonstrates the delegation actually works.

**Setup.** Alice's regular key is a freshly generated wallet whose seed is
controlled by the test.

**Acceptance.**
- A payment whose `Account` is Alice but which is **signed by the regular
  key's** private key returns `tesSUCCESS`.
- Alice's balance decreases and the destination's increases.
- The master key's signature is not used anywhere in this story.

**Mechanism.** `Wallet.sign()` in xrpl 4.6.0 sets `SigningPubKey` from the
signing wallet's own public key and leaves `Account` untouched. So a
regular-key wallet signing an `Account: alice` transaction produces exactly
the wire form the ledger expects. No post-processing required.

## ADM-3 — Rotate the regular key

> **Story.** As a custodian, I want to replace the regular key with a new one,
> so that a compromised hot key can be rotated out without touching funds.

**Factory.** `setRegularKey({ Account, RegularKey: <new> })`

**Acceptance.**
- Replacing an existing regular key returns `tesSUCCESS`.
- After rotation, a payment signed by the **old** key is rejected, and a
  payment signed by the **new** key succeeds. Asserting both halves is what
  distinguishes a real rotation from a cosmetic one.

## ADM-4 — Remove the regular key

> **Story.** As a custodian, I want to remove the regular key, so that signing
> authority returns solely to the master key.

**Factory.** `setRegularKey({ Account })` — `RegularKey` omitted.

**Acceptance.**
- Omitting `RegularKey` returns `tesSUCCESS` and clears the regular key.
- A subsequent payment signed by the former regular key is rejected.

**Why.** xrpl.org `setregularkey.md`: "If omitted, removes any existing
regular key pair from the account."

**Why this story is load-bearing.** `AccountDelete` (ADM-12) fails with
`tecNO_REGULAR_KEY` while any regular key is set. This story is what makes
ADM-12 reachable later in the same suite.

## ADM-5 — Create a signer list

> **Story.** As a treasury owner, I want to set up a signer list, so that no
> single compromised key can move the account's funds.

**Factory.** `signerListSet({ Account, SignerQuorum, SignerEntries })`

**Acceptance.**
- A list with quorum 1 and one signer returns `tesSUCCESS`.
- xrpjson enforces, at construction: 1–32 members, positive integer weights,
  `1 <= SignerQuorum <= sum(weights)`, unique signer addresses, and no signer
  equal to the sending account.

**Why.** xrpl.org `signerlistset.md`: the list "must have at least 1 member and
no more than 32 members"; "The `SignerQuorum` must be greater than 0 but less
than or equal to the sum of the `SignerWeight` values"; "No address may appear
more than once"; "nor may the `Account` submitting the transaction appear in
the list". rippled's counterparts are `temBAD_QUORUM`, `temBAD_SIGNER`,
`temBAD_WEIGHT`.

## ADM-6 — Submit a multisigned payment

> **Story.** As a treasury owner, I want the quorum to actually be enforced on
> a real payment, so that I know the signer list is doing something.

**Again the story that makes the previous one real.** Creating a list proves
nothing if any key can sign anyway.

**Acceptance.**
- A payment built by the `payment` factory and **multisigned** by the list's
  signer returns `tesSUCCESS`.
- The multisigned transaction carries `SigningPubKey: ''` and a populated
  `Signers` array.
- A multisignature from an account **not** in the signer list is refused.

**Fee is part of the contract.** xrpl.org `multi-signing.md` § "Sending
Multi-Signed Transactions": "The transaction cost (specified in the `Fee`
field) must be at least **(N+1) times the normal transaction cost**, where N
is the number of signatures provided." `client.autofill` computes only the
incremental (base) cost, so the signer count must be passed explicitly —
`client.autofill(tx, 1)`. Omitting it yields `telINSUF_FEE_P`, which reads
like a funding problem and is not one.

**Mechanism.** `Wallet.sign(tx, signerAddress)` emits a blob with
`SigningPubKey: ''` and a one-entry `Signers` array; the standalone
`multisign([...])` export combines and validates the signatures. Note that
`client.multisign()` and `client.signers` **do not exist** in xrpl 4.6.0 —
older examples in the wild will not run.

### A correction worth stating, because the obvious assumption is wrong

A signer list does **not** disable the master key. xrpl.org
`multi-signing.md`: "You can have any combination of authorization methods
enabled for your address, including multi-signing, a master key pair, and a
regular key pair." and, of the recommended setups, "you would **disable the
master key** without configuring a regular key, so that multi-signing is the
only way of authorizing transactions."

So a master-key-only payment still succeeds while a signer list exists, unless
the master key is explicitly disabled with `AccountSet`. The constraint the
list *does* enforce is over the `Signers` array: a signature from an account
not on the list does not count toward the quorum. That is what the negative
case asserts, and it is why the suite funds Dave.

Disabling the master key is deliberately **not** exercised here:
`AccountSet` + `asfDisableMaster` is irreversible, and on a shared test
wallet it would brick the account for every later suite.

## ADM-7 — Remove the signer list

> **Story.** As a treasury owner, I want to remove the signer list, so that
> the account returns to ordinary single-signature operation.

**Factory.** `signerListSet({ Account, SignerQuorum: 0 })` — `SignerEntries`
**omitted**.

**Acceptance.**
- Quorum 0 with `SignerEntries` omitted returns `tesSUCCESS`.
- xrpjson rejects quorum 0 **with** entries present, at construction.
- After removal, an ordinary single-signed payment succeeds again.

**Why.** xrpl.org `signerlistset.md`: "To delete a signer list, you must set
`SignerQuorum` to `0` *and* omit the `SignerEntries` field. Otherwise, the
transaction fails with the error `temMALFORMED`."

**Why this story is load-bearing.** `AccountDelete` (ADM-12) fails with
`tecNO_SIGNER_LIST` while a signer list exists. Same dependency as ADM-4.

## ADM-8 — Preauthorize a depositor

> **Story.** As an exchange, I want to preauthorize a depositor, so that
> they can send me payments without per-deposit approval.

**Factory.** `depositPreauth({ Account, Authorize })`

**Acceptance.**
- Preauthorizing a different account returns `tesSUCCESS`.
- `Authorize` must differ from `Account` — xrpjson rejects self-preauth at
  construction (`temCANNOT_PREAUTH_SELF`).

**Why.** xrpl.org `depositpreauth.md` Error Cases: `temCANNOT_PREAUTH_SELF`,
"You cannot preauthorize yourself". The transaction can be submitted ahead of
time — it does not require the account to have deposit auth enabled yet.

## ADM-9 — Revoke preauthorization

> **Story.** As an exchange, I want to revoke a depositor's preauthorization,
> so that they can no longer send me payments.

**Factory.** `depositPreauth({ Account, Unauthorize })`

**Acceptance.**
- Revoking returns `tesSUCCESS`.
- `Authorize` and `Unauthorize` are mutually exclusive — xrpjson enforces a
  four-way XOR (`Authorize`, `Unauthorize`, `AuthorizeCredentials`,
  `UnauthorizeCredentials`) and rejects any combination at construction.

**Why.** xrpl.org `depositpreauth.md`: "You must provide exactly one of …"
xrpl.js `validateSingleAuthorizationFieldProvided` enforces the same XOR.

## ADM-10 — Pre-create tickets

> **Story.** As a high-volume sender, I want to pre-create a batch of tickets,
> so that I can submit many transactions without managing sequence numbers.

**Factory.** `ticketCreate({ Account, TicketCount })`

**Acceptance.**
- Creating a batch of tickets returns `tesSUCCESS`.
- `TicketCount` must be 1–256; xrpjson rejects 0 and values above 256 at
  construction.

**Why.** xrpl.org `ticketcreate.md`: `TicketCount` is a UInt8, 1–256.

## ADM-11 — Spend a ticket on a payment

> **Story.** As a high-volume sender, I want a payment to consume a ticket
> instead of a sequence number, so that concurrent submissions do not collide.

> **⚠️ Known gap — read before implementing.** xrpjson has **no top-level
> factory that exposes `TicketSequence`**. `TicketSequence` appears only in
> `Batch`, for inner transactions, and in an internal base type that no
> exported factory uses. A ticketed standalone `Payment` therefore has to be
> assembled as `payment({...}).toJSON()` plus a `Sequence: 0` /
> `TicketSequence: N` merge, which is outside the factory's validation.

**Acceptance.**
- A payment carrying `Sequence: 0` and `TicketSequence: N` returns
  `tesSUCCESS` and the funds move.
- A second payment using the **same** ticket is rejected by the ledger,
  proving the ticket was genuinely consumed rather than ignored.
- The xrpjson `payment` factory builds the tx *without* `TicketSequence`; the
  story records that the field is added post-construction.

**Why this is a documented gap rather than a bug to work around silently.**
`TicketCreate` is fully supported, so a user can create tickets and then find
that no factory can spend them. The same pattern as
[DIVERGENCES.md](./DIVERGENCES.md) Bug #2, where a required field was missing
from the factory's props.

## ADM-12 — Delete a throwaway account

> **Story.** As a user closing out an account, I want to delete it and reclaim
> the remaining XRP, so that the reserve is not locked forever.

**Factory.** `accountDelete({ Account, Destination })`

**This story runs on a dedicated throwaway wallet**, never on Alice or Bob,
because it destroys the account.

**Acceptance.**
- Deleting the account returns `tesSUCCESS`.
- The destination receives the leftover XRP.
- `Destination` must be a funded account and must not be the sender —
  xrpjson rejects self-destination at construction (`temDST_IS_SRC`).

**Preconditions the ledger enforces, and this suite therefore satisfies in
order.** `AccountDelete` fails unless the account owns *nothing*:

| Object still present | Ledger error | Story that clears it |
|---|---|---|
| Regular key set | `tecNO_REGULAR_KEY` | ADM-4 |
| Signer list present | `tecNO_SIGNER_LIST` | ADM-7 |
| Trust lines | `tecINCOMPLETE_INDICATOR` | (throwaway has none) |
| DEX offers | `tecINCOMPLETE_INDICATOR` | (throwaway has none) |
| NFT pages | `tecINCOMPLETE_INDICATOR` | (throwaway has none) |
| Negative UNL | `tecINCOMPLETE_INDICATOR` | (throwaway has none) |

This ordering is the real dependency structure of the suite: ADM-4 and ADM-7
are not just good hygiene, they are what makes ADM-12 possible. The throwaway
wallet is funded fresh from the faucet precisely so it carries none of the
objects Alice and Bob accumulate across [1]–[11].

**Why.** xrpl.org `accountdelete.md`; rippled `AccountDelete::preflight` and
`doApply`.

---

# Open findings for DIVERGENCES.md

These came out of writing the stories and are not covered by an upstream fix
yet.

## Finding A — No factory exposes `TicketSequence` (ADM-11)

`TicketCreate` is supported, but no top-level factory can spend a ticket.
Verified against the installed `xrpjson@1.1.0`:

```
grep -r "TicketSequence" node_modules/xrpjson/dist/fp/factories/*.d.ts
  → batch.d.ts only (inner transactions)
```

Every other top-level factory omits it. A user who creates a ticket has to
merge the field in by hand, outside the validated path. Worth reporting
upstream alongside Bug #2, which was the same shape of omission.

## Finding B — `nftokenModify` ownership is not enforced at construction

`nftokenModify` validates `Account`, `NFTokenID`, and `URI`, but whether the
submitter may modify a given token depends on the token's *on-ledger* owner and
authorized-minters list, which a pure factory cannot see. So the constraint is
enforced by the ledger (`tem*`), not at construction. This is inherent to the
problem rather than a defect, and the story documents it so nobody reads the
missing guard as an oversight — but it is worth stating explicitly.

---

# [14] AMM deposit flag contract

This section exists to verify one specific rule against the live ledger:
**an `AMMDeposit` must carry exactly one deposit-mode flag.** It is the first
live check of the fix for [DIVERGENCES.md](./DIVERGENCES.md) Bug #6, where
`ammDeposit` previously performed no flag validation at all while its sibling
`ammWithdraw` enforced the identical rule.

## The contract, from source

rippled applies **two independent checks** to `AMMDeposit` flags, in this order:

1. **Membership** — `AMMDeposit::getFlagsMask` returns `tfAMMDepositMask`,
   built by `TO_MASK` as `~(tfUniversal | <six deposit flags>)` (`TxFlags.h`
   lines 264-266, 169-176). `tfUniversal` is only `tfFullyCanonicalSig |
   tfInnerBatchTxn` (lines 43-46). Any *other* bit set in `Flags` is not in
   the mask, and the whole transaction is refused with `temINVALID_FLAG`.
2. **Cardinality** — `AMMDeposit::preflight` runs
   `std::popcount(flags & tfDepositSubTx) != 1` → `temMALFORMED`
   (`AMMDeposit.cpp:72`), where `tfDepositSubTx` is the six deposit bits
   (`TxFlags.h:409-410`).

The mask is **sparse**: `0x00020000` (`tfWithdrawAll`) and `0x00040000`
(`tfOneAssetWithdrawAll`) are `AMMWithdraw` modes, so they are absent from
`tfDepositSubTx`. A naive `popcount(Flags)` would miscount a withdraw bit as
a second deposit mode. That is why the fixed factory masks before counting.

xrpl.org `ammdeposit.md:129` states the same rule in the same words as
`ammwithdraw.md:107`: "You must specify **exactly one** of these flags, plus
any global flags."

The six deposit modes, from `TxFlags.h:169-176` (identical to the xrpjson
`AMMDepositFlags` enum and to xrpl.js's):

| Flag | Hex | Mode |
|---|---|---|
| `tfLPToken` | `0x00010000` | double-asset deposit for a specified LP amount |
| `tfSingleAsset` | `0x00080000` | single-asset deposit with a specified amount |
| `tfTwoAsset` | `0x00100000` | double-asset deposit with both amounts |
| `tfOneAssetLPToken` | `0x00200000` | single-asset deposit for a specified LP amount |
| `tfLimitLPToken` | `0x00400000` | single-asset deposit at a specified effective price |
| `tfTwoAssetIfEmpty` | `0x00800000` | special deposit into an empty pool |

## AMM-1 — The ledger refuses a deposit with no mode flag

> **Story.** As a caller who has lost track of the flags, I want the ledger to
> reject my deposit immediately and say so, rather than accepting a transaction
> whose meaning is undefined.

**Acceptance.** An `AMMDeposit` submitted with `Flags` absent is rejected with
`temMALFORMED`.

## AMM-2 — The ledger refuses a deposit with two mode flags

> **Story.** As a caller combining options by mistake, I want the ambiguous
> deposit refused rather than silently resolved to one of the two modes.

**Acceptance.** `Flags: tfSingleAsset | tfTwoAsset` is rejected with
`temMALFORMED`.

## AMM-3 — Exactly one mode flag passes the flag check

> **Story.** As a caller who set the flag correctly, I want to be sure the flag
> is actually *read* by the ledger rather than ignored, so that a transaction
> rejected for an unrelated reason still proves the flag was honoured.

**Acceptance.** `Flags: tfSingleAsset` is **not** rejected as malformed or
flagged. It proceeds past both flag checks and fails later, on the deposit's
own terms — observed as `temBAD_AMM_TOKENS` with no AMM present.

> Asserting the *specific* later code is deliberately loose. The point of this
> story is that the flag check passed, not what the deposit validation said.
> Pinning `temBAD_AMM_TOKENS` would make the test fail the moment rippled
> improves that message without any change to the rule under test.

## AMM-4 — A universal flag does not count toward the mode count

> **Story.** As a caller who always sets `tfFullyCanonicalSig`, I want that flag
> to be compatible with a normal deposit rather than being miscounted as a
> second mode.

**Acceptance.** `Flags: tfSingleAsset | tfFullyCanonicalSig` passes both flag
checks. `tfFullyCanonicalSig` is `0x80000000` and is in `tfUniversal`
(`TxFlags.h:43`), so the ledger must permit it. Assert the *permitted* half;
the forbidden half (a bit outside the mask) is AMM-5.

> ⚠️ **Implementation trap, found the hard way.** `0x80000000` does not fit a
> *signed* 32-bit integer, so `0x00080000 | 0x80000000` evaluates to a
> **negative** number in JavaScript. xrpl.js then refuses to serialise the
> transaction and throws a client-side error before anything reaches the
> ledger. The first version of this test passed anyway, because it only
> asserted "not temMALFORMED, not temINVALID_FLAG" — and a client-side error
> satisfies both. Compose such a value with `>>> 0`, and have the helper
> return client-side failures under a distinct prefix so they can never be
> read as the ledger accepting something.

## AMM-5 — A flag from another transaction type is refused

> **Story.** As a caller reusing a flags constant from the wrong transaction, I
> want the ledger to refuse it rather than treat the unknown bit as a mode.

**Acceptance.** `Flags: tfSingleAsset | tfWithdrawAll` (`0x00020000`) is
rejected with `temINVALID_FLAG` — **not** `temMALFORMED`. That distinct code is
the evidence that the membership check ran and failed, which is a different
check from the cardinality one.

> ⚠️ **This is where the factory and the ledger disagree.** The fixed
> `ammDeposit` implements only the *cardinality* check, so it accepts this
> combination; the ledger refuses it. Tracked as Bug #7 in
> [DIVERGENCES.md](./DIVERGENCES.md). The unit test pins the factory's current
> behaviour deliberately; this story records the ledger's.

## Setup note — no AMM is required

The flag check is **preflight**, so it runs before any AMM state is consulted.
Every story above is therefore decided without creating a pool, funding an
issuer, or building a trust line. That is a property of the rule, not a
shortcut: it is precisely what makes the failure cheap to detect and cheap to
test.

Creating a real AMM and completing a deposit is *not* covered here. It would
prove the ledger accepts a well-formed deposit, but it is expensive setup
(AMMCreate charges an owner reserve, and a two-asset pool needs an issued
currency) for a fact the AMM amendment documentation already states. AMM-3's
loose assertion is the honest version of "the ledger got far enough to care
about the deposit's contents".

## Sources

- rippled `src/libxrpl/tx/transactors/dex/AMMDeposit.cpp:51-75` — both checks
- rippled `src/libxrpl/protocol/TxFlags.h:43-46, 169-176, 264-266, 407-410`
- xrpl.org `ammdeposit.md:120-129`; `ammwithdraw.md:107`
- xrpl.js `packages/xrpl/src/models/transactions/AMMDeposit.ts:18-34`
- Testnet `feature` command: `AMM` reported `enabled=true, supported=true`

## Observed on testnet (ledger 21219576)

| Story | `Flags` | Ledger result |
|---|---|---|
| AMM-1 | absent | `temMALFORMED` |
| AMM-2 | `tfSingleAsset \| tfTwoAsset` | `temMALFORMED` |
| AMM-3 | `tfSingleAsset` | `temBAD_AMM_TOKENS` — flag check passed |
| AMM-4 | `tfSingleAsset \| tfFullyCanonicalSig` | `temBAD_AMM_TOKENS` — flag check passed |
| AMM-5 | `tfSingleAsset \| tfWithdrawAll` | `temINVALID_FLAG` |

Every prediction from rippled's source held. AMM-3 and AMM-4 reach the same
later failure, which is the point: the flag check let them through and the
deposit validation is what stopped them, with no AMM present.

Two more shapes were probed and are **not** asserted, because both are
artefacts of how the transaction was built rather than statements about the
rule:

- `Flags: 0` returned `temBAD_SIGNATURE`. Zero is a valid `Flags` value, so
  this is not the flag rule speaking; it appears to be an interaction with
  client-side autofill. Unresolved and deliberately left out.
- `Flags: 0x00000002` returned `temINVALID_FLAG`. Correct behaviour — `0x2` is
  not a legal AMMDeposit flag — but the story for it is AMM-5, which uses a bit
  that is meaningful elsewhere and therefore tests membership rather than
  nonsense.

---

# Running the suites

```bash
npm run test:integration                          # everything, in order
node integration/tests/12-nft-lifecycle.mjs       # standalone, funds its own wallets
node integration/tests/13-account-admin.mjs       # standalone, funds its own wallets
node integration/tests/14-amm-deposit-flags.mjs   # standalone, funds its own wallet
```

Suites [12] and [13] fund their own extra wallets (buyer, broker, throwaway)
through the faucet, so neither depends on another suite having run first. Suite
[14] is self-contained: it funds one wallet and needs no AMM. All three share
Alice and Bob with the rest of the integration run, so run them **last** —
`AccountDelete` in particular should never be pointed at a shared wallet.
