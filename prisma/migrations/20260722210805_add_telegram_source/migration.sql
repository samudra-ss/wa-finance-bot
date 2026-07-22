-- AlterEnum
-- Adds TELEGRAM so Transaction.source can distinguish Telegram-logged rows.
-- BEFORE 'APP' keeps the DB enum order matching prisma/schema.prisma.
ALTER TYPE "TxSource" ADD VALUE 'TELEGRAM' BEFORE 'APP';
