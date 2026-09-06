import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  appClient,
  asNoOrg,
  asOrg,
  cleanupTenant,
  createTenant,
  migratorClient,
  type TestTenant,
} from '../helpers/db.js';

/**
 * SECURITY SUITE 10 — KNOWLEDGE ISOLATION.
 *
 * This is the gate on Phase 2 (docs/roadmap.md).
 *
 * The threat is specific and worse than ordinary row leakage: knowledge chunks
 * become PROMPT CONTENT. A chunk that crosses a tenant boundary is not just a
 * visible row — it is another company's confidential material paraphrased by a
 * model into an answer, with no obvious trace that it happened.
 *
 * So retrieval is tested the way an attacker would probe it: by searching, from
 * Tenant A, for text that exists ONLY in Tenant B.
 */

let app: pg.Client;
let migrator: pg.Client;
let tenantA: TestTenant;
let tenantB: TestTenant;

/** Distinctive strings that must never cross the boundary. */
const SECRET_A = 'zarquon apricot ledger reconciliation';
const SECRET_B = 'blorptangle quarterly severance settlement';

interface Knowledge {
  sourceId: string;
  documentId: string;
}

async function seedKnowledge(
  tenant: TestTenant,
  label: string,
  secretPhrase: string,
): Promise<Knowledge> {
  return asOrg(app, tenant.organizationId, async () => {
    const source = await app.query<{ id: string }>(
      `INSERT INTO knowledge_sources (organization_id, type, name, status)
       VALUES ($1, 'UPLOAD', $2, 'READY') RETURNING id`,
      [tenant.organizationId, `${label} source`],
    );
    const sourceId = source.rows[0]!.id;

    const document = await app.query<{ id: string }>(
      `INSERT INTO knowledge_documents
         (organization_id, source_id, title, mime_type, byte_size, checksum, status)
       VALUES ($1, $2, $3, 'text/markdown', 100, $4, 'READY') RETURNING id`,
      [tenant.organizationId, sourceId, `${label} handbook`, `checksum-${label}`],
    );
    const documentId = document.rows[0]!.id;

    const chunks = [
      `Company policy for ${label}. The phrase ${secretPhrase} appears only here.`,
      `Refund terms for ${label}: refunds are issued within 30 days of purchase.`,
      `Contact details for ${label} support are listed in the appendix.`,
    ];

    for (const [index, content] of chunks.entries()) {
      await app.query(
        `INSERT INTO knowledge_chunks
           (organization_id, document_id, source_id, chunk_index, content, token_count, heading_path)
         VALUES ($1, $2, $3, $4, $5, 20, ARRAY['Handbook','Policies'])`,
        [tenant.organizationId, documentId, sourceId, index, content],
      );
    }

    return { sourceId, documentId };
  });
}

let knowledgeA: Knowledge;
let knowledgeB: Knowledge;

beforeAll(async () => {
  app = await appClient();
  migrator = await migratorClient();
  tenantA = await createTenant(migrator, app, 'ka');
  tenantB = await createTenant(migrator, app, 'kb');
  knowledgeA = await seedKnowledge(tenantA, 'alpha', SECRET_A);
  knowledgeB = await seedKnowledge(tenantB, 'beta', SECRET_B);
}, 60_000);

afterAll(async () => {
  for (const tenant of [tenantA, tenantB]) {
    if (!tenant) continue;
    await asOrg(app, tenant.organizationId, async () => {
      await app.query('DELETE FROM knowledge_sources WHERE organization_id = $1', [
        tenant.organizationId,
      ]);
    }).catch(() => undefined);
    await cleanupTenant(migrator, tenant);
  }
  await app?.end();
  await migrator?.end();
});

describe('knowledge tables are RLS-protected', () => {
  for (const table of ['knowledge_sources', 'knowledge_documents', 'knowledge_chunks']) {
    it(`${table} has RLS enabled and forced`, async () => {
      const { rows } = await app.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relname = $1 AND relnamespace = 'public'::regnamespace`,
        [table],
      );
      expect(rows[0]?.relrowsecurity, `${table} RLS must be ENABLED`).toBe(true);
      expect(rows[0]?.relforcerowsecurity, `${table} RLS must be FORCED`).toBe(true);
    });
  }
});

describe('direct reads are confined to the bound organization', () => {
  it('shows Tenant A only its own sources', async () => {
    const rows = await asOrg(app, tenantA.organizationId, async () =>
      (await app.query('SELECT id, organization_id FROM knowledge_sources')).rows,
    );
    expect(rows.every((r) => r.organization_id === tenantA.organizationId)).toBe(true);
    expect(rows.map((r) => r.id)).not.toContain(knowledgeB.sourceId);
  });

  it('shows Tenant A only its own documents and chunks', async () => {
    await asOrg(app, tenantA.organizationId, async () => {
      const documents = await app.query('SELECT id, organization_id FROM knowledge_documents');
      expect(documents.rows.map((r) => r.id)).not.toContain(knowledgeB.documentId);

      const chunks = await app.query('SELECT organization_id FROM knowledge_chunks');
      expect(chunks.rows.every((r) => r.organization_id === tenantA.organizationId)).toBe(true);
      expect(chunks.rows.length).toBeGreaterThan(0);
    });
  });

  it("returns nothing when Tenant A requests Tenant B's document by id", async () => {
    const rows = await asOrg(app, tenantA.organizationId, async () =>
      (await app.query('SELECT * FROM knowledge_documents WHERE id = $1', [knowledgeB.documentId]))
        .rows,
    );
    expect(rows).toHaveLength(0);
  });

  it('constrains an unfiltered chunk scan to one organization', async () => {
    const rows = await asOrg(app, tenantA.organizationId, async () =>
      (await app.query('SELECT organization_id FROM knowledge_chunks')).rows,
    );
    expect(new Set(rows.map((r) => r.organization_id)).size).toBe(1);
  });

  it('shows nothing at all with no organization bound', async () => {
    await asNoOrg(app, async () => {
      for (const table of ['knowledge_sources', 'knowledge_documents', 'knowledge_chunks']) {
        const { rows } = await app.query(`SELECT * FROM ${table}`);
        expect(rows, `${table} must be empty when unbound`).toHaveLength(0);
      }
    });
  });
});

/**
 * The heart of the suite. Retrieval is the path by which a chunk becomes an
 * answer, so it is tested against content that exists in exactly one tenant.
 */
describe('retrieval never crosses the tenant boundary', () => {
  const fullText = `
    SELECT c.id, c.content, c.organization_id
      FROM knowledge_chunks c
      JOIN knowledge_documents d ON d.id = c.document_id
         , to_tsquery('english', $1) AS query
     WHERE c.organization_id = $2
       AND d.deleted_at IS NULL
       AND c.content_tsv @@ query
     ORDER BY ts_rank_cd(c.content_tsv, query) DESC
     LIMIT 20`;

  it("full-text search from Tenant A cannot find Tenant B's secret phrase", async () => {
    const rows = await asOrg(app, tenantA.organizationId, async () =>
      (await app.query(fullText, ['blorptangle | severance', tenantA.organizationId])).rows,
    );
    expect(rows).toHaveLength(0);
  });

  it("Tenant B CAN find its own phrase — proving the query itself works", async () => {
    const rows = await asOrg(app, tenantB.organizationId, async () =>
      (await app.query(fullText, ['blorptangle | severance', tenantB.organizationId])).rows,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.content).toContain('blorptangle');
  });

  /*
   * A forged organization_id in the query predicate. RLS ignores it: the
   * policy is ANDed with whatever the caller writes, so widening the predicate
   * cannot widen the result.
   */
  it("a forged organization_id in the WHERE clause does not widen results", async () => {
    const rows = await asOrg(app, tenantA.organizationId, async () =>
      (await app.query(fullText, ['blorptangle | severance', tenantB.organizationId])).rows,
    );
    expect(rows).toHaveLength(0);
  });

  it('a query with NO organization predicate is still confined by RLS', async () => {
    const rows = await asOrg(app, tenantA.organizationId, async () =>
      (
        await app.query(
          `SELECT c.organization_id, c.content FROM knowledge_chunks c
             , to_tsquery('english', $1) AS query
            WHERE c.content_tsv @@ query`,
          ['refunds | policy'],
        )
      ).rows,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.organization_id === tenantA.organizationId)).toBe(true);
    for (const row of rows) {
      expect(String(row.content)).not.toContain('beta');
    }
  });

  it('trigram search is confined the same way', async () => {
    const rows = await asOrg(app, tenantA.organizationId, async () =>
      (
        await app.query(
          `SELECT organization_id, content FROM knowledge_chunks
            WHERE content %> $1 ORDER BY similarity(content, $1) DESC LIMIT 20`,
          ['blorptangle quarterly severance'],
        )
      ).rows,
    );
    expect(rows).toHaveLength(0);
  });

  /*
   * Both tenants have near-identical refund wording. This is the realistic
   * case: shared vocabulary is exactly when a boundary failure is hardest to
   * notice, because the answer looks plausible either way.
   */
  it('separates tenants whose content is nearly identical', async () => {
    const forA = await asOrg(app, tenantA.organizationId, async () =>
      (await app.query(fullText, ['refunds', tenantA.organizationId])).rows,
    );
    const forB = await asOrg(app, tenantB.organizationId, async () =>
      (await app.query(fullText, ['refunds', tenantB.organizationId])).rows,
    );

    expect(forA.length).toBeGreaterThan(0);
    expect(forB.length).toBeGreaterThan(0);
    expect(forA.every((r) => String(r.content).includes('alpha'))).toBe(true);
    expect(forB.every((r) => String(r.content).includes('beta'))).toBe(true);

    const idsA = new Set(forA.map((r) => r.id));
    expect(forB.some((r) => idsA.has(r.id))).toBe(false);
  });
});

describe('writes cannot cross the boundary', () => {
  it("cannot insert a chunk attributed to another organization", async () => {
    await expect(
      asOrg(app, tenantA.organizationId, async () =>
        app.query(
          `INSERT INTO knowledge_chunks
             (organization_id, document_id, source_id, chunk_index, content, token_count)
           VALUES ($1, $2, $3, 999, 'injected content', 5)`,
          [tenantB.organizationId, knowledgeB.documentId, knowledgeB.sourceId],
        ),
      ),
    ).rejects.toThrow(/row-level security|violates foreign key/i);
  });

  it("cannot update another organization's chunk", async () => {
    const result = await asOrg(app, tenantA.organizationId, async () =>
      app.query('UPDATE knowledge_chunks SET content = $1 WHERE organization_id = $2', [
        'overwritten',
        tenantB.organizationId,
      ]),
    );
    expect(result.rowCount).toBe(0);

    const intact = await asOrg(app, tenantB.organizationId, async () =>
      (await app.query('SELECT content FROM knowledge_chunks WHERE organization_id = $1', [
        tenantB.organizationId,
      ])).rows,
    );
    expect(intact.every((r) => r.content !== 'overwritten')).toBe(true);
  });

  it("cannot delete another organization's source", async () => {
    const result = await asOrg(app, tenantA.organizationId, async () =>
      app.query('DELETE FROM knowledge_sources WHERE id = $1', [knowledgeB.sourceId]),
    );
    expect(result.rowCount).toBe(0);

    const survives = await asOrg(app, tenantB.organizationId, async () =>
      (await app.query('SELECT id FROM knowledge_sources WHERE id = $1', [knowledgeB.sourceId]))
        .rows,
    );
    expect(survives).toHaveLength(1);
  });

  it('cannot re-parent a document into another organization', async () => {
    await expect(
      asOrg(app, tenantA.organizationId, async () =>
        app.query('UPDATE knowledge_documents SET organization_id = $1 WHERE id = $2', [
          tenantB.organizationId,
          knowledgeA.documentId,
        ]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('deletion is scoped', () => {
  it("deleting a source removes only that organization's knowledge", async () => {
    const scratch = await seedKnowledge(tenantA, 'scratch', 'ephemeral marker phrase');

    await asOrg(app, tenantA.organizationId, async () => {
      await app.query('DELETE FROM knowledge_sources WHERE id = $1', [scratch.sourceId]);
    });

    // Cascade removed its documents and chunks…
    const remaining = await asOrg(app, tenantA.organizationId, async () =>
      (await app.query('SELECT id FROM knowledge_documents WHERE source_id = $1', [
        scratch.sourceId,
      ])).rows,
    );
    expect(remaining).toHaveLength(0);

    // …and left the other tenant untouched.
    const tenantBChunks = await asOrg(app, tenantB.organizationId, async () =>
      (await app.query('SELECT id FROM knowledge_chunks WHERE organization_id = $1', [
        tenantB.organizationId,
      ])).rows,
    );
    expect(tenantBChunks.length).toBeGreaterThan(0);
  });
});
