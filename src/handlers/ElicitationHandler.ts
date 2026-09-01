import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
} from '@agentclientprotocol/sdk';

import { log } from '../utils/Logger';

/** Presents an elicitation to the user and resolves with their answer. */
export type ElicitationPresenter = (
  params: CreateElicitationRequest,
) => Promise<CreateElicitationResponse>;

/**
 * Handles elicitation requests: an agent asking the user for structured input
 * instead of guessing. Only the form mode is supported, matching the client
 * capability sent during initialize.
 */
export class ElicitationHandler {
  private presenter: ElicitationPresenter | undefined;

  setPresenter(presenter: ElicitationPresenter | undefined): void {
    this.presenter = presenter;
  }

  async createElicitation(
    params: CreateElicitationRequest,
  ): Promise<CreateElicitationResponse> {
    if (params.mode !== 'form') {
      log(`createElicitation: declining unsupported mode ${params.mode}`);
      return { action: 'decline' };
    }
    if (!this.presenter) {
      log('createElicitation: declining, no presenter registered');
      return { action: 'decline' };
    }
    return this.presenter(params);
  }
}
