import { Module } from '@nestjs/common';
import { ChatbotsController, ChatInboxController } from './chatbots.controller.js';
import { PublicChatController } from './public-chat.controller.js';
import { WidgetController } from './widget.controller.js';
import { ChatbotsService } from './chatbots.service.js';
import { VisitorService } from './visitor.service.js';
import { SupportAgentService } from './support-agent.service.js';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { AiModule } from '../ai/ai.module.js';

/**
 * Customer chatbots (§22–24).
 *
 * Note what this module does NOT import: AgentsModule. The public path builds
 * its own single-tool registry per turn rather than reusing the staff tool
 * backend, so there is no wiring through which a staff tool could reach a
 * visitor — not by configuration mistake and not by a later refactor that adds
 * a tool without thinking about who can call it.
 *
 * It does share the `AgentRuntime` itself, deliberately: the public surface is
 * the one that most needs the real authorisation gates rather than a
 * simplified copy written for a path someone assumed was harmless.
 */
@Module({
  imports: [KnowledgeModule, AiModule],
  controllers: [ChatbotsController, ChatInboxController, PublicChatController, WidgetController],
  providers: [ChatbotsService, VisitorService, SupportAgentService],
  exports: [ChatbotsService],
})
export class ChatModule {}
