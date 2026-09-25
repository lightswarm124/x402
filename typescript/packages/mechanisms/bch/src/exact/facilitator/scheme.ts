import type {
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from '@x402/core/types';
import {
  DEFAULT_BCH_POLICY,
  base64ToBytes,
  decodeCashAddr,
  parseTransaction,
  p2pkhScript,
  verifyPayment,
  type BchPolicy,
} from '../../crypto';
import type {
  BchConfirmationStrategy,
  BchFacilitatorConfig,
  BchProvider,
  ExactBchPayload,
  ExactBchRequirements,
} from '../../types';

export class ExactBchFacilitatorScheme implements SchemeNetworkFacilitator {
  readonly scheme = 'exact';
  readonly caipFamily = 'bch:*';
  private readonly policy: BchPolicy;
  private readonly strategy: BchConfirmationStrategy;

  constructor(
    private readonly provider: BchProvider,
    config: BchFacilitatorConfig = {},
  ) {
    this.policy = {
      ...DEFAULT_BCH_POLICY,
      ...(config.feeRateSatPerByte === undefined
        ? {}
        : { feeRateSatPerByte: config.feeRateSatPerByte }),
      ...(config.dustThreshold === undefined ? {} : { dustThreshold: config.dustThreshold }),
      ...(config.maxTransactionSize === undefined
        ? {}
        : { maxTransactionSize: config.maxTransactionSize }),
      ...(config.maxInputs === undefined ? {} : { maxInputs: config.maxInputs }),
    };
    this.strategy = config.settlementStrategy ?? { kind: 'confirmations', count: 1 };
  }

  getExtra(_network: string): undefined {
    return undefined;
  }

  getSigners(_network: string): string[] {
    return [];
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    try {
      const verified = await this.verifyPayment(payload, requirements);
      return { isValid: true, payer: verified.payer };
    } catch (error) {
      return {
        isValid: false,
        invalidReason: `invalid_exact_bch_payment:${error instanceof Error ? error.message : String(error)}`,
        payer: '',
      };
    }
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    let verified: VerifiedBchPayment;
    try {
      verified = await this.verifyPayment(payload, requirements);
    } catch (error) {
      return {
        success: false,
        errorReason: `invalid_exact_bch_payment:${error instanceof Error ? error.message : String(error)}`,
        transaction: '',
        network: this.provider.network,
      };
    }

    const rawTransaction = base64ToBytes((payload.payload as ExactBchPayload).transaction);
    let txid: string;
    try {
      txid = await this.provider.broadcast(rawTransaction);
    } catch (error) {
      const status = await this.provider.getTransactionStatus(verified.txid);
      if (status.kind !== 'mempool' && status.kind !== 'confirmed') {
        return {
          success: false,
          errorReason: `broadcast_failed:${error instanceof Error ? error.message : String(error)}`,
          transaction: verified.txid,
          network: this.provider.network,
          payer: verified.payer,
        };
      }
      txid = verified.txid;
    }
    if (txid.toLowerCase() !== verified.txid.toLowerCase()) {
      return {
        success: false,
        errorReason: 'broadcast_returned_mismatched_txid',
        transaction: txid,
        network: this.provider.network,
        payer: verified.payer,
      };
    }

    const status = await this.provider.getTransactionStatus(txid);
    const accepted = await this.acceptSettlement(txid, status);
    if (!accepted) {
      return {
        success: false,
        errorReason: `settlement_pending:${txid}`,
        transaction: txid,
        network: this.provider.network,
        payer: verified.payer,
      };
    }
    return {
      success: true,
      transaction: txid,
      network: this.provider.network,
      payer: verified.payer,
    };
  }

  private async verifyPayment(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifiedBchPayment> {
    if (payload.x402Version !== 2) throw new Error('unsupported x402 version');
    if (!deepEqual(payload.accepted, requirements))
      throw new Error('accepted requirements mismatch');
    const typed = validateRequirements(requirements, this.provider.network);
    const body = payload.payload as Partial<ExactBchPayload>;
    if (typeof body.transaction !== 'string') throw new Error('missing signed BCH transaction');
    const raw = base64ToBytes(body.transaction);
    const transaction = parseTransaction(raw);
    const payToHash = decodeCashAddr(typed.payTo, typed.network);
    const merchantScript = p2pkhScript(payToHash);
    const sources = [];
    for (const input of transaction.inputs) {
      sources.push(await this.provider.getSourceOutput(input.outpoint));
    }
    const result = verifyPayment(
      transaction,
      sources,
      typed.network,
      merchantScript,
      BigInt(typed.amount),
      this.policy,
    );
    return { ...result, transaction };
  }

  private async acceptSettlement(
    txid: string,
    status: Awaited<ReturnType<BchProvider['getTransactionStatus']>>,
  ): Promise<boolean> {
    if (this.strategy.kind === 'mempool')
      return status.kind === 'mempool' || status.kind === 'confirmed';
    if (this.strategy.kind === 'noDoubleSpendProof') {
      if (status.kind === 'confirmed') return true;
      return status.kind === 'mempool' && !(await this.provider.hasDoubleSpendProof(txid));
    }
    if (status.kind !== 'confirmed') return false;
    const tip = await this.provider.getTipHeight();
    return tip - status.height + 1 >= this.strategy.count;
  }
}

type VerifiedBchPayment = {
  txid: string;
  payer: string;
  fee: bigint;
  transaction: ReturnType<typeof parseTransaction>;
};

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
  if (!/^(0|[1-9][0-9]*)$/.test(value.amount))
    throw new Error('BCH amount must be canonical satoshis');
  return value as ExactBchRequirements;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((value, index) => deepEqual(value, right[index]))
    );
  }
  if (typeof left === 'object' && typeof right === 'object') {
    const leftObject = left as Record<string, unknown>;
    const rightObject = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftObject).sort();
    const rightKeys = Object.keys(rightObject).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) => key === rightKeys[index] && deepEqual(leftObject[key], rightObject[key]),
      )
    );
  }
  return false;
}
