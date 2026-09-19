// Runs before every test file. The `test` npm script points DATABASE_URL at test.db
// and resets it with `prisma db push --force-reset`, so tests start from an empty schema.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'file:./test.db';
