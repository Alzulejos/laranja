import { Module } from '@nestjs/common';
import { QueueService } from './queue.service';
import { workers } from '@alzulejos/laranja-decorators';

@Module({
  providers: [QueueService],
})
export class QueueModule {}

export default workers(QueueModule);
