import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  PurgeQueueCommand,
  GetQueueAttributesCommand,
  QueueAttributeName,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Injectable } from '@nestjs/common';
import { config } from '../config';

export type ReceivedMessage = {
  messageId: string;
  receiptHandle: string;
  body: string;
  receiveCount: number;
};

@Injectable()
export class SqsQueue {
  private readonly client = new SQSClient({
    region: config.sqs.region,
    endpoint: config.sqs.endpoint,
    credentials: {
      accessKeyId: config.sqs.accessKeyId,
      secretAccessKey: config.sqs.secretAccessKey,
    },
  });

  private eventsReady = false;

  async ping(): Promise<void> {
    await this.ensureEventsQueue();
    await this.attributes(config.sqs.wagerQueueUrl);
    await this.attributes(config.sqs.eventsQueueUrl);
  }

  async ensureEventsQueue(): Promise<void> {
    if (this.eventsReady) return;
    await this.client.send(
      new CreateQueueCommand({
        QueueName: 'wager-events.fifo',
        Attributes: { FifoQueue: 'true' },
      }),
    );
    this.eventsReady = true;
  }

  async receive(
    queueUrl: string,
    max: number,
    waitSeconds: number,
    visibilitySeconds: number,
    signal?: AbortSignal,
  ): Promise<ReceivedMessage[]> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: max,
        WaitTimeSeconds: waitSeconds,
        VisibilityTimeout: visibilitySeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
      { abortSignal: signal },
    );
    return (response.Messages ?? []).flatMap((message) => {
      if (!message.MessageId || !message.ReceiptHandle || message.Body == null) return [];
      return [
        {
          messageId: message.MessageId,
          receiptHandle: message.ReceiptHandle,
          body: message.Body,
          receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? '1'),
        },
      ];
    });
  }

  async send(queueUrl: string, body: string, groupId: string, deduplicationId: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
        MessageGroupId: groupId,
        MessageDeduplicationId: deduplicationId,
      }),
    );
  }

  async publishEvent(payload: Record<string, unknown>, groupId: string, deduplicationId: string): Promise<void> {
    await this.ensureEventsQueue();
    await this.send(config.sqs.eventsQueueUrl, JSON.stringify(payload), groupId, deduplicationId);
  }

  async purge(queueUrl: string): Promise<void> {
    await this.client.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
  }

  async delete(queueUrl: string, receiptHandle: string): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
  }

  async changeVisibility(queueUrl: string, receiptHandle: string, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  private async attributes(queueUrl: string): Promise<void> {
    await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: [QueueAttributeName.QueueArn],
      }),
      { abortSignal: AbortSignal.timeout(2000) },
    );
  }
}
