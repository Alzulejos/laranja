import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { FooModule } from './foo/foo.module';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    FooModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
