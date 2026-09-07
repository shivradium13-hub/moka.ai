import { Module } from '@nestjs/common';
import { ResearchController, CrawlController } from './research.controller.js';
import { ResearchService } from './research.service.js';
import { CrawlerService } from './crawler.service.js';
import { RobotsService } from './robots.service.js';
import { PageFetcherService } from './page-fetcher.service.js';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { AiModule } from '../ai/ai.module.js';

/**
 * Web research and crawling (§7–§9).
 *
 * `RobotsService` and `PageFetcherService` are exported because the agent tool
 * backend needs the research pipeline too. Sharing them matters: two ways to
 * fetch a page would mean two places to remember robots.txt and the SSRF
 * guard, and the second one would be the one that forgot.
 */
@Module({
  // KnowledgeModule supplies IngestionService (the crawler writes documents);
  // AiModule supplies GatewayService (synthesis).
  imports: [KnowledgeModule, AiModule],
  controllers: [ResearchController, CrawlController],
  providers: [ResearchService, CrawlerService, RobotsService, PageFetcherService],
  exports: [ResearchService, CrawlerService],
})
export class ResearchModule {}
