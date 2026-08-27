import { describe, expect, it } from 'vitest';
import { parseHistoryControl } from './history-control';

describe('legacy revision history controls', () => {
  it('recognizes persisted undo and restore controls', () => {
    expect(
      parseHistoryControl('<!-- composer:history action="undo" -->'),
    ).toEqual({ action: 'undo' });
    expect(parseHistoryControl(
      '<!-- composer:history action="restore" revision-id="revision-12" -->',
    )).toEqual({
      action: 'restore',
      revisionId: 'revision-12',
    });
  });

  it('does not treat visible user directions as controls', () => {
    expect(parseHistoryControl('Undo the last color change.')).toBeNull();
    expect(
      parseHistoryControl(
        'Please restore this.\n<!-- composer:history action="undo" -->',
      ),
    ).toBeNull();
  });
});
