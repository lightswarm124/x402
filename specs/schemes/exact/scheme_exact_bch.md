# Scheme: `exact` on Bitcoin Cash

## Summary

This scheme transfers an exact amount of native Bitcoin Cash (BCH), or an
exact CashToken state, from a client-controlled UTXO set to the `payTo`
output. CashToken payments cover fungible tokens and NFTs. `payTo` may be a
P2PKH, P2SH20, or P2SH32 locking script. The client constructs and signs the
complete transaction; the facilitator only verifies and relays that
transaction. The initial version supports x402 v2 and the `upfront` payment
flow only.

This document defines the wire and validation contract shared by the
TypeScript and Rust BCH mechanisms. Executing CashScript covenants, PSBT,
sponsorship, batch settlement, and debit/streaming settlement are outside this
scheme.

## Networks and requirements

The supported network identifiers are:

- `bch:bitcoincash` for BCH mainnet
- `bch:bchtest` for BCH Chipnet

`payTo` MUST be a fully prefixed, lowercase CashAddr whose prefix matches
`network` and whose type is P2PKH, P2SH20, or P2SH32. A CashToken payment MUST
use a token-aware CashAddr. An implementation MAY also accept a legacy
Base58Check P2PKH or P2SH20 address for a native BCH payment. The TypeScript
and Rust mechanisms both do.

`asset` MUST be `BCH` for a native payment, or the 32-byte CashToken category
as 64 lowercase hexadecimal characters for a CashToken payment. `amount` MUST
be a canonical unsigned decimal string: `0` or a non-zero digit followed by
digits, with no sign, decimal point, exponent, or leading zeroes.

- For a native payment, `amount` is satoshis. It MUST fit an unsigned 64-bit
  integer and MUST satisfy the dust rule below.
- For a CashToken payment, `amount` is the fungible token amount, at most
  `2^63 - 1`. It MAY be `0` only when `extra.token.nft` is present.

A native BCH requirement MUST include:

```json
{
  "scheme": "exact",
  "network": "bch:bitcoincash",
  "amount": "1000",
  "asset": "BCH",
  "payTo": "bitcoincash:...",
  "maxTimeoutSeconds": 300,
  "extra": {
    "assetTransferMethod": "native",
    "paymentFlow": "upfront"
  }
}
```

A CashToken requirement MUST include `assetTransferMethod: "cashtoken"` and
the satoshis carried by the merchant token output in `extra.value`:

```json
{
  "scheme": "exact",
  "network": "bch:bitcoincash",
  "amount": "0",
  "asset": "<64-hex category>",
  "payTo": "bitcoincash:r...",
  "maxTimeoutSeconds": 300,
  "extra": {
    "assetTransferMethod": "cashtoken",
    "paymentFlow": "upfront",
    "value": "1035",
    "token": {
      "category": "<64-hex category>",
      "amount": "0",
      "nft": { "capability": "none", "commitment": "<0 to 128 bytes as hex>" }
    }
  }
}
```

- `extra.value` is canonical decimal satoshis. When a price omits it, the
  resource server fills it before advertising the requirement. The filled value
  is the greatest of 1,000 satoshis, the policy dust threshold, and the
  standard relay dust of the merchant output, including its token prefix. A
  128-byte commitment can raise that above 1,000 satoshis. An explicit
  `extra.value` is preserved and MUST be rejected when it is below the output's
  dust threshold. Earlier drafts named this field `tokenOutputValue`; an
  implementation MAY accept that name when reading.
- `extra.token.category` and `extra.token.amount` are optional. When present
  they MUST equal `asset` and `amount`.
- `extra.token.nft.capability` MUST be `none`, `mutable`, or `minting`.
  `extra.token.nft.commitment` MUST be even-length hexadecimal of 0 to 128
  bytes, the current BCH consensus limit. A 129-byte commitment MUST be
  rejected.

`maxTimeoutSeconds` is an off-chain request acceptance window. It is not a
BCH transaction expiry and MUST NOT be interpreted as one.

## Payment payload

`payload.transaction` MUST be standard padded RFC 4648 Base64 containing the
complete legacy BCH transaction serialization. The transaction MUST use:

- version 1 or 2;
- at least one and at most the configured number of inputs;
- locktime `0`;
- BCH sighash type `0x41` (`SIGHASH_ALL | SIGHASH_FORKID`) for P2PKH inputs;
- exactly one output that matches `payTo`, the merchant value, and the
  requested token state; and
- no other output paying the `payTo` locking script.

The merchant value is `amount` for a native payment and `extra.value` for a
CashToken payment. The merchant output of a CashToken payment MUST carry the
requested category and fungible amount, and, when requested, an NFT with the
requested capability and commitment.

Every output other than OP_RETURN MUST meet the standard relay dust for its
locking script and token prefix, and at least the 546-satoshi policy floor.

Every input's authoritative source output MUST be resolved by the facilitator.
Client-provided source values and scripts MUST NOT be trusted. The transaction
MUST conserve BCH value, and its fee MUST meet the configured minimum fee rate
based on the complete serialized transaction size. CashToken state MUST be
conserved across all inputs and outputs. An exact payment does not authorize
token genesis, minting, burning, or a change of NFT capability.

### Inputs and additional outputs

A wallet MAY add outputs beyond the merchant output, up to the facilitator's
output limit, which defaults to 16 outputs in total. They may carry OP_RETURN
data, BCH change to any locking script, and unrelated CashTokens, as long as
every CashToken is conserved. The payer signs every output with
`SIGHASH_ALL | SIGHASH_FORKID`, so where the remainder goes is the payer's
choice. Inputs MAY come from more than one key; the reported payer is the key
of the first P2PKH input.

Inputs MAY use any locking script, including P2SH20 and P2SH32 contracts. A
facilitator MUST verify P2PKH inputs, signature included, whether it is ECDSA or
BCH Schnorr. For other inputs it
MUST at least require push-only unlocking bytecode and, for P2SH20 and P2SH32,
the redeem script the source output commits to. The TypeScript mechanism runs
every input script in the Libauth 2026 VM before broadcast. The Rust mechanism
has no script VM. With a configured BCH node it runs those scripts through the
node's `testmempoolaccept` before verification succeeds. Without one it leaves
them to the network: an invalid script makes the broadcast, and therefore
settlement, fail, so the protected resource never runs.

## Verification and settlement

For `upfront`, the resource server MUST establish settlement before invoking
the protected resource handler. The facilitator MUST verify the requirements,
decode and validate the transaction, resolve authoritative source outputs,
verify every input, and verify the exact merchant output before broadcast.

The facilitator MUST claim the transaction ID atomically against a stable
request binding formed from the accepted requirements and payment resource.
A transaction already claimed for a different binding MUST be rejected. A
retry for the same binding MUST reconcile the existing transaction by TXID and
MUST NOT broadcast it again. The claim MUST remain until settlement is
accepted or the transaction is known to be terminally rejected.

When broadcast fails, the facilitator MUST look up the transaction by TXID. A
transaction in the mempool or confirmed keeps its TXID and continues to
settlement. Only a transaction that the provider reports as not found MAY
release the claim and fail as a broadcast failure. An unknown or conflicted
status, or a failed lookup, MUST keep the claim and report that the broadcast
outcome is unknown.

Settlement acceptance is policy-driven:

- `confirmations(n)` requires at least `n` confirmations;
- `mempool` accepts mempool or confirmed status; or
- `noDoubleSpendProof` accepts mempool status only while no verified BCH
  double-spend proof exists.

The default MUST be `confirmations(1)`. A reachable but not-yet-accepted
transaction MUST return `settlement_pending:<txid>` and MUST not be treated as
successful payment. Provider transport errors MUST remain indeterminate and
MUST NOT be interpreted as either spendability or successful settlement.

## Provider boundary

Client providers supply UTXO discovery and signer-side source data. Facilitator
providers supply authoritative source outputs, spend/conflict status, raw
broadcast, transaction status, tip height, and double-spend-proof evidence.
Availability failover does not prove chain consistency; deployments SHOULD
compare independent chain-tip/header observations and use authenticated or
otherwise reviewed transports.

## Compatibility boundary and known functional gaps

This mechanism is intentionally not an account-model translation. The x402
core contract describes a payment requirement and a settlement result, while
BCH settlement is a UTXO state transition with different operational
invariants:

- A payer does not have a balance to debit. The client selects specific UTXOs,
  and the facilitator must resolve each outpoint's authoritative value and
  locking script before accepting the payment.
- A valid signed transaction is not proof that it was accepted by the network.
  The facilitator must distinguish build, signature verification, broadcast,
  mempool observation, confirmation, and finality. A lost broadcast response
  is indeterminate and requires TXID reconciliation.
- Idempotency is transaction-based. The TXID claim and request binding prevent
  duplicate broadcast and prevent the same transaction from being reused for a
  different resource or price requirement. A process-local settlement store is
  suitable only for a single process; multi-process deployments need a shared
  atomic store.
- BCH fee and change selection are client responsibilities. A facilitator
  cannot infer a missing fee from an account balance, and a change output is a
  separate UTXO subject to dust rules.
- Confirmation depth, mempool policy, double-spend-proof availability, chain
  reorganizations, and provider tip consistency have no direct equivalent in
  the usual account-model adapter. They remain provider and deployment policy,
  not x402 core semantics.
- CashScript contracts are paid by their compiled P2SH20 or P2SH32 locking
  script. This scheme does not execute or check a contract's later spending
  conditions. Covenant successor rules, multisig signer sets, PSBT transport,
  sponsored transactions, batch payments, and debit/streaming settlement need
  a separate wire contract and validation model.

The mechanisms use `@bitauth/libauth` (TypeScript) and Rust BCH primitives for
transaction encoding/decoding, CashAddr validation, hashing, BCH signing
serialization, CashToken encoding, and secp256k1 operations. The TypeScript
mechanism also validates input scripts with the Libauth 2026 VM. The
x402-specific layer remains responsible for requirements, source-output
policy, fee/change policy, provider evidence, and settlement idempotency.

### x402 field and flow mapping

| x402 concept | BCH binding | Compatibility consequence |
| --- | --- | --- |
| `network` | `bch:bitcoincash` or `bch:bchtest` | These are the only supported networks; address prefixes and provider endpoints must agree with the selected value. |
| `asset` | `BCH` or a 64-hex CashToken category | A category is not a contract address or token account; the token travels in the output's token prefix. |
| `amount` | Canonical decimal satoshis, or the fungible token amount | The amount is exact and integer-valued. Human BCH decimals require conversion before producing x402 requirements. |
| `payTo` | Fully prefixed CashAddr P2PKH, P2SH20, or P2SH32 | The address becomes a locking script. The facilitator must compare the script, not a display-form address. CashToken payments require a token-aware CashAddr. |
| `payload` | Complete signed raw transaction in Base64 | The client authorizes a transaction state transition, not a reusable allowance or signature over an abstract transfer. |
| `extra.paymentFlow` | `upfront` only | Settlement must be established before the protected resource executes. The default x402 `authorization` flow is not supported by this mechanism. |
| `extra.assetTransferMethod` | `native` or `cashtoken` | No ERC-20-style transfer method, token account, or facilitator signer is involved. |
| `extra.value` | Satoshis on the CashToken merchant output | Filled by the resource server when the price omits it; preserved when quoted. |
| `extra.token` | Category, fungible amount, and optional NFT capability and commitment | The merchant output must carry exactly this token state. |
| `verify` | Read-only transaction/source validation | Verification checks current outpoint state and may become stale before broadcast. It is not a reservation. |
| `settle` | Claim TXID, broadcast, observe evidence | The facilitator may submit a client-signed transaction but cannot repair, top up, or replace it without a new client authorization. |
| `transaction` in `SettleResponse` | BCH TXID | A successful response identifies the transaction; a pending response must be reconciled rather than blindly retried. |
| `payer` | CashAddr of the first P2PKH input, or of the first input's script | Inputs may come from more than one key or contract; the first P2PKH input identifies the payer when there is one. |

### Functional support matrix

| Capability | Status | Current behavior / gap |
| --- | --- | --- |
| x402 v2 HTTP/core payloads | Supported | Uses `PaymentPayload`, `PaymentRequirements`, `VerifyResponse`, and `SettleResponse`. |
| x402 v1 | Unsupported | No v1 `X-PAYMENT`/`maxAmount` compatibility layer is implemented. |
| `exact` scheme | Supported, BCH-specific | An exact native BCH amount or CashToken state is paid in one transaction. |
| `upto` | Unsupported | There is no BCH allowance, ceiling authorization, or later amount selection. |
| `batch-settlement` | Unsupported | Each payment is a separate transaction; there is no batch proof or batch facilitator state. |
| `authorization` flow | Unsupported | BCH exact is `upfront`; the resource must not run merely because a transaction signature verifies. |
| `upfront` flow | Supported | Facilitator settlement runs before resource execution. Confirmation policy determines when it returns success. |
| `escrow` flow | Unsupported | No deposit, post-resource final charge, refund, or escrow successor state exists. |
| Native BCH | Supported | `asset: BCH`, satoshi amounts. |
| Fungible CashTokens | Supported | The merchant output carries the requested category and amount; any remainder returns as token change. |
| CashToken NFTs | Supported | `none`, `mutable`, and `minting` capabilities; commitments of 0 to 128 bytes; NFT-only payments use amount `0`. |
| P2PKH, P2SH20, P2SH32 destinations | Supported | `payTo` may be any of these. CashScript contracts are paid by their compiled locking script. |
| P2PKH inputs | Supported | BCH `SIGHASH_ALL | SIGHASH_FORKID` spends signed with ECDSA or BCH Schnorr. |
| P2SH20/P2SH32 and other script inputs | Supported | The TypeScript facilitator runs them in the Libauth 2026 VM before broadcast. The Rust facilitator checks the unlocking bytecode and redeem-script hash, then runs the script through a configured node's `testmempoolaccept`, or leaves it to the network at broadcast. |
| Covenant successor rules, multisig signer-set policy | Unsupported | Contract inputs are spent under their own scripts; x402 adds no successor or signer-set policy. |
| PSBT or partially signed transport | Unsupported | The payload must contain a complete legacy raw transaction. |
| Fee sponsorship | Unsupported | The payer supplies all inputs and pays the fee; there is no facilitator fee input or sponsor authorization. |
| Multiple inputs | Supported with restrictions | Inputs are allowed up to policy limits and may come from more than one key. Every source must be unspent at verification. |
| Change and other outputs | Supported with restrictions | Wallets may add change, OP_RETURN, and other outputs up to the output limit (16 by default). No output may be dust, and only the merchant output may pay the merchant script. |
| Confirmation settlement | Supported | Configurable confirmation count; default is one confirmation. |
| Mempool settlement | Supported as opt-in | Accepts mempool/confirmed observation without waiting for a confirmation. This is weaker finality. |
| Double-spend-proof settlement | Supported as opt-in | Requires provider support for proof observation; absence of a proof is not confirmation. |
| Reorg/finality guarantees | Deployment-dependent | The provider strategy and confirmation depth define the acceptance threshold; x402 does not provide a universal finality guarantee. |

### UTXO-specific safety obligations

The account-model schemes can often verify an authorization and then have a
contract enforce nonce, balance, recipient, and amount atomically. BCH exact
does not have that shared account state. The following are therefore separate
obligations:

1. Resolve every input outpoint's value and locking script from an authoritative
   provider. A client-supplied source value is only a hint and MUST NOT be used
   for settlement verification.
2. Check that each source outpoint is currently unspent, while treating that
   observation as a race-prone preflight rather than a reservation.
3. Verify each input's script, public-key ownership, BCH signing serialization,
   and source value independently. A valid signature on one input does not
   authorize another input.
4. Enforce conservation: source value equals the sum of outputs plus fee, and
   CashToken state is unchanged. Fee policy is part of validation because BCH
   has no contract call that separately records the intended fee.
5. Enforce the output policy: exactly one merchant output, no second output to
   the merchant script, no dust, and the output limit.
6. Claim the TXID against the x402 resource and requirements before broadcast.
   This is an application-level idempotency guard; it does not reserve the
   inputs on the BCH network.
7. Reconcile uncertain broadcast outcomes by TXID. A transport timeout or a
   lost response is not evidence that the transaction was not accepted.

### Remaining implementation gaps

The current implementation deliberately leaves these gaps for follow-up work:

- `maxTimeoutSeconds` is carried as an x402 requirement but is not currently
  enforced against a client timestamp, because the BCH payload has no signed
  creation/expiry field. It is therefore an application acceptance window,
  not a transaction validity rule.
- A process-local `BchSettlementStore` prevents duplicate work only within one
  process. Production multi-instance facilitators need a durable shared claim
  store with atomic compare-and-set and recovery of claims left pending by a
  crash.
- Provider responses are transport trust boundaries. Failover improves
  availability but does not prove that endpoints agree on chain tip, source
  output, mempool state, or double-spend evidence.
- There is no proof-carrying settlement receipt, merkle inclusion proof, or
  reorg monitor in the scheme. Consumers needing stronger finality must add
  provider-specific monitoring and choose confirmation policy accordingly.
- The client UTXO selector is intentionally simple and does not provide coin
  selection privacy, fee bumping, replace-by-fee policy, consolidation policy,
  or robust concurrent-wallet reservation. Applications must prevent two
  concurrent clients from selecting the same UTXO set.
- The shared offline vectors cover NFT commitments of 0, 40, 41, 128, and 129
  bytes, fungible plus NFT payments, all three destination types, and the
  wallet-backed path. The TypeScript and Rust mechanisms advertise the same
  `extra.value`, accept each other's transactions, and build identical bytes
  for them. Separate wallet-shape vectors cover OP_RETURN data, extra outputs,
  a second payer, unrelated CashTokens, P2SH inputs, and the rejected cases:
  token burn and mint, an NFT capability change, a second merchant output,
  dust, 17 outputs, and malformed P2SH unlocking bytecode. Both facilitators
  reach the same verdict on each. Malformed-source, mempool-race, reorg, and provider disagreement
  scenarios still need cross-language vectors before claiming production
  maturity.
