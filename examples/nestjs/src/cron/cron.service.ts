import { Cron, CronExpression } from '@alzulejos/laranja-decorators';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class CronService {
  constructor(private readonly configService: ConfigService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  sweep() {
    return this.configService.get<string>('VALUE') ?? 'Sweep';
  }
}
