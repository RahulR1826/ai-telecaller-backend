import { db } from "../db/db.js";

/**
 * Helper: get the Call.id (UUID) from a callSid string.
 * If no record exists yet, creates a minimal Call record first.
 */
const getOrCreateCallId = async (callSid) => {
  let call = await db.call.findUnique({ where: { callSid } });
  if (!call) {
    call = await db.call.create({
      data: { callSid, status: "initiated" }
    });
  }
  return call.id;
};

export const addCallLog = async (data) => {
  // Resolve the internal Call.id from the callSid (sessionId)
  const callInternalId = await getOrCreateCallId(data.sessionId);

  return await db.transcript.create({
    data: {
      callId: callInternalId,
      speaker: data.speaker,
      text: data.text,
      source: data.source,
      sentiment: data.sentiment,
      intent: data.intent,
      timestamp: data.timestamp ? new Date(data.timestamp) : new Date(),
    }
  });
};

export const getCallLogsBySessionId = async (sessionId) => {
  const call = await db.call.findUnique({ where: { callSid: sessionId } });
  if (!call) return [];
  return await db.transcript.findMany({
    where: { callId: call.id },
    orderBy: { timestamp: "asc" }
  });
};

export const getCallSession = async (sid) => {
  const session = await db.call.findUnique({ where: { callSid: sid } });
  return {
    exists: !!session,
    data: () => session,
  };
};

export const updateCallSession = async (sid, data, merge = true) => {
  // Remove undefined/null fields that Prisma might reject
  const cleanData = Object.fromEntries(
    Object.entries(data).filter(([_, v]) => v !== undefined)
  );

  // Remove fields that are not in the Call model
  delete cleanData.sessionId;
  delete cleanData.updatedAt; // Prisma handles @updatedAt automatically

  return await db.call.upsert({
    where: { callSid: sid },
    update: cleanData,
    create: {
      callSid: sid,
      ...cleanData,
    }
  });
};

export const getAllCallSessions = async () => {
  return await db.call.findMany({
    orderBy: { startedAt: "desc" }
  });
};

export const addCallSummary = async (data) => {
  // Resolve the internal Call.id
  const callInternalId = await getOrCreateCallId(data.sessionId);

  // Use upsert to avoid duplicate summary errors
  return await db.summary.upsert({
    where: { callId: callInternalId },
    update: {
      summary: data.summary,
      leadScore: data.leadScore,
      actionItem: data.actionItem,
      demoTime: data.demoTime,
      objections: data.objections,
    },
    create: {
      callId: callInternalId,
      summary: data.summary,
      leadScore: data.leadScore,
      actionItem: data.actionItem,
      demoTime: data.demoTime,
      objections: data.objections,
      createdAt: data.createdAt ? new Date(data.createdAt) : new Date()
    }
  });
};

export const getCalls = async () => {
  return await db.call.findMany({
    orderBy: { startedAt: "desc" }
  });
};

export const getCallsByLeadId = async (leadId) => {
  return await db.call.findMany({
    where: { leadId }
  });
};
