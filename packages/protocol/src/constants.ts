/**
 * Maximum file size accepted in bytes (5 MB).
 */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Maximum JSON message size in bytes (1 MB).
 */
export const MAX_MESSAGE_BYTES = 1 * 1024 * 1024;

/**
 * Maximum binary frame size in bytes (8 MB).
 */
export const MAX_BINARY_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * Default maximum participants per session.
 */
export const MAX_PARTICIPANTS = 10;

/**
 * Default session TTL in hours.
 */
export const SESSION_TTL_HOURS = 12;

/**
 * Accessible 12-color participant palette.
 */
export const PARTICIPANT_PALETTE = [
  '#E6194B', // Red
  '#3CBL54', // Greenish
  '#FFE119', // Yellow
  '#4363D8', // Blue
  '#F58231', // Orange
  '#911EB4', // Purple
  '#42D4F4', // Cyan
  '#F032E6', // Magenta
  '#BFEF45', // Lime
  '#FABED4', // Pink
  '#469990', // Teal
  '#DCBEFF', // Lavender
] as const;
