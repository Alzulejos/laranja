import { NestFactory } from '@nestjs/core';
import { http } from '@alzulejos/laranja-decorators';
import { AppModule } from './app.module';

/**
 * Standard Nest bootstrap — configure the app however you like (pipes, guards,
 * middleware). The ONLY laranja requirement is `return app` instead of just
 * `app.listen(...)`, so laranja can grab the configured app for the Lambda.
 */
export async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3001);
  return app;
}

// Run the server locally with `npm run start`; skipped when laranja imports this.
if (require.main === module) void bootstrap();

// Mark this as the HTTP app for laranja (identity marker — returns bootstrap as-is).
export default http(bootstrap);
