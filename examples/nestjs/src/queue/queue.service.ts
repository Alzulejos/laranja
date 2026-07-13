import { Queue } from '@alzulejos/laranja-decorators';
import { Injectable } from '@nestjs/common';
import { User } from 'src/libs/types/src';

@Injectable()
export class QueueService {
  @Queue({ name: 'onBoardingEmails', batchSize: 5 })
  async sendOnboardingEmails({ users }: { users: User[] }) {
    await this.sendEmails(users);
    return true;
  }

  @Queue({ name: 'onBoardingEmailsDQL', batchSize: 1 })
  sendOnboardingEmailsDQL({ users }: { users: User[] }) {
    console.error(`Failed to onBoard ${JSON.stringify(users)}`);
    return true;
  }

  private async sendEmails(users: User[]) {
    console.log(`Sending Emails to ${JSON.stringify(users)}`);
    return Promise.resolve(true);
  }
}
