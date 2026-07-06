import { Module } from '@nestjs/common';
import { CronService } from './cron.service';
import { workers } from '@alzulejos/laranja-decorators';
import { ConfigModule } from '@nestjs/config';
import { UserModule } from 'src/user/user.module';

@Module({
  imports: [ConfigModule, UserModule],
  providers: [CronService],
})
export class CronModule {}

export default workers(CronModule);
