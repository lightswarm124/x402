import type { PaymentPayload, PaymentRequirements, SchemeNetworkClient } from '@x402/core/types';
import {
  DEFAULT_BCH_POLICY,
  bytesToBase64,
  decodeCashAddr,
  hash160,
  p2pkhScript,
  pushData,
  serializeTransaction,
  signingHash,
  verifyPayment,
  type BchPolicy,
  type BchTransaction,
  type BchTxInput,
  type BchTxOutput,
} from '../../crypto';
import type { BchProvider, BchSigner, ExactBchRequirements } from '../../types';

export class ExactBchScheme implements SchemeNetworkClient {
  readonly scheme = 'exact';

  constructor(
    private readonly signer: BchSigner,
    private readonly provider: BchProvider,
    private readonly policy: BchPolicy = DEFAULT_BCH_POLICY,
  ) {}

  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
  ): Promise<Pick<PaymentPayload, 'x402Version' | 'payload'>> {
    if (x402Version !== 2) throw new Error('BCH exact supports x402 version 2 only');
    const requirements = validateRequirements(paymentRequirements, this.provider.network);
    const amount = parseAmount(requirements.amount);
    const payToHash = decodeCashAddr(requirements.payTo, requirements.network);
    const merchantScript = p2pkhScript(payToHash);
    const payerAddress = this.signer.getAddress(requirements.network);
    const utxos = (await this.provider.listUtxos(payerAddress)).filter((utxo) =>
      equalBytes(utxo.scriptPubKey, p2pkhScript(hash160(this.signer.getPublicKey()))),
    );
    utxos.sort((left, right) => (left.value < right.value ? 1 : left.value > right.value ? -1 : 0));

    const selected = [];
    let selectedValue = 0n;
    for (const utxo of utxos) {
      selected.push(utxo);
      selectedValue += utxo.value;
      const estimatedSize = 10n + BigInt(selected.length * 180 + 68);
      if (selectedValue >= amount + estimatedSize * this.policy.feeRateSatPerByte) break;
    }
    if (selectedValue < amount) throw new Error('insufficient BCH UTXOs for payment and fee');

    const transaction = await buildAndSignTransaction(
      selected,
      merchantScript,
      amount,
      this.signer,
      this.policy,
    );
    verifyPayment(
      transaction,
      selected.map((utxo) => ({ value: utxo.value, scriptPubKey: utxo.scriptPubKey })),
      requirements.network,
      merchantScript,
      amount,
      this.policy,
    );
    return {
      x402Version,
      payload: { transaction: bytesToBase64(serializeTransaction(transaction)) },
    };
  }
}

export async function buildAndSignTransaction(
  selected: Array<{
    txid: string;
    vout: number;
    value: bigint;
    scriptPubKey: Uint8Array;
  }>,
  merchantScript: Uint8Array,
  merchantAmount: bigint,
  signer: BchSigner,
  policy: BchPolicy = DEFAULT_BCH_POLICY,
): Promise<BchTransaction> {
  if (selected.length === 0 || selected.length > policy.maxInputs) {
    throw new Error('invalid BCH input count');
  }
  if (
    merchantScript.length !== 25 ||
    merchantScript[0] !== 0x76 ||
    merchantScript[1] !== 0xa9 ||
    merchantScript[2] !== 0x14 ||
    merchantScript[23] !== 0x88 ||
    merchantScript[24] !== 0xac
  ) {
    throw new Error('BCH exact requires a P2PKH merchant output');
  }
  if (merchantAmount < policy.dustThreshold) throw new Error('merchant output is dust');
  const inputValue = selected.reduce((total, utxo) => total + utxo.value, 0n);
  if (inputValue < merchantAmount) throw new Error('selected BCH UTXOs do not cover payment');
  const changeScript = p2pkhScript(hash160(signer.getPublicKey()));
  let change = inputValue - merchantAmount;

  for (let attempt = 0; attempt < 32; attempt += 1) {
    const includeChange = change >= policy.dustThreshold;
    const transaction = makeUnsignedTransaction(
      selected,
      merchantScript,
      merchantAmount,
      includeChange ? { value: change, scriptPubKey: changeScript } : undefined,
    );
    await signTransaction(transaction, selected, signer);
    const requiredFee = BigInt(serializeTransaction(transaction).length) * policy.feeRateSatPerByte;
    const available = inputValue - merchantAmount;
    if (!includeChange) {
      if (available < requiredFee) throw new Error('selected BCH UTXOs do not cover fee');
      if (serializeTransaction(transaction).length > policy.maxTransactionSize) {
        throw new Error('transaction exceeds maximum size');
      }
      return transaction;
    }

    const desiredChange = available - requiredFee;
    if (desiredChange < policy.dustThreshold) {
      change = 0n;
      continue;
    }
    if (change > desiredChange) {
      change = desiredChange;
      continue;
    }
    if (serializeTransaction(transaction).length > policy.maxTransactionSize) {
      throw new Error('transaction exceeds maximum size');
    }
    return transaction;
  }
  throw new Error('BCH fee/change calculation did not converge');
}

async function signTransaction(
  transaction: BchTransaction,
  selected: Array<{ txid: string; vout: number; value: bigint; scriptPubKey: Uint8Array }>,
  signer: BchSigner,
): Promise<void> {
  const publicKey = signer.getPublicKey();
  for (let index = 0; index < selected.length; index += 1) {
    const digest = signingHash(transaction, index, {
      value: selected[index].value,
      scriptPubKey: selected[index].scriptPubKey,
    });
    const signature = Uint8Array.from([...(await signer.signDigest(digest)), 0x41]);
    transaction.inputs[index].scriptSig = Uint8Array.from([
      ...pushData(signature),
      ...pushData(publicKey),
    ]);
  }
}

function makeUnsignedTransaction(
  selected: Array<{ txid: string; vout: number; value: bigint }>,
  merchantScript: Uint8Array,
  merchantAmount: bigint,
  change?: BchTxOutput,
): BchTransaction {
  const inputs: BchTxInput[] = selected.map((utxo) => ({
    outpoint: { txid: utxo.txid, vout: utxo.vout },
    scriptSig: new Uint8Array(),
    sequence: 0xffffffff,
  }));
  const outputs: BchTxOutput[] = [{ value: merchantAmount, scriptPubKey: merchantScript }];
  if (change) outputs.push(change);
  return { version: 2, inputs, outputs, lockTime: 0 };
}

function validateRequirements(
  value: PaymentRequirements,
  network: ExactBchRequirements['network'],
): ExactBchRequirements {
  if (value.scheme !== 'exact') throw new Error('unsupported BCH scheme');
  if (value.network !== network) throw new Error('BCH network mismatch');
  if (value.asset !== 'BCH') throw new Error('BCH exact requires native BCH');
  if (value.extra?.assetTransferMethod !== 'native' || value.extra?.paymentFlow !== 'upfront') {
    throw new Error('BCH exact requires native upfront payment flow');
  }
  parseAmount(value.amount);
  return value as ExactBchRequirements;
}

function parseAmount(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('BCH amount must be canonical satoshis');
  const amount = BigInt(value);
  if (amount > 0xffffffffffffffffn) throw new Error('BCH amount exceeds u64');
  return amount;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
