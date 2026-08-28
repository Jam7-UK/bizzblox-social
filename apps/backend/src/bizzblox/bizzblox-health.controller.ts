import { Controller, Get } from '@nestjs/common';

@Controller()
export class BizzbloxHealthController {
  @Get('/health')
  health(): Readonly<{ status: 'ok' }> {
    return Object.freeze({ status: 'ok' });
  }
}
