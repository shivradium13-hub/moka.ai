import { Module } from '@nestjs/common';
import { AgentsController } from './agents.controller.js';
import { AgentsService } from './agents.service.js';
import { AgentRunnerService } from './agent-runner.service.js';
import { ToolBackendService } from './tool-backend.service.js';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { AiModule } from '../ai/ai.module.js';
import { ResearchModule } from '../research/research.module.js';

@Module({
  // KnowledgeModule supplies RetrievalService (the search_knowledge tool);
  // AiModule supplies GatewayService (the agent's model);
  // ResearchModule supplies ResearchService (the web_research tool).
  imports: [KnowledgeModule, AiModule, ResearchModule],
  controllers: [AgentsController],
  providers: [AgentsService, AgentRunnerService, ToolBackendService],
  exports: [AgentsService, AgentRunnerService],
})
export class AgentsModule {}
