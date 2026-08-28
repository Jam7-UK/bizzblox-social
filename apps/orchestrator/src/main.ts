import { initializeSentry } from '@gitroom/nestjs-libraries/sentry/initialize.sentry';
import { installManagedRuntimeLogBoundary } from '@gitroom/nestjs-libraries/bizzblox/runtime-logging';
initializeSentry('orchestrator', true);
if (process.env.BIZZBLOX_SERVICE_MODE === '1') {
  installManagedRuntimeLogBoundary();
}
import 'source-map-support/register';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
dayjs.extend(utc);

import { NestFactory } from '@nestjs/core';
import { AppModule } from '@gitroom/orchestrator/app.module';
import * as dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const port = process.env.ORCHESTRATOR_PORT || 3002;
  await app.listen(port);
  console.log(`Orchestrator health check listening on port ${port}`);
}

bootstrap();
