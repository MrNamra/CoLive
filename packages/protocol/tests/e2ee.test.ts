import { describe, it, expect } from 'vitest';
import {
  deriveSessionKeys,
  generateIv,
  encryptBytes,
  decryptBytes,
  encryptString,
  decryptString,
} from '../src/crypto.js';

describe('Milestone 9: End-to-End Encryption (E2EE) with WebCrypto', () => {
  const secret = 'vO7zR1lK2mN8pQ4sT9uW3xY6zB1cD5eF'; // 32 chars base64url

  it('derives stable authKey and encKey via HKDF-SHA256', async () => {
    const keys1 = await deriveSessionKeys(secret);
    const keys2 = await deriveSessionKeys(secret);

    // Derived auth keys must match deterministically
    expect(keys1.authKeyHex).toBe(keys2.authKeyHex);
    expect(keys1.authKeyHex.length).toBe(64); // 32 bytes hex encoded

    // Different secret produces different key
    const differentKeys = await deriveSessionKeys('another-secret-value-of-length-32-chars');
    expect(differentKeys.authKeyHex).not.toBe(keys1.authKeyHex);
  });

  it('generates distinct IVs from sequential counters', () => {
    const iv0 = generateIv(0);
    const iv1 = generateIv(1);
    const iv2 = generateIv(2);

    expect(iv0.length).toBe(12);
    expect(iv1.length).toBe(12);
    expect(Buffer.from(iv0).equals(Buffer.from(iv1))).toBe(false);
    expect(Buffer.from(iv1).equals(Buffer.from(iv2))).toBe(false);
  });

  it('encrypts and decrypts binary payloads cleanly with AES-256-GCM', async () => {
    const { encKey } = await deriveSessionKeys(secret);
    const plaintext = new Uint8Array([1, 2, 3, 4, 5, 42, 99, 128, 255]);
    const iv = generateIv(1);

    const ciphertext = await encryptBytes(encKey, plaintext, iv);
    expect(ciphertext.length).toBe(plaintext.length + 16); // 16-byte auth tag

    const decrypted = await decryptBytes(encKey, ciphertext, iv);
    expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
  });

  it('detects tampering and throws cryptographic authentication error', async () => {
    const { encKey } = await deriveSessionKeys(secret);
    const plaintext = new TextEncoder().encode('Confidential workspace source code');
    const iv = generateIv(100);

    const ciphertext = await encryptBytes(encKey, plaintext, iv);

    // Tamper with a single bit in the ciphertext
    const tamperedCipher = new Uint8Array(ciphertext);
    tamperedCipher[5] ^= 0x01;

    await expect(decryptBytes(encKey, tamperedCipher, iv)).rejects.toThrow();
  });

  it('encrypts and decrypts UTF-8 JSON strings with base64 encoding', async () => {
    const { encKey } = await deriveSessionKeys(secret);
    const jsonStr = JSON.stringify({ file: 'src/secret.ts', content: 'export const API_KEY = "XYZ";' });
    const iv = generateIv(42);

    const base64Encrypted = await encryptString(encKey, jsonStr, iv);
    expect(typeof base64Encrypted).toBe('string');
    expect(base64Encrypted).not.toContain('API_KEY');

    const decrypted = await decryptString(encKey, base64Encrypted, iv);
    expect(decrypted).toBe(jsonStr);
  });
});
