import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { DatabaseModule } from './database/database.module.js';
import { CommonModule } from './common/common.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { OrganizationsModule } from './modules/organizations/organizations.module.js';
import { ProjectsModule } from './modules/projects/projects.module.js';
import { KnowledgeModule } from './modules/knowledge/knowledge.module.js';
import { AiModule } from './modules/ai/ai.module.js';
import { AgentsModule } from './modules/agents/agents.module.js';
import { ChatModule } from './modules/chat/chat.module.js';
import { ResearchModule } from './modules/research/research.module.js';
import { BillingModule } from './modules/billing/billing.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { AuthGuard } from './common/guards/auth.guard.js';
import { TenantGuard } from './common/guards/tenant.guard.js';
import { PermissionGuard } from './common/guards/permission.guard.js';
import { HttpExceptionFilter } from './common/http-exception.filter.js';

/**
 * Guard order is a security property, not a detail.
 *
 *   AuthGuard       establishes WHO is calling
 *   TenantGuard     establishes WHICH organization, from the session alone
 *   PermissionGuard establishes WHETHER that role may do this
 *
 * Nest runs APP_GUARD providers in registration order, so this array IS the
 * enforcement order. Reordering it would let permission checks run against an
 * unresolved tenant.
 *
 * All three are GLOBAL: a new route is protected by default and must opt out
 * explicitly with @Public(), rather than being exposed by forgetting a guard.
 */
@Module({
  imports: [
    DatabaseModule,
    CommonModule,
    AuthModule,
    OrganizationsModule,
    ProjectsModule,
    KnowledgeModule,
    AiModule,
    AgentsModule,
    ChatModule,
    ResearchModule,
    BillingModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
