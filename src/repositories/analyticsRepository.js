import { db } from "../db/db.js";

export const getCallLogs = async () => {
  return await db.transcript.findMany();
};

export const getCallSessions = async () => {
  return await db.call.findMany();
};
