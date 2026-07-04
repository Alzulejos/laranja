import { Module } from '@nestjs/common';
import { CronService } from './cron.service';
import { workers } from '@alzulejos/laranja-decorators';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [ConfigModule],
  providers: [CronService],
})
export class CronModule {}

export default workers(CronModule);
