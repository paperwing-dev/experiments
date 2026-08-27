import { encodeInspectionVisual } from './inspection-payload';
import type { VisualResult } from './types';

const INSPECTION_VIEWPORT = 960;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

export interface InspectionScreenshot {
  browserMs?: number;
  data: string;
  mimeType: 'image/png';
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

export function inspectionRenderUrl(
  origin: string,
  visual: VisualResult,
): string {
  const url = new URL('/render/inspection', origin);
  url.hash = encodeInspectionVisual(visual);
  return url.toString();
}

export async function captureInspectionScreenshot(
  browser: BrowserRun,
  origin: string,
  visual: VisualResult,
): Promise<InspectionScreenshot> {
  const response = await browser.quickAction('screenshot', {
    url: inspectionRenderUrl(origin, visual),
    actionTimeout: 20_000,
    cacheTTL: 0,
    gotoOptions: {
      timeout: 15_000,
      waitUntil: 'domcontentloaded',
    },
    screenshotOptions: {
      encoding: 'binary',
      fullPage: false,
      type: 'png',
    },
    selector: '[data-inspection-ready="true"]',
    viewport: {
      deviceScaleFactor: 1,
      height: INSPECTION_VIEWPORT,
      width: INSPECTION_VIEWPORT,
    },
    waitForSelector: {
      selector: '[data-inspection-ready="true"]',
      timeout: 15_000,
      visible: true,
    },
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(
      `Browser Run screenshot failed (${response.status})${
        detail ? `: ${detail}` : ''
      }`,
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_SCREENSHOT_BYTES) {
    throw new Error('Browser Run returned an invalid screenshot size.');
  }

  const browserMsHeader = response.headers.get('X-Browser-Ms-Used');
  const browserMs = browserMsHeader === null
    ? undefined
    : Number(browserMsHeader);

  return {
    browserMs: Number.isFinite(browserMs) ? browserMs : undefined,
    data: bytesToBase64(bytes),
    mimeType: 'image/png',
  };
}
