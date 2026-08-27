export type HistoryControl =
  | { action: 'undo' }
  | { action: 'restore'; revisionId: string };

const UNDO_CONTROL = /^<!--\s*composer:history\s+action="undo"\s*-->$/;
const RESTORE_CONTROL =
  /^<!--\s*composer:history\s+action="restore"\s+revision-id="([^"]+)"\s*-->$/;

// Read-only compatibility for controls persisted by clients before revision
// selection became local. Current application code must never create these.
export function parseHistoryControl(value: string): HistoryControl | null {
  const body = value.trim();
  if (UNDO_CONTROL.test(body)) return { action: 'undo' };

  const restore = body.match(RESTORE_CONTROL);
  if (!restore?.[1]) return null;
  return { action: 'restore', revisionId: restore[1] };
}
