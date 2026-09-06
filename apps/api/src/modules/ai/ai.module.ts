import { Module } from '@nestjs/common';
import { AiController } from './ai.controller.js';
import { GatewayService } from './gateway.service.js';
import { CredentialsService } from './credentials.service.js';
import { VaultService } from './vault.service.js';
import { CredentialsController } from './credentials.controller.js';

@Module({
  controllers: [AiController, CredentialsController],
  providers: [GatewayService, CredentialsService, VaultService],
  exports: [GatewayService, CredentialsService, VaultService],
})
export class AiModule {}
