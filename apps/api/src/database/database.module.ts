import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Database } from '@moka/db';
import { loadConfig } from '@moka/config';

export const DATABASE = Symbol('DATABASE');

/**
 * Provides the single Database instance.
 *
 * Note the connection string comes from DATABASE_URL — the moka_app role,
 * which is NOT the schema owner and has NOBYPASSRLS. The migration
 * credentials (DATABASE_MIGRATION_URL) are deliberately never read here: the
 * running API must not hold rights to alter the schema or bypass policies
 * (docs/security.md §2.2).
 */
@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      useFactory: (): Database => {
        const config = loadConfig();
        return new Database({
          connectionString: config.DATABASE_URL,
          poolMax: config.DATABASE_POOL_MAX,
          ssl: config.DATABASE_SSL,
        });
      },
    },
  ],
  exports: [DATABASE],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor() {}

  async onApplicationShutdown(): Promise<void> {
    // The pool is closed explicitly in main.ts during graceful shutdown.
  }
}
