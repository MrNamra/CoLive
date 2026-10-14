import { describe, it, expect } from 'vitest';
import { Strings } from '../src/strings.js';

describe('Extension Smoke Test', () => {
  it('has strings defined', () => {
    expect(Strings.extensionName).toBe('CoLive');
    expect(Strings.helloMessage).toContain('CoLive');
  });
});
