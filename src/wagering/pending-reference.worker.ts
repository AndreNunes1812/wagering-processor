import { Injectable } from '@nestjs/common';
import { WageringService } from './wagering.service';

@Injectable()
export class PendingReferenceWorker {
  constructor(private readonly wagering: WageringService) {}

  reprocessDue(now = new Date()): Promise<number> {
    return this.wagering.reprocessDue(now);
  }
}
