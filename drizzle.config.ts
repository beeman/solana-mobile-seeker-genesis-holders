import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dbCredentials: {
    authToken: process.env.TURSO_AUTH_TOKEN ?? '',
    url: process.env.TURSO_DATABASE_URL ?? '',
  },
  dialect: 'turso',
  out: './drizzle',
  schema: './src/db/schema.ts',
})
