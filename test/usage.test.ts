import { describe, it } from 'mocha';
import { strictEqual } from 'assert';
import { formatTokens, computeUsageSuffix } from '../src/util/usage';

/** Replicate the webview JS formatTokens variant (uses Math.round).
 * Lives in inline webview HTML — can't import directly. */
function formatTokensWebview(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'K';
  return String(n);
}

describe('Usage display', () => {

  describe('formatTokens (status bar)', () => {
    const cases: [number, string][] = [
      [0, '0'],
      [42, '42'],
      [999, '999'],
      [1_000, '1K'],
      [1_500, '2K'],
      [45_000, '45K'],
      [199_999, '200K'],
      [999_999, '1000K'],
      [1_000_000, '1.0M'],
      [1_500_000, '1.5M'],
      [200_000, '200K'],
      [999_000, '999K'],
    ];

    for (const [input, expected] of cases) {
      it(`formats ${input} as "${expected}"`, () => {
        strictEqual(formatTokens(input), expected);
      });
    }
  });

  describe('formatTokens (webview)', () => {
    it('rounds 1500 to "2K"', () => {
      strictEqual(formatTokensWebview(1_500), '2K');
    });
    it('rounds 1499 to "1K" (Math.round === toFixed for integers)', () => {
      strictEqual(formatTokensWebview(1_499), '1K');
    });
    it('handles millions', () => {
      strictEqual(formatTokensWebview(1_500_000), '1.5M');
    });
    it('handles small numbers', () => {
      strictEqual(formatTokensWebview(42), '42');
    });
  });

  describe('usage guard (status bar suffix)', () => {
    it('shows suffix for valid usage', () => {
      strictEqual(computeUsageSuffix({ used: 45_000, size: 200_000 }), '  45K/200K');
    });

    it('returns empty string when size is 0', () => {
      strictEqual(computeUsageSuffix({ used: 45_000, size: 0 }), '');
    });

    it('returns correct suffix when used is 0 but size is valid', () => {
      strictEqual(computeUsageSuffix({ used: 0, size: 200_000 }), '  0/200K');
    });

    it('returns empty string when usage is null', () => {
      strictEqual(computeUsageSuffix(null), '');
    });

    it('returns empty string when usage is undefined', () => {
      strictEqual(computeUsageSuffix(undefined), '');
    });

    it('returns empty string when size is missing', () => {
      // Runtime guard: usage?.size is undefined → falsy → empty string
      strictEqual(computeUsageSuffix({ used: 45_000 } as any), '');
    });
  });

});
