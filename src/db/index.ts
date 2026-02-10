import { type Client, createClient } from '@libsql/client'
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql'
import * as schema from './schema.ts'

function getEnv(name: string): string {
  const value = Bun.env[name]
  if (!value) {
    throw new Error(`${name} env var not set.`)
  }
  return value
}

export type Db = LibSQLDatabase<typeof schema> & { client: Client }

export function createDb(): Db {
  const remoteUrl = getEnv('TURSO_DATABASE_URL')
  const authToken = getEnv('TURSO_AUTH_TOKEN')
  const localPath = Bun.env.TURSO_LOCAL_DB ?? ''

  const client = localPath
    ? createClient({
        authToken,
        syncUrl: remoteUrl,
        url: `file:${localPath}`,
      })
    : createClient({
        authToken,
        url: remoteUrl,
      })

  const db = drizzle(client, { schema })

  return Object.assign(db, { client })
}
