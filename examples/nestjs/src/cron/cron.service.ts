import { Cron, CronExpression, getQueue } from '@alzulejos/laranja-decorators';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserService } from 'src/user/user.service';

@Injectable()
export class CronService {
  constructor(
    private readonly configService: ConfigService,
    private readonly userService: UserService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async sweep() {
    const bar = this.configService.get<string>('VALUE') ?? 'Sweep';
    const users = this.userService.findUsersToOnboard();
    try {
      await getQueue('onBoardingEmails').send({ users, bar });
      return true;
    } catch (e: any) {
      throw new Error(e);
    }
  }
}
