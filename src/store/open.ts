// Which store a `--db` / $TIRA_DB value names: a postgres:// (or postgresql://) URL is the shared
// Postgres store; anything else is a SQLite file path, as before.
import type { EventStore } from "./types.ts";
import { SqliteEventStore } from "./sqlite-store.ts";
import { PostgresEventStore } from "./postgres-store.ts";

export type ClosableStore = EventStore & { close(): void | Promise<void> };

export const isPostgresUrl = (db: string): boolean => /^postgres(ql)?:\/\//i.test(db);

// A store's name for messages: a URL's password never printed.
export const dbLabel = (db: string): string => (isPostgresUrl(db) ? db.replace(/^(\w+:\/\/[^:/@]+):[^@/]*@/, "$1:***@") : db);

export function openStore(db: string): ClosableStore {
  return isPostgresUrl(db) ? new PostgresEventStore({ url: db }) : new SqliteEventStore({ path: db });
}
