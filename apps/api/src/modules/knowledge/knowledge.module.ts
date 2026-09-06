import { Module } from '@nestjs/common';
import { KnowledgeController } from './knowledge.controller.js';
import { KnowledgeService } from './knowledge.service.js';
import { IngestionService } from './ingestion.service.js';
import { RetrievalService } from './retrieval.service.js';

@Module({
  controllers: [KnowledgeController],
  providers: [KnowledgeService, IngestionService, RetrievalService],
  exports: [RetrievalService],
})
export class KnowledgeModule {}
