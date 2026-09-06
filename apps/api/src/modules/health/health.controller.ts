import { Controller, Get, Inject } from '@nestjs/common';
import { Database } from '@moka/db';
import { DATABASE } from '../../database/database.module.js';
import { Public } from '../../common/decorators.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Liveness. Deliberately returns no version, dependency or configuration
   * detail — a health endpoint is unauthenticated and must not become a
   * reconnaissance surface.
   */
  @Public()
  @Get()
  live() {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  async ready() {
    const database = await this.db.healthCheck();
    return { status: database ? 'ok' : 'degraded', database };
  }
}
