import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';
import { InMemoryRateLimiter, RATE_LIMITER } from './rate-limit.js';

/**
 * Cross-cutting services used by every feature module.
 *
 * Global because auditing must be available everywhere without each module
 * re-importing it — an audit call that is inconvenient to reach is an audit
 * call that gets omitted.
 */
@Global()
@Module({
  providers: [AuditService, { provide: RATE_LIMITER, useClass: InMemoryRateLimiter }],
  exports: [AuditService, RATE_LIMITER],
})
export class CommonModule {}
