import { drizzle } from 'drizzle-orm/libsql'
import * as schema from './schema.ts'

function getEnv(name: string): string {
  const value = Bun.env[name]
  if (!value) {
    throw new Error(`${name} env var not set.`)
  }
  return value
}

export function createDb() {
  return drizzle({
    connection: {
      authToken: getEnv('TURSO_AUTH_TOKEN'),
      url: getEnv('TURSO_DATABASE_URL'),
    },
    schema,
  })
}

export type Db = ReturnType<typeof createDb>
