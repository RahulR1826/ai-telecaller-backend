import { db } from "../db/db.js";

export const addCampaign = async (data) => {
  return await db.campaign.create({ data });
};

export const getCampaigns = async () => {
  const campaigns = await db.campaign.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      contacts: { select: { status: true } },
      queueState: true,
    },
  });

  return campaigns.map(c => {
    // Derive effective status from QueueState (source of truth for running state)
    let effectiveStatus = c.status || "draft";
    let uploaded = 0;
    let completedCount = 0;

    if (c.queueState) {
      const qs = c.queueState.status;
      if (qs === "running") effectiveStatus = "Active";
      else if (qs === "paused") effectiveStatus = "Paused";
      else if (qs === "completed") effectiveStatus = "Completed";
      else if (qs === "idle") effectiveStatus = "Idle";

      // Calculate progress from JSON arrays
      try {
        const pendingArr = Array.isArray(c.queueState.pending) ? c.queueState.pending : [];
        const completedArr = Array.isArray(c.queueState.completed) ? c.queueState.completed : [];
        const failedArr = Array.isArray(c.queueState.failed) ? c.queueState.failed : [];
        
        completedCount = completedArr.length + failedArr.length;
        uploaded = pendingArr.length + completedCount;
      } catch (e) {
        // Fallback if JSON parsing fails
      }
    }

    return {
      ...c,
      status: effectiveStatus,
      queueUploaded: uploaded,
      queueCompleted: completedCount
    };
  });
};

export const getCampaignById = async (id) => {
  const campaign = await db.campaign.findUnique({ where: { id } });
  return {
    exists: !!campaign,
    data: () => campaign
  };
};

export const updateCampaign = async (id, data) => {
  return await db.campaign.update({ where: { id }, data });
};

export const updateCampaignStatus = async (id, status) => {
  return await db.campaign.update({ where: { id }, data: { status } }).catch(() => {});
};

export const deleteCampaign = async (id) => {
  // Delete related queue state first (FK constraint)
  await db.queueState.deleteMany({ where: { campaignId: id } }).catch(() => {});
  return await db.campaign.delete({ where: { id } });
};

export const updateQueue = async (campaignId, queueData) => {
  const { campaignId: _cid, startedAt, ...updateFields } = queueData;
  const safeUpdate = {
    status: updateFields.status ?? "running",
    pending: updateFields.pending ?? [],
    completed: updateFields.completed ?? [],
    failed: updateFields.failed ?? [],
    retryCount: updateFields.retryCount ?? {},
    inProgress: updateFields.inProgress ?? false,
    currentPhoneNumber: updateFields.currentPhoneNumber ?? null,
    activeCallSid: updateFields.activeCallSid ?? null,
  };
  return await db.queueState.upsert({
    where: { campaignId },
    update: safeUpdate,
    create: {
      campaignId,
      ...safeUpdate,
      startedAt: queueData.startedAt ? new Date(queueData.startedAt) : new Date(),
    }
  });
};

export const getAllQueues = async () => {
  return await db.queueState.findMany();
};

