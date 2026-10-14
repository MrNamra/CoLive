/**
 * WebCrypto-based End-to-End Encryption (E2EE) module for CoLive.
 * Uses HKDF-SHA256 for key derivation and AES-256-GCM for authenticated encryption.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface DerivedKeys {
  authKeyHex: string;
  encKey: CryptoKey;
}

/**
 * Derives an authKey (for server verification) and encKey (for AES-256-GCM)
 * from the invite secret using standard WebCrypto HKDF.
 */
export async function deriveSessionKeys(secret: string): Promise<DerivedKeys> {
  const secretBytes = encoder.encode(secret);

  const baseKey = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    'HKDF',
    false,
    ['deriveKey', 'deriveBits'],
  );

  // 1. Derive authKey (32 bytes)
  const authBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('colive-auth-salt'),
      info: encoder.encode('auth'),
    },
    baseKey,
    256,
  );

  const authKeyHex = Array.from(new Uint8Array(authBits))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // 2. Derive encKey for AES-GCM 256
  const encKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('colive-enc-salt'),
      info: encoder.encode('enc'),
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

  return { authKeyHex, encKey };
}

/**
 * Generates a 12-byte IV for AES-GCM from a 64-bit integer counter.
 */
export function generateIv(counter: number): Uint8Array {
  const iv = new Uint8Array(12);
  const view = new DataView(iv.buffer);
  // Fill first 4 bytes with pseudo-random salt or zeros, and last 8 bytes with counter
  view.setBigUint64(4, BigInt(counter), false);
  return iv;
}

/**
 * Encrypts arbitrary bytes using AES-256-GCM.
 * Output contains the ciphertext and 16-byte GCM authentication tag.
 */
export async function encryptBytes(
  key: CryptoKey,
  plaintext: Uint8Array,
  iv: Uint8Array,
): Promise<Uint8Array> {
  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    plaintext as BufferSource,
  );
  return new Uint8Array(encryptedBuffer);
}

/**
 * Decrypts AES-256-GCM ciphertext. Throws an error if ciphertext or tag was tampered with.
 */
export async function decryptBytes(
  key: CryptoKey,
  ciphertextWithTag: Uint8Array,
  iv: Uint8Array,
): Promise<Uint8Array> {
  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    ciphertextWithTag as BufferSource,
  );
  return new Uint8Array(decryptedBuffer);
}

/**
 * Encrypts a UTF-8 string into a base64 encoded ciphertext string.
 */
export async function encryptString(
  key: CryptoKey,
  text: string,
  iv: Uint8Array,
): Promise<string> {
  const bytes = encoder.encode(text);
  const cipher = await encryptBytes(key, bytes, iv);
  return Buffer.from(cipher).toString('base64');
}

/**
 * Decrypts a base64 encoded ciphertext string back into a UTF-8 string.
 */
export async function decryptString(
  key: CryptoKey,
  base64Cipher: string,
  iv: Uint8Array,
): Promise<string> {
  const cipherBytes = Buffer.from(base64Cipher, 'base64');
  const plainBytes = await decryptBytes(key, cipherBytes, iv);
  return decoder.decode(plainBytes);
}
