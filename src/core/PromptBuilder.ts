import * as path from 'path';
import type { ContentBlock } from '@agentclientprotocol/sdk';

export interface PromptCapabilityFlags {
  image: boolean;
  embeddedContext: boolean;
  audio: boolean;
}

export interface PromptAttachment {
  id: string;
  kind: 'image' | 'file';
  name: string;
  mimeType: string;
  /** Base64 payload (without data: prefix) for image attachments */
  data?: string;
  /** Workspace/local file URI string */
  uri?: string;
  /** UTF-8 text content when preloaded for embeddedContext */
  text?: string;
}

const IMAGE_MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const TEXT_MIME_MAP: Record<string, string> = {
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.js': 'text/javascript',
  '.jsx': 'text/javascript',
  '.html': 'text/html',
  '.css': 'text/css',
  '.xml': 'application/xml',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.csv': 'text/csv',
};

export function getImageMimeType(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_MIME_MAP[ext] ?? null;
}

export function guessMimeType(filePath: string): string {
  const img = getImageMimeType(filePath);
  if (img) {
    return img;
  }
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_MIME_MAP[ext] ?? 'text/plain';
}

/**
 * Build ACP ContentBlock[] from user text and attachments, respecting agent promptCapabilities.
 */
export function buildPromptContentBlocks(
  text: string,
  attachments: PromptAttachment[],
  caps: PromptCapabilityFlags,
): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  for (const att of attachments) {
    if (att.kind === 'image') {
      if (!caps.image) {
        throw new Error(`The active agent does not support image attachments ("${att.name}").`);
      }
      if (!att.data) {
        throw new Error(`Image attachment "${att.name}" is missing base64 data.`);
      }
      blocks.push({
        type: 'image',
        mimeType: att.mimeType,
        data: att.data,
        ...(att.uri ? { uri: att.uri } : {}),
      });
    } else if (att.kind === 'file') {
      if (caps.embeddedContext && att.uri && att.text !== undefined) {
        blocks.push({
          type: 'resource',
          resource: {
            uri: att.uri,
            mimeType: att.mimeType,
            text: att.text,
          },
        });
      } else if (att.uri) {
        blocks.push({
          type: 'resource_link',
          uri: att.uri,
          name: att.name,
          mimeType: att.mimeType,
        });
      }
    }
  }

  if (text.trim().length > 0 || blocks.length === 0) {
    blocks.push({ type: 'text', text });
  }

  return blocks;
}
