import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permission, ValidationError, type TenantContext } from '@moka/core';
import { stripTenantKeys } from '@moka/tenancy';
import { ALL_SOURCE_TYPES, type KnowledgeSourceType } from '@moka/db';
import { MAX_DOCUMENT_BYTES, supportedExtensions } from '@moka/knowledge';
import { KnowledgeService } from './knowledge.service.js';
import { IngestionService } from './ingestion.service.js';
import { RetrievalService } from './retrieval.service.js';
import { CurrentTenant, RequestId, RequirePermission } from '../../common/decorators.js';

const idSchema = z.string().uuid();

const createSourceSchema = z.object({
  type: z.enum(ALL_SOURCE_TYPES as unknown as [KnowledgeSourceType, ...KnowledgeSourceType[]]),
  name: z.string().min(1).max(160),
  projectId: z.string().uuid().nullish(),
  config: z.record(z.unknown()).optional(),
});

/**
 * Base64 upload.
 *
 * Multipart would be the better transport and arrives with the queue-backed
 * pipeline. Base64 inflates by ~33%, so the encoded cap is set accordingly and
 * checked BEFORE decoding — decoding first would let a caller allocate 33 MB
 * to be told the file is too large.
 */
const MAX_BASE64_LENGTH = Math.ceil((MAX_DOCUMENT_BYTES * 4) / 3) + 1024;

const uploadSchema = z.object({
  sourceId: z.string().uuid(),
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255).default('application/octet-stream'),
  contentBase64: z.string().min(1).max(MAX_BASE64_LENGTH),
});

const ingestTextSchema = z.object({
  sourceId: z.string().uuid(),
  title: z.string().min(1).max(160),
  text: z.string().min(1).max(MAX_DOCUMENT_BYTES),
});

const searchSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  sourceIds: z.array(z.string().uuid()).max(50).optional(),
});

/**
 * Validate and narrow.
 *
 * Returns `z.output<S>` rather than being generic over a single T: a schema
 * using `.default()` has different input and output types, and `z.ZodType<T>`
 * conflates them — which silently infers optional fields as `T | undefined`.
 */
function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError({
      fields: result.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`),
    });
  }
  return result.data;
}

@Controller('v1/knowledge')
export class KnowledgeController {
  constructor(
    private readonly knowledge: KnowledgeService,
    private readonly ingestion: IngestionService,
    private readonly retrieval: RetrievalService,
  ) {}

  /** Client capability discovery: accepted formats, limits, retrieval mode. */
  @RequirePermission(Permission.PROJECT_READ)
  @Get('capabilities')
  async capabilities() {
    return {
      supportedExtensions: supportedExtensions(),
      maxDocumentBytes: MAX_DOCUMENT_BYTES,
      sourceTypes: ALL_SOURCE_TYPES,
      // Reported honestly so the UI can tell the user results are lexical.
      denseRetrievalAvailable: await this.retrieval.denseAvailable(),
      ingestionMode: 'inline' as const,
    };
  }

  @RequirePermission(Permission.PROJECT_READ)
  @Get('sources')
  async listSources(@CurrentTenant() tenant: TenantContext) {
    return { sources: await this.knowledge.listSources(tenant) };
  }

  @RequirePermission(Permission.PROJECT_CREATE)
  @Post('sources')
  async createSource(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
    @RequestId() requestId: string,
  ) {
    const input = parse(createSourceSchema, stripTenantKeys((body ?? {}) as Record<string, unknown>));
    return { source: await this.knowledge.createSource(tenant, input, { requestId }) };
  }

  @RequirePermission(Permission.PROJECT_READ)
  @Get('sources/:id')
  async getSource(@CurrentTenant() tenant: TenantContext, @Param('id') id: string) {
    return { source: await this.knowledge.getSource(tenant, parse(idSchema, id)) };
  }

  @RequirePermission(Permission.PROJECT_DELETE)
  @Delete('sources/:id')
  async deleteSource(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ) {
    await this.knowledge.deleteSource(tenant, parse(idSchema, id), { requestId });
    return { ok: true };
  }

  @RequirePermission(Permission.PROJECT_READ)
  @Get('documents')
  async listDocuments(
    @CurrentTenant() tenant: TenantContext,
    @Query('sourceId') sourceId?: string,
  ) {
    const scoped = sourceId ? parse(idSchema, sourceId) : undefined;
    return { documents: await this.knowledge.listDocuments(tenant, scoped) };
  }

  @RequirePermission(Permission.PROJECT_CREATE)
  @Post('documents/upload')
  async upload(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
    @RequestId() requestId: string,
  ) {
    const input = parse(uploadSchema, stripTenantKeys((body ?? {}) as Record<string, unknown>));

    const bytes = decodeBase64(input.contentBase64);
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
      throw new ValidationError({
        file: `File exceeds the ${Math.floor(MAX_DOCUMENT_BYTES / 1024 / 1024)} MB limit.`,
      });
    }

    return this.ingestion.ingestUpload(tenant, {
      sourceId: input.sourceId,
      filename: input.filename,
      mimeType: input.mimeType,
      bytes,
      requestId,
    });
  }

  @RequirePermission(Permission.PROJECT_CREATE)
  @Post('documents/text')
  async ingestText(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
    @RequestId() requestId: string,
  ) {
    const input = parse(ingestTextSchema, stripTenantKeys((body ?? {}) as Record<string, unknown>));
    return this.ingestion.ingestText(tenant, { ...input, requestId });
  }

  @RequirePermission(Permission.PROJECT_DELETE)
  @Delete('documents/:id')
  async deleteDocument(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ) {
    await this.ingestion.deleteDocument(tenant, parse(idSchema, id), { requestId });
    return { ok: true };
  }

  @RequirePermission(Permission.PROJECT_READ)
  @Get('documents/:id/chunks')
  async listChunks(@CurrentTenant() tenant: TenantContext, @Param('id') id: string) {
    return { chunks: await this.knowledge.listChunks(tenant, parse(idSchema, id)) };
  }

  /**
   * Retrieval.
   *
   * POST rather than GET: a query is user content that would otherwise land in
   * access logs, browser history and referrer headers. Not personal data as
   * such, but it costs nothing to keep it out of URLs (docs/security.md
   * privacy note).
   */
  @RequirePermission(Permission.PROJECT_READ)
  @Post('search')
  async search(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    const input = parse(searchSchema, stripTenantKeys((body ?? {}) as Record<string, unknown>));
    const result = await this.retrieval.search(tenant, {
      text: input.query,
      limit: input.limit,
      ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
    });
    return result;
  }
}

/**
 * Decode base64 strictly.
 *
 * Node's Buffer.from is lenient: it silently discards invalid characters, so
 * corrupt input would be ingested as truncated content rather than rejected.
 * Re-encoding and comparing catches that.
 */
function decodeBase64(value: string): Uint8Array {
  const normalised = value.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalised)) {
    throw new ValidationError({ contentBase64: 'Not valid base64.' });
  }
  const buffer = Buffer.from(normalised, 'base64');
  if (buffer.toString('base64').replace(/=+$/, '') !== normalised.replace(/=+$/, '')) {
    throw new ValidationError({ contentBase64: 'Not valid base64.' });
  }
  return new Uint8Array(buffer);
}
