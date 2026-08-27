import type { VisualResult } from './types';
import { validateVisualResult } from './validation';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

export function encodeInspectionVisual(visual: VisualResult): string {
  const bytes = new TextEncoder().encode(JSON.stringify(visual));
  return bytesToBase64(bytes)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

export function decodeInspectionVisual(payload: string): VisualResult {
  const normalized = payload.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return validateVisualResult(
    JSON.parse(new TextDecoder().decode(bytes)) as unknown,
  );
}
