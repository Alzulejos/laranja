import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Controller('foo')
export class FooController {
  constructor(private readonly configService: ConfigService) {}

  @Get('/')
  foo() {
    return this.configService.get<string>('foo') ?? 'bar';
  }
}
