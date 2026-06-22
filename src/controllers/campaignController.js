// ─────────────────────────────────────────────────────────────────────────────
// controllers/campaignController.js
//
// Key fixes applied (vs audit report):
//  1. Removed setInterval polling — queue advances ONLY via status webhook
//  2. setQueueDialer called once at module load (not per-request)
//  3. Duplicate queue-start guard delegated to campaignQueueService
//  4. Structured [QUEUE] logging
// ─────────────────────────────────────────────────────────────────────────────

import { addCampaign, getCampaigns as fetchCampaigns, updateCampaign, deleteCampaign } from "../repositories/campaignRepository.js";
import { updateCallSession } from "../repositories/callRepository.js";
import { startOutboundCall } from "../services/twilioService.js";
import {
  getQueueStatus,
  setQueueDialer,
  uploadToQueue,
  startQueue,
  pauseQueue,
  resumeQueue,
  stopQueue,
} from "../queue/campaignQueue.js";
import { log } from "../utils/logger.js";

// ── Phone number normalizer ──────────────────────────────────────────────────

const normalizePhoneNumber = (input) => {
  const digitsOnly = String(input || "").replace(/\D/g, "");
  if (!digitsOnly) return null;
  if (digitsOnly.length === 10) return `+91${digitsOnly}`;
  if (digitsOnly.length === 12 && digitsOnly.startsWith("91")) return `+${digitsOnly}`;
  if (digitsOnly.length >= 10 && digitsOnly.length <= 15) return `+${digitsOnly}`;
  return null;
};

// ── Register campaign dialer (NO polling interval) ───────────────────────────
// The queue is purely event-driven: Twilio status webhook → markCallCompleted → runNext

setQueueDialer(async ({ campaignId, phoneNumber, customerName }) => {
  log.queue(`[dialer] Calling ${phoneNumber} (${customerName || "unknown"}) for campaign=${campaignId}`);

  const call = await startOutboundCall({
    to: phoneNumber,
    sessionId: `cmp_${campaignId}_${Date.now()}`,
    allowAnyNumber: true,
    campaignId,
  });

  await updateCallSession(call.sid, {
    callSid: call.sid,
    campaignId,
    to: phoneNumber,
    status: call.status || "initiated",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    durationSec: 0,
    campaignContext: { customerName: customerName || null },
  });

  // Pre-create Lead with customer name (silent fail)
  try {
    const { db } = await import("../db/db.js");
    await db.lead.upsert({
      where: { phone: phoneNumber },
      update: { name: customerName || phoneNumber, campaignId },
      create: { phone: phoneNumber, name: customerName || phoneNumber, campaignId, status: "new" },
    });
  } catch (_) {}

  log.queue(`[dialer] Call SID=${call.sid} initiated for ${phoneNumber}`);
  return call;
});


// ── CRUD controllers ─────────────────────────────────────────────────────────

export const createCampaign = async (req, res) => {
  try {
    const data = {
      name: req.body?.name || "Untitled Campaign",
      businessName: req.body?.business_name || req.body?.businessName || req.body?.companyName || "your company",
      product: req.body?.product || req.body?.productService || "your product",
      offer: req.body?.offer || req.body?.valueProp || req.body?.value_proposition || "a quick opportunity",
      objective: req.body?.objective || req.body?.campaignObjective || req.body?.goal || "understand if it could help",
      adminName: req.body?.admin_name || req.body?.adminName || "Organization Admin",
      createdAt: new Date().toISOString(),
    };

    const ref = await addCampaign(data);
    log.queue(`Campaign created id=${ref.id}`);
    res.json({ message: "Campaign created", id: ref.id });
  } catch (err) {
    log.error("createCampaign:", err.message);
    res.status(500).json({ error: err.message });
  }
};

export const getCampaigns = async (req, res) => {
  try {
    const campaigns = await fetchCampaigns();
    res.json(campaigns);
  } catch (err) {
    log.error("getCampaigns:", err.message);
    res.status(500).json({ error: err.message });
  }
};

export const editCampaign = async (req, res) => {
  try {
    const { id } = req.params;
    const data = {
      name: req.body?.name,
      businessName: req.body?.business_name || req.body?.businessName,
      product: req.body?.product,
      offer: req.body?.offer,
      objective: req.body?.objective,
      adminName: req.body?.admin_name || req.body?.adminName,
    };
    // Remove undefined fields
    Object.keys(data).forEach(k => data[k] === undefined && delete data[k]);
    const updated = await updateCampaign(id, data);
    log.queue(`Campaign updated id=${id}`);
    res.json({ message: "Campaign updated", campaign: updated });
  } catch (err) {
    log.error("editCampaign:", err.message);
    res.status(500).json({ error: err.message });
  }
};

export const removeCampaign = async (req, res) => {
  try {
    const { id } = req.params;
    await deleteCampaign(id);
    log.queue(`Campaign deleted id=${id}`);
    res.json({ message: "Campaign deleted" });
  } catch (err) {
    log.error("removeCampaign:", err.message);
    res.status(500).json({ error: err.message });
  }
};

export const uploadCampaignContacts = async (req, res) => {
  try {
    const campaignId = req.params.id;
    const rawNumbers = Array.isArray(req.body?.phoneNumbers) ? req.body.phoneNumbers : [];

    if (!campaignId) {
      return res.status(400).json({ error: "campaignId is required" });
    }

    // Accept both plain strings and {phone, name} objects
    const contacts = rawNumbers.map(entry => {
      if (typeof entry === "object" && entry !== null) {
        const phone = normalizePhoneNumber(entry.phone);
        return phone ? { phone, name: entry.name || null } : null;
      }
      const phone = normalizePhoneNumber(entry);
      return phone ? { phone, name: null } : null;
    }).filter(Boolean);

    // Deduplicate by phone
    const seen = new Set();
    const uniqueContacts = contacts.filter(c => {
      if (seen.has(c.phone)) return false;
      seen.add(c.phone);
      return true;
    });

    if (uniqueContacts.length === 0) {
      return res.status(400).json({ error: "At least one valid phoneNumber is required" });
    }

    log.queue(`Uploading contacts for campaign=${campaignId} with ${uniqueContacts.length} contacts`);

    const queue = await uploadToQueue({ campaignId, phoneNumbers: uniqueContacts });

    res.json({
      message: "Contacts uploaded successfully",
      campaignId,
      acceptedNumbers: uniqueContacts.map(c => c.phone),
      contacts: uniqueContacts,
      queue,
    });
  } catch (err) {
    log.error("uploadCampaignContacts:", err.message);
    res.status(500).json({ error: err.message });
  }
};

export const startCampaignQueue = async (req, res) => {
  try {
    const campaignId = req.params.id;

    if (!campaignId) {
      return res.status(400).json({ error: "campaignId is required" });
    }

    log.queue(`Starting queue for campaign=${campaignId}`);
    const queue = await startQueue(campaignId);

    res.json({
      message: "Campaign queue started",
      campaignId,
      queue,
    });
  } catch (err) {
    log.error("startCampaignQueue:", err.message);
    // If queue already running, return 409
    if (err.message.includes("already running")) {
      return res.status(409).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
};

export const getCampaignQueueStatus = async (req, res) => {
  try {
    const campaignId = req.params.id;
    const queue = getQueueStatus(campaignId);

    if (!queue) {
      return res.status(404).json({ error: "Queue not found for campaignId: " + campaignId });
    }

    res.json(queue);
  } catch (err) {
    log.error("getCampaignQueueStatus:", err.message);
    res.status(500).json({ error: err.message });
  }
};

export const pauseCampaignQueue = async (req, res) => {
  try {
    const campaignId = req.params.id;
    const queue = await pauseQueue(campaignId);
    if (!queue) return res.status(404).json({ error: "Queue not found" });
    res.json({ message: "Queue paused", campaignId, status: queue.status });
  } catch (err) {
    log.error("pauseCampaignQueue:", err.message);
    res.status(500).json({ error: err.message });
  }
};

export const resumeCampaignQueue = async (req, res) => {
  try {
    const campaignId = req.params.id;
    const queue = await resumeQueue(campaignId);
    if (!queue) return res.status(404).json({ error: "Queue not found" });
    res.json({ message: "Queue resumed", campaignId, status: queue.status });
  } catch (err) {
    log.error("resumeCampaignQueue:", err.message);
    res.status(500).json({ error: err.message });
  }
};

export const stopCampaignQueue = async (req, res) => {
  try {
    const campaignId = req.params.id;
    const queue = await stopQueue(campaignId);
    if (!queue) return res.status(404).json({ error: "Queue not found" });
    res.json({ message: "Queue stopped", campaignId, status: queue.status });
  } catch (err) {
    log.error("stopCampaignQueue:", err.message);
    res.status(500).json({ error: err.message });
  }
};
