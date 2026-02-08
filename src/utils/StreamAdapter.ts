import { Readable, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

/**
 * ACP Stream interface — a bidirectional message stream.
 * We re-export the type from the SDK for convenience.
 */
export interface AcpStream {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

/**
 * Adapts a Node.js child process's stdin/stdout to the Web Streams API
 * required by the ACP SDK's `ndJsonStream()`.
 */
export function childProcessToWebStreams(process: ChildProcess): AcpStream {
  if (!process.stdin || !process.stdout) {
    throw new Error('Child process must have stdin and stdout piped');
  }

  const writable = Writable.toWeb(process.stdin) as WritableStream<Uint8Array>;
  const readable = Readable.toWeb(process.stdout) as ReadableStream<Uint8Array>;

  return { readable, writable };
}
