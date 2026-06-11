import { NextResponse } from "next/server";
import { prisma } from "@nexus/db";

export const dynamic = "force-dynamic";

type ComponentStatus = "ok" | "degraded" | "unavailable";

async function checkDatabase(): Promise<ComponentStatus> {
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 2_000),
      ),
    ]);
    return "ok";
  } catch {
    return "unavailable";
  }
}

async function checkQuantService(): Promise<ComponentStatus> {
  const base = process.env.QUANT_SERVICE_URL;
  if (!base) return "unavailable";
  try {
    const res = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(2_000),
      cache: "no-store",
    });
    return res.ok ? "ok" : "degraded";
  } catch {
    return "unavailable";
  }
}

export async function GET() {
  const [database, quant] = await Promise.all([
    checkDatabase(),
    checkQuantService(),
  ]);

  const components = { web: "ok" as ComponentStatus, database, quant };
  const status: ComponentStatus = Object.values(components).every(
    (s) => s === "ok",
  )
    ? "ok"
    : "degraded";

  return NextResponse.json({
    data: {
      status,
      components,
      version: "0.1.0",
      generatedAt: new Date().toISOString(),
    },
  });
}
