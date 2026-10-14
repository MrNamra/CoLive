import { describe, it, expect } from 'vitest';
import { PROTOCOL_VERSION, MAX_FILE_BYTES } from '../src/index.js';

describe('Protocol Smoke Test', () => {
  it('exports PROTOCOL_VERSION 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('exports MAX_FILE_BYTES as 5MB', () => {
    expect(MAX_FILE_BYTES).toBe(5 * 1024 * 1024);
  });
});
