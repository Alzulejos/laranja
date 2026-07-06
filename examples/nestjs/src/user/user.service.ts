import { Injectable } from '@nestjs/common';
import { User } from 'src/libs/types/src';

@Injectable()
export class UserService {
  findUsersToOnboard(): User[] {
    return [
      {
        id: 1,
        name: 'Jaun',
        email: 'juan@example.com',
      },
      {
        id: 2,
        name: 'Tom',
        email: 'tom@example.com ',
      },
    ];
  }
}
