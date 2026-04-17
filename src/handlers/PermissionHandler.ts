import * as vscode from 'vscode';
import { log } from '../utils/Logger';
import { sendEvent } from '../utils/TelemetryManager';

import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';

const CANCELLED: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };

/**
 * Handles ACP permission requests from agents.
 * Uses a serial promise queue to prevent concurrent QuickPick dialogs.
 * Supports granular auto-approve by tool kind.
 */
export class PermissionHandler {
  private queue: Promise<void> = Promise.resolve();

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    let resolve!: (v: RequestPermissionResponse) => void;
    const result = new Promise<RequestPermissionResponse>(r => { resolve = r; });

    this.queue = this.queue.then(async () => {
      try {
        resolve(await this.handlePermission(params));
      } catch (err) {
        log(`Permission error: ${err}`);
        resolve(CANCELLED);
      }
    });

    return result;
  }

  private async handlePermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const title = params.toolCall?.title || 'Permission Request';
    const kind = params.toolCall?.kind;

    // Granular auto-approve by tool kind
    const config = vscode.workspace.getConfiguration('acp');
    let autoApprove: string;
    switch (kind) {
      case 'read':
      case 'search':
      case 'fetch':
        autoApprove = config.get<string>('autoApprove.read', 'ask');
        break;
      case 'edit':
      case 'delete':
      case 'move':
        autoApprove = config.get<string>('autoApprove.edit', 'ask');
        break;
      case 'execute':
        autoApprove = config.get<string>('autoApprove.execute', 'ask');
        break;
      default:
        autoApprove = 'ask';
        break;
    }

    log(`requestPermission: ${title} (kind=${kind}, autoApprove=${autoApprove})`);

    if (autoApprove === 'allow') {
      const allowOption = params.options.find(o =>
        o.kind === 'allow_once' || o.kind === 'allow_always'
      );
      if (allowOption) {
        sendEvent('permission/requested', { permissionType: title, autoApproved: 'true' });
        return {
          outcome: { outcome: 'selected', optionId: allowOption.optionId },
        };
      }
    }

    // QuickPick UI for manual approval
    const items: (vscode.QuickPickItem & { optionId: string })[] = params.options.map(option => {
      const icon = option.kind.startsWith('allow') ? '$(check)' : '$(x)';
      return {
        label: `${icon} ${option.name}`,
        description: option.kind,
        optionId: option.optionId,
      };
    });

    sendEvent('permission/requested', { permissionType: title, autoApproved: 'false' });

    const selection = await vscode.window.showQuickPick(items, {
      placeHolder: title,
      title: 'ACP Agent Permission Request',
      ignoreFocusOut: true,
    });

    if (!selection) {
      log('Permission cancelled by user');
      sendEvent('permission/responded', { permissionType: title, outcome: 'cancelled' });
      return CANCELLED;
    }

    log(`Permission selected: ${selection.optionId}`);
    sendEvent('permission/responded', {
      permissionType: title,
      action: selection.optionId,
      outcome: 'selected',
    });
    return {
      outcome: { outcome: 'selected', optionId: selection.optionId },
    };
  }
}
