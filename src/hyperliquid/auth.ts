/**
 * Hyperliquid EIP-712 signing for Cloudflare Workers.
 * Uses @noble/curves (pure JS, no Node.js builtins).
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { encode } from '@msgpack/msgpack';

// EIP-712 domain for L1 actions
const DOMAIN = {
  name: 'Exchange',
  version: '1',
  chainId: 1337,
  verifyingContract: '0x0000000000000000000000000000000000000000',
};

const EIP712_DOMAIN_TYPE_HASH = keccak256Str(
  'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'
);

const AGENT_TYPE_HASH = keccak256Str(
  'Agent(string source,bytes32 connectionId)'
);

function keccak256Str(s: string): Uint8Array {
  return keccak_256(new TextEncoder().encode(s));
}

function keccak256Bytes(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.substr(i * 2, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return '0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function padTo32(data: Uint8Array): Uint8Array {
  const padded = new Uint8Array(32);
  padded.set(data, 32 - data.length);
  return padded;
}

function encodeUint256(n: number | bigint): Uint8Array {
  const hex = BigInt(n).toString(16).padStart(64, '0');
  return hexToBytes(hex);
}

function encodeAddress(addr: string): Uint8Array {
  return padTo32(hexToBytes(addr));
}

function encodeString(s: string): Uint8Array {
  return keccak256Str(s);
}

/**
 * Compute the EIP-712 domain separator
 */
function domainSeparator(): Uint8Array {
  const encoded = concatBytes(
    EIP712_DOMAIN_TYPE_HASH,
    encodeString(DOMAIN.name),
    encodeString(DOMAIN.version),
    encodeUint256(DOMAIN.chainId),
    encodeAddress(DOMAIN.verifyingContract)
  );
  return keccak256Bytes(encoded);
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

/**
 * Build the connection ID from an action.
 * Steps:
 * 1. msgpack encode the action
 * 2. Append nonce as 8 bytes BE
 * 3. Append 0x00 (no vault)
 * 4. keccak256 the result
 */
function buildConnectionId(action: any, nonce: number, vaultAddress?: string): Uint8Array {
  const packed = encode(action);
  const nonceBytes = new Uint8Array(8);
  const view = new DataView(nonceBytes.buffer);
  view.setBigUint64(0, BigInt(nonce));

  let data: Uint8Array;
  if (vaultAddress) {
    const vaultBytes = hexToBytes(vaultAddress);
    data = concatBytes(new Uint8Array(packed), nonceBytes, new Uint8Array([0x01]), vaultBytes);
  } else {
    data = concatBytes(new Uint8Array(packed), nonceBytes, new Uint8Array([0x00]));
  }

  return keccak256Bytes(data);
}

/**
 * Sign an L1 action for Hyperliquid.
 * Returns the signature object {r, s, v} expected by the API.
 */
export async function signL1Action(
  privateKey: string,
  action: any,
  nonce: number,
  isTestnet: boolean,
  vaultAddress?: string
): Promise<{ r: string; s: string; v: number }> {
  const connectionId = buildConnectionId(action, nonce, vaultAddress);

  // Build the Agent struct hash
  const source = isTestnet ? 'b' : 'a';
  const structHash = keccak256Bytes(concatBytes(
    AGENT_TYPE_HASH,
    encodeString(source),
    connectionId // already 32 bytes
  ));

  // Build the full EIP-712 hash: \x19\x01 + domainSeparator + structHash
  const digest = keccak256Bytes(concatBytes(
    new Uint8Array([0x19, 0x01]),
    domainSeparator(),
    structHash
  ));

  // Sign with secp256k1
  const privKeyBytes = hexToBytes(privateKey);
  const sig = secp256k1.sign(digest, privKeyBytes);

  // Extract r, s directly as bigint → hex (avoids version-dependent methods)
  const r = '0x' + sig.r.toString(16).padStart(64, '0');
  const s = '0x' + sig.s.toString(16).padStart(64, '0');
  const v = sig.recovery + 27;

  return { r, s, v };
}

/**
 * Get the Ethereum address from a private key.
 */
export function privateKeyToAddress(privateKey: string): string {
  const privKeyBytes = hexToBytes(privateKey);
  const pubKey = secp256k1.getPublicKey(privKeyBytes, false); // uncompressed
  // Address = last 20 bytes of keccak256(pubkey without 0x04 prefix)
  const hash = keccak256Bytes(pubKey.slice(1));
  return bytesToHex(hash.slice(12));
}

/**
 * Format a number for Hyperliquid wire format.
 * Removes trailing zeros, max 8 decimal places.
 */
export function floatToWire(n: number, decimals?: number): string {
  const d = decimals !== undefined ? decimals : 8;
  const fixed = n.toFixed(d);
  // Remove trailing zeros after decimal point
  if (fixed.includes('.')) {
    return fixed.replace(/\.?0+$/, '') || '0';
  }
  return fixed;
}
