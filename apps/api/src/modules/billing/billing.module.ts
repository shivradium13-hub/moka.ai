import { Global, Module } from '@nestjs/common';
import { BillingController } from './billing.controller.js';
import { EntitlementsService } from './entitlements.service.js';
import { CreditsService } from './credits.service.js';
import { SubscriptionsService } from './subscriptions.service.js';
import { UsageService } from './usage.service.js';

/**
 * Plans, entitlements, credits and usage (§34, §35).
 *
 * GLOBAL, like CommonModule, and for the same reason: enforcement has to be
 * available at every creation path — agents, chatbots, projects, knowledge
 * sources, research, members — and a check that is inconvenient to reach is a
 * check that gets omitted. Making each feature module import this would mean
 * the one that forgot is the one with no limit.
 */
@Global()
@Module({
  controllers: [BillingController],
  providers: [EntitlementsService, CreditsService, SubscriptionsService, UsageService],
  exports: [EntitlementsService, CreditsService, SubscriptionsService, UsageService],
})
export class BillingModule {}
