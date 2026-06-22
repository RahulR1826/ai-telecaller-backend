import { getSession, updateSession } from "../repositories/sessionRepository.js";

export const getMemory = async (sessionId) => {
  const doc = await getSession(sessionId);
  return doc.exists ? doc.data().history : [];
};

export const updateMemory = async (sessionId, history) => {
  await updateSession(sessionId, { history });
};
