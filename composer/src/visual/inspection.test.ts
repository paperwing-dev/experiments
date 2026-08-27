import { describe, expect, it, vi } from 'vitest';
import { decodeInspectionVisual } from './inspection-payload';
import {
  captureInspectionScreenshot,
  inspectionRenderUrl,
} from './inspection';

const visual = {
  points: Array.from({ length: 8 }, (_, index) => ({
    x: index,
    y: index / 2,
    z: index === 0 ? 0 : -index,
  })),
  render: { radius: 0.2 },
  parameterSchema: {},
};

describe('inspection screenshot capture', () => {
  it('encodes the exact visual in a fragment that does not reach the server path', () => {
    const url = new URL(inspectionRenderUrl('https://composer.example/', visual));

    expect(`${url.origin}${url.pathname}`).toBe(
      'https://composer.example/render/inspection',
    );
    expect(decodeInspectionVisual(url.hash.slice(1))).toEqual(visual);
  });

  it('uses one deterministic Browser Run quick action', async () => {
    const quickAction = vi.fn(async () =>
      new Response(Uint8Array.from([137, 80, 78, 71]), {
        headers: {
          'Content-Type': 'image/png',
          'X-Browser-Ms-Used': '321',
        },
      }));
    const browser = { quickAction } as unknown as BrowserRun;

    await expect(
      captureInspectionScreenshot(browser, 'https://composer.example', visual),
    ).resolves.toEqual({
      browserMs: 321,
      data: 'iVBORw==',
      mimeType: 'image/png',
    });

    expect(quickAction).toHaveBeenCalledTimes(1);
    expect(quickAction).toHaveBeenCalledWith(
      'screenshot',
      expect.objectContaining({
        cacheTTL: 0,
        selector: '[data-inspection-ready="true"]',
        viewport: {
          deviceScaleFactor: 1,
          height: 960,
          width: 960,
        },
        waitForSelector: expect.objectContaining({
          selector: '[data-inspection-ready="true"]',
        }),
      }),
    );
  });

  it('surfaces Browser Run errors without changing the visual', async () => {
    const browser = {
      quickAction: vi.fn(async () =>
        new Response('browser unavailable', { status: 503 })),
    } as unknown as BrowserRun;

    await expect(
      captureInspectionScreenshot(browser, 'https://composer.example', visual),
    ).rejects.toThrow('Browser Run screenshot failed (503)');
  });
});
