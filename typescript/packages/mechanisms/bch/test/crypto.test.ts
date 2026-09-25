import { describe, expect, it } from 'vitest';
import {
  decodeCashAddr,
  encodeCashAddr,
  hash160,
  parseTransaction,
  p2pkhScript,
  serializeTransaction,
  transactionId,
  verifyPayment,
} from '../src/crypto';
import { buildAndSignTransaction } from '../src/exact/client/scheme';
import { createSecp256k1BchSigner } from '../src/signer';
import type { BchNetwork } from '../src/types';

const NETWORK: BchNetwork = 'bch:bitcoincash';
const SECRET_KEY = new Uint8Array(32).fill(1);

describe('BCH CashAddr and transaction primitives', () => {
  it('round-trips a standard mainnet P2PKH CashAddr', () => {
    const hash = new Uint8Array(20).fill(0x11);
    const address = encodeCashAddr(hash, NETWORK);

    expect(address).toBe('bitcoincash:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zye3kwllue');
    expect(decodeCashAddr(address, NETWORK)).toEqual(hash);
    expect(() => decodeCashAddr(address, 'bch:bchtest')).toThrow(/network mismatch/);
  });

  it('constructs, signs, serializes, parses, and verifies a BCH exact payment', async () => {
    const signer = createSecp256k1BchSigner(SECRET_KEY);
    const payerAddress = signer.getAddress(NETWORK);
    const merchantHash = new Uint8Array(20).fill(0x22);
    const merchantScript = p2pkhScript(merchantHash);
    const selected = [
      {
        txid: '00'.repeat(32),
        vout: 0,
        value: 100_000n,
        scriptPubKey: p2pkhScript(hash160(signer.getPublicKey())),
      },
    ];

    const transaction = await buildAndSignTransaction(selected, merchantScript, 1_000n, signer);
    const raw = serializeTransaction(transaction);
    const parsed = parseTransaction(raw);
    const result = verifyPayment(
      parsed,
      selected.map(({ value, scriptPubKey }) => ({ value, scriptPubKey })),
      NETWORK,
      merchantScript,
      1_000n,
    );

    expect(parsed).toEqual(transaction);
    expect(result.payer).toBe(payerAddress);
    expect(result.fee).toBe(226n);
    expect(result.txid).toBe(transactionId(transaction));
  });
});
