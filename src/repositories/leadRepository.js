import { db } from "../db/db.js";

export const getLeads = async () => {
  return await db.lead.findMany({
    include: { campaign: true },
    orderBy: { updatedAt: "desc" }
  });
};


export const getLeadById = async (id) => {
  const lead = await db.lead.findUnique({ where: { id } });
  return {
    exists: !!lead,
    data: () => lead
  };
};

export const updateLead = async (id, data) => {
  return await db.lead.upsert({
    where: { id },
    update: data,
    create: {
      id,
      ...data
    }
  });
};
