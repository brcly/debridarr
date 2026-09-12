export const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;

// Display labels only: never rewrite torrent filenames used to open actual files.
export function displayName(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ').trim().slice(0, 300);
}
