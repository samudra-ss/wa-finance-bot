import { PrismaClient } from '@prisma/client';

// Single shared PrismaClient. Stashed on globalThis so `node --watch` reloads
// don't stack up connection pools against Postgres.
const g = globalThis;
export const prisma = g.__waFinPrisma ?? new PrismaClient();
g.__waFinPrisma = prisma;
