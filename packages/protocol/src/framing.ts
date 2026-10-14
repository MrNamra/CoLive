import { BINARY_FRAME_KINDS, BinaryFrameKind, MAX_BINARY_FRAME_BYTES } from './constants.js';
import { CoLiveError } from './errors.js';

export interface DecodedBinaryFrame {
  kind: BinaryFrameKind;
  docId: string;
  payload: Uint8Array;
}

/**
 * Encodes a binary message into a frame:
 * [1-byte kind][2-byte docId length (BE)][docId UTF-8 bytes][payload bytes]
 */
export function encodeBinaryFrame(
  kind: BinaryFrameKind,
  docId: string,
  payload: Uint8Array,
): Uint8Array {
  if (kind !== BINARY_FRAME_KINDS.DOC_UPDATE && kind !== BINARY_FRAME_KINDS.AWARENESS) {
    throw new CoLiveError('INTERNAL', `Invalid binary frame kind: ${kind}`);
  }

  const textEncoder = new TextEncoder();
  const docIdBytes = textEncoder.encode(docId);
  if (docIdBytes.length > 65535) {
    throw new CoLiveError('TOO_LARGE', `docId exceeds maximum length of 65535 bytes`);
  }

  const totalLength = 1 + 2 + docIdBytes.length + payload.length;
  if (totalLength > MAX_BINARY_FRAME_BYTES) {
    throw new CoLiveError('TOO_LARGE', `Binary frame exceeds maximum size of ${MAX_BINARY_FRAME_BYTES} bytes`);
  }

  const frame = new Uint8Array(totalLength);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);

  // 1-byte kind
  frame[0] = kind;

  // 2-byte docId length (big endian)
  view.setUint16(1, docIdBytes.length, false);

  // docId bytes
  frame.set(docIdBytes, 3);

  // payload bytes
  frame.set(payload, 3 + docIdBytes.length);

  return frame;
}

/**
 * Decodes a binary frame into its kind, docId, and payload.
 */
export function decodeBinaryFrame(frame: Uint8Array): DecodedBinaryFrame {
  if (frame.length < 3) {
    throw new CoLiveError('INTERNAL', `Binary frame too short: ${frame.length} bytes`);
  }

  if (frame.length > MAX_BINARY_FRAME_BYTES) {
    throw new CoLiveError('TOO_LARGE', `Binary frame exceeds maximum size of ${MAX_BINARY_FRAME_BYTES} bytes`);
  }

  const kind = frame[0];
  if (kind !== BINARY_FRAME_KINDS.DOC_UPDATE && kind !== BINARY_FRAME_KINDS.AWARENESS) {
    throw new CoLiveError('INTERNAL', `Unknown binary frame kind: ${kind}`);
  }

  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const docIdLength = view.getUint16(1, false);

  if (3 + docIdLength > frame.length) {
    throw new CoLiveError('INTERNAL', `Malformed binary frame: docId length ${docIdLength} exceeds frame bounds`);
  }

  const textDecoder = new TextDecoder();
  const docId = textDecoder.decode(frame.subarray(3, 3 + docIdLength));
  const payload = frame.subarray(3 + docIdLength);

  return {
    kind: kind as BinaryFrameKind,
    docId,
    payload,
  };
}
