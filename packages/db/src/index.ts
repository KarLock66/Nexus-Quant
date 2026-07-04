import { PrismaClient } from "@prisma/client";

/**
 * Singleton Prisma client. In Next.js dev, module re-evaluation would
 * otherwise open a new connection pool per HMR cycle.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export * from "@prisma/client";
export {
  ensureSignalDemoChain,
  type SignalDemoChain,
  type ChainLogger,
} from "./demo-signal-chain.js";
