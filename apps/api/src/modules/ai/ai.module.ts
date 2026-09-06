import { Module } from '@nestjs/common';
import { AiController } from './ai.controller.js';
import { GatewayService } from './gateway.service.js';
import { CredentialsService } from './credentials.service.js';

@Module({
  controllers: [AiController],
  providers: [GatewayService, CredentialsService],
  exports: [GatewayService, CredentialsService],
})
export class AiModule {}
