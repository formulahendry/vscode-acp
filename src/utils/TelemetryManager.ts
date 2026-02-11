import * as vscode from 'vscode';
import { TelemetryReporter } from '@vscode/extension-telemetry';

const CONNECTION_STRING = 'InstrumentationKey=c4d676c8-3b21-4047-8f57-804f20ccb62d';

let reporter: TelemetryReporter | undefined;

/** Common properties attached to every telemetry event. */
function getCommonProperties(): Record<string, string> {
  return {
    ideName: vscode.env.appName,
    ideUriScheme: vscode.env.uriScheme,
    ideAppHost: vscode.env.appHost,
  };
}

/**
 * Initialise the telemetry reporter.  Must be called once during
 * `activate()`.  Returns the reporter so it can be pushed into
 * `context.subscriptions` for automatic disposal.
 */
export function initTelemetry(): TelemetryReporter {
  if (reporter) {
    return reporter;
  }
  reporter = new TelemetryReporter(CONNECTION_STRING);
  return reporter;
}

/**
 * Send a named telemetry event with optional string properties and
 * numeric measurements.
 */
export function sendEvent(
  eventName: string,
  properties?: Record<string, string>,
  measurements?: Record<string, number>,
): void {
  reporter?.sendTelemetryEvent(eventName, { ...getCommonProperties(), ...properties }, measurements);
}

/**
 * Send an error event (non-exception).  Properties describe the error
 * context; the data is still sent through the normal event pipeline.
 */
export function sendError(
  eventName: string,
  properties?: Record<string, string>,
  measurements?: Record<string, number>,
): void {
  reporter?.sendTelemetryErrorEvent(eventName, { ...getCommonProperties(), ...properties }, measurements);
}

/**
 * Report an exception / caught error as an error event.
 */
export function sendException(error: Error, properties?: Record<string, string>): void {
  reporter?.sendTelemetryErrorEvent('unhandledException', {
    ...getCommonProperties(),
    ...properties,
    errorName: error.name,
    errorMessage: error.message,
  });
}
