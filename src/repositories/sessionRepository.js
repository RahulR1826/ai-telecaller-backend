import { db } from "../db/db.js";

export const getSession = async (sessionId) => {
  const session = await db.call.findUnique({ where: { callSid: sessionId } });
  return {
    exists: !!session,
    data: () => session
  };
};

export const updateSession = async (sessionId, data) => {
  // Clean up undefined values and auto-managed fields
  const cleanData = Object.fromEntries(
    Object.entries(data).filter(([_, v]) => v !== undefined)
  );
  delete cleanData.updatedAt; // Prisma handles @updatedAt automatically

  return await db.call.upsert({
    where: { callSid: sessionId },
    update: cleanData,
    create: {
      callSid: sessionId,
      ...cleanData,
    }
  });
};
