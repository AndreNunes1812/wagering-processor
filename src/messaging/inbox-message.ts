import { InvalidOperationError } from '../errors';

export type ReceiveInboxProps = {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
};

export type InboxMessageState = ReceiveInboxProps & {
  processedAt?: Date;
};

export class InboxMessage {
  private constructor(
    readonly messageId: string,
    readonly consumerName: string,
    readonly payloadHash: string,
    readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.receivedAt);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt != null;
  }

  markProcessed(at: Date): void {
    if (this._processedAt) {
      throw new InvalidOperationError('inbox message already processed');
    }
    this._processedAt = at;
  }
}
