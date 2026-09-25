import * as secp256k1 from '@noble/secp256k1';
import { encodeCashAddr, hash160 } from './crypto';
import type { BchSigner } from './types';

/** Create a standard compressed-key BCH P2PKH signer from a 32-byte secret. */
export function createSecp256k1BchSigner(privateKey: Uint8Array): BchSigner {
  const publicKey = secp256k1.getPublicKey(privateKey, true);
  return {
    getPublicKey: () => publicKey.slice(),
    signDigest: (digest) => secp256k1.sign(digest, privateKey, { canonical: true, der: true }),
    getAddress: (network) => encodeCashAddr(hash160(publicKey), network),
  };
}
