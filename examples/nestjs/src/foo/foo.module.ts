import { Module } from '@nestjs/common';
import { FooService } from './foo.service';
import { FooController } from './foo.controller';

@Module({
  providers: [FooService],
  controllers: [FooController],
})
export class FooModule {}
