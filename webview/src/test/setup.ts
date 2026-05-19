import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

type MockVsCodeApi = {
  postMessage: ReturnType<typeof vi.fn>;
  getState: ReturnType<typeof vi.fn>;
  setState: ReturnType<typeof vi.fn>;
};

declare global {
  var acquireVsCodeApi: () => MockVsCodeApi;
}

export const vscodeApiMock: MockVsCodeApi = {
  postMessage: vi.fn(),
  getState: vi.fn(() => undefined),
  setState: vi.fn(),
};

export const acquireVsCodeApiMock = vi.fn(() => vscodeApiMock);

Object.defineProperty(globalThis, 'acquireVsCodeApi', {
  value: acquireVsCodeApiMock,
  configurable: true,
  writable: true,
});

Object.defineProperty(window, 'requestAnimationFrame', {
  value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0),
  configurable: true,
  writable: true,
});

Object.defineProperty(window, 'cancelAnimationFrame', {
  value: (handle: number) => window.clearTimeout(handle),
  configurable: true,
  writable: true,
});

Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
  value: vi.fn(),
  configurable: true,
  writable: true,
});

export function resetVsCodeApiMock(): void {
  acquireVsCodeApiMock.mockClear();
  vscodeApiMock.postMessage.mockClear();
  vscodeApiMock.getState.mockReset();
  vscodeApiMock.getState.mockReturnValue(undefined);
  vscodeApiMock.setState.mockClear();
}

export function dispatchHostMessage(message: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data: message }));
}

afterEach(() => {
  cleanup();
  resetVsCodeApiMock();
});
