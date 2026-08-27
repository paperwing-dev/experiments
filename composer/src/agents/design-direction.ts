export interface DesignDirection {
  baseRevisionId: string | null;
  instruction: string;
  requestId: string | null;
}

export const MAX_DIRECTION_LENGTH = 4_000;

const BASE_REVISION_MARKER =
  /\s*<!--\s*composer:base-revision\s+revision-id="([^"]+)"\s*-->\s*$/;
const DESIGN_DIRECTION_MARKER =
  /\s*<!--\s*composer:design-direction\s+request-id="([^"]+)"(?:\s+base-revision-id="([^"]+)")?\s*-->\s*$/;
const REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseDesignDirection(value: string): DesignDirection {
  const directionMarker = value.match(DESIGN_DIRECTION_MARKER);
  if (directionMarker?.[1] && directionMarker.index !== undefined) {
    return {
      baseRevisionId: directionMarker[2] ?? null,
      instruction: value.slice(0, directionMarker.index).trim(),
      requestId: directionMarker[1],
    };
  }

  const marker = value.match(BASE_REVISION_MARKER);
  if (!marker?.[1] || marker.index === undefined) {
    return { baseRevisionId: null, instruction: value.trim(), requestId: null };
  }
  return {
    baseRevisionId: marker[1],
    instruction: value.slice(0, marker.index).trim(),
    requestId: null,
  };
}

export function designDirectionMessage(
  instruction: string,
  baseRevisionId: string | null,
  requestId: string | null = null,
): string {
  const body = instruction.trim();
  if (!body) throw new Error('A design direction cannot be empty.');
  if (body.length > MAX_DIRECTION_LENGTH) {
    throw new Error(
      `A design direction cannot exceed ${MAX_DIRECTION_LENGTH} characters.`,
    );
  }
  if (baseRevisionId !== null && (!baseRevisionId || baseRevisionId.includes('"'))) {
    throw new Error('Revision id cannot be encoded as a design direction.');
  }
  if (requestId !== null) {
    if (!REQUEST_ID.test(requestId)) {
      throw new Error('Request id cannot be encoded as a design direction.');
    }
    const base = baseRevisionId
      ? ` base-revision-id="${baseRevisionId}"`
      : '';
    return `${body}\n\n<!-- composer:design-direction request-id="${requestId}"${base} -->`;
  }
  if (baseRevisionId === null) return body;
  return `${body}\n\n<!-- composer:base-revision revision-id="${baseRevisionId}" -->`;
}
