// ─────────────────────────────────────────────────────────────────────────────
// services/campaignQueueService.js — Single-call queue with retry + dedup
//
// Design rules:
//  1. Only ONE call may be in-progress at a time per campaign.
//  2. Per-number retry counter (max MAX_RETRIES before marking failed).
//  3. No polling interval — relies solely on Twilio status webhook.
//  4. Duplicate queue-start guard: if a queue is already running, reject.
//  5. handledCallSids has a TTL cleanup (auto-purged after 10 min).
// ─────────────────────────────────────────────────────────────────────────────

import { log } from "../utils/logger.js";
import { updateQueue, getAllQueues, updateCampaignStatus } from "../repositories/campaignRepository.js";

const MAX_RETRIES = 2;

/** @type {Map<string, QueueState>} — campaignId → queue */
const queues = new Map();

/** callSid → campaignId */
const callToCampaign = new Map();

/** Set of callSids already processed (prevents double-advance) */
const handledCallSids = new Map(); // callSid → expiry timestamp

/** Registered dialer function injected from campaignController */
let dialer = null;

// ── TTL cleanup for handledCallSids ─────────────────────────────────────────
const HANDLED_TTL_MS = 10 * 60 * 1000; // 10 minutes

const isHandled = (callSid) => {
  const expiry = handledCallSids.get(callSid);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    handledCallSids.delete(callSid);
    return false;
  }
  return true;
};

const markHandled = (callSid) => {
  handledCallSids.set(callSid, Date.now() + HANDLED_TTL_MS);
};

// Periodic cleanup of expired handled sids (every 5 min)
setInterval(() => {
  const now = Date.now();
  for (const [sid, expiry] of handledCallSids.entries()) {
    if (now > expiry) handledCallSids.delete(sid);
  }
}, 5 * 60 * 1000);

// ── Dialer injection ─────────────────────────────────────────────────────────

/**
 * Register the function that actually dials a number.
 * @param {(args: {campaignId:string, phoneNumber:string}) => Promise<{sid:string}>} fn
 */
export const setQueueDialer = (fn) => {
  dialer = fn;
};

// ── Core queue logic ─────────────────────────────────────────────────────────

const getQueue = (campaignId) => queues.get(campaignId);

const persistQueue = async (campaignId) => {
  const q = queues.get(campaignId);
  if (q) {
    await updateQueue(campaignId, q).catch(err => log.warn("persistQueue error:", err.message));
  }
};

export const hydrateQueues = async () => {
  try {
    const docs = await getAllQueues();
    docs.forEach(d => {
      if (d && d.status === "running") {
        d.inProgress = false; // Reset lock on restart
        queues.set(d.id, d);
      }
    });
    log.queue(`Hydrated ${queues.size} active queues from DB`);
  } catch (err) {
    log.error("hydrateQueues error:", err.message);
  }
};

// Auto-hydrate on import (will run in background)
hydrateQueues();

/**
 * Fire the next call in the queue (if not already in-progress).
 */
const runNext = async (campaignId) => {
  const queue = getQueue(campaignId);
  if (!queue) return;

  if (queue.status === "paused") {
    log.queue(`[${campaignId}] Queue is paused — skipping runNext`);
    return;
  }

  if (queue.inProgress) {
    log.queue(`[${campaignId}] Already has a call in progress — skipping runNext`);
    return;
  }

  const next = queue.pending.shift();

  if (next === undefined) {
    queue.status = "idle";
    queue.updatedAt = new Date().toISOString();
    log.queue(`[${campaignId}] All numbers processed — queue idle`);
    await persistQueue(campaignId);
    await updateCampaignStatus(campaignId, "Idle");
    return;
  }

  if (!dialer) {
    queue.failed.push({ phoneNumber: next, reason: "Dialer unavailable" });
    queue.status = "failed";
    log.error(`[${campaignId}] No dialer registered — cannot call ${next}`);
    return;
  }

  queue.inProgress = true;
  queue.currentPhoneNumber = typeof next === "object" ? next.phone : next;
  queue.status = "running";
  queue.updatedAt = new Date().toISOString();
  await persistQueue(campaignId);

  const phoneStr = typeof next === "object" ? next.phone : next;
  log.queue(`[${campaignId}] Dialing ${phoneStr} (retry ${queue.retryCount[phoneStr] || 0}/${MAX_RETRIES})`);

  try {
    const entry = typeof next === "object" ? next : { phone: next, name: null };
    const call = await dialer({ campaignId, phoneNumber: entry.phone, customerName: entry.name });
    queue.activeCallSid = call.sid;
    callToCampaign.set(call.sid, campaignId);
    log.queue(`[${campaignId}] Call SID=${call.sid} created for ${entry.phone} (name: ${entry.name || "unknown"})`);
  } catch (error) {
    const entry = typeof next === "object" ? next : { phone: next, name: null };
    log.warn(`[${campaignId}] dialer failed for ${entry.phone}: ${error.message}`);
    queue.retryCount[entry.phone] = (queue.retryCount[entry.phone] || 0) + 1;

    if (queue.retryCount[entry.phone] < MAX_RETRIES) {
      log.queue(`[${campaignId}] Re-queuing ${entry.phone} (attempt ${queue.retryCount[entry.phone]})`);
      queue.pending.unshift(next);
    } else {
      log.queue(`[${campaignId}] Max retries reached for ${entry.phone} — marking failed`);
      queue.failed.push({ phoneNumber: entry.phone, reason: error.message, retries: queue.retryCount[entry.phone] });
    }

    queue.inProgress = false;
    queue.currentPhoneNumber = null;
    queue.activeCallSid = null;
    queue.updatedAt = new Date().toISOString();
    await persistQueue(campaignId);

    // Brief delay before next number to avoid hammering Twilio on repeated errors
    setTimeout(() => runNext(campaignId), 2000);
  }
};

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Start a campaign queue.  Rejects if a queue is already running for campaignId.
 */
export const uploadToQueue = async ({ campaignId, phoneNumbers = [] }) => {
  const existing = getQueue(campaignId);
  
  // Accept either plain strings or {phone, name} objects
  const entries = phoneNumbers.map(n => {
    if (typeof n === "object" && n.phone) return { phone: String(n.phone).trim(), name: n.name || null };
    return { phone: String(n || "").trim(), name: null };
  }).filter(e => Boolean(e.phone));

  // Deduplicate by phone
  const seen = new Set();
  const cleaned = entries.filter(e => { if (seen.has(e.phone)) return false; seen.add(e.phone); return true; });

  const queue = {
    campaignId,
    status: existing ? existing.status : "idle", // Do not auto-start
    pending: existing && existing.pending ? [...existing.pending, ...cleaned] : [...cleaned],
    completed: existing && existing.completed ? [...existing.completed] : [],
    failed: existing && existing.failed ? [...existing.failed] : [],
    retryCount: existing && existing.retryCount ? { ...existing.retryCount } : {},
    inProgress: existing ? existing.inProgress : false,
    currentPhoneNumber: existing ? existing.currentPhoneNumber : null,
    activeCallSid: existing ? existing.activeCallSid : null,
    startedAt: existing ? existing.startedAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  queues.set(campaignId, queue);
  await persistQueue(campaignId);
  log.queue(`[${campaignId}] Uploaded ${cleaned.length} contacts to queue`);
  return queue;
};

export const startQueue = async (campaignId) => {
  const existing = getQueue(campaignId);
  if (existing && existing.inProgress) {
    throw new Error(`Queue for campaign ${campaignId} is already running`);
  }
  
  if (!existing || existing.pending.length === 0) {
    throw new Error(`Queue for campaign ${campaignId} has no pending numbers`);
  }

  existing.status = "running";
  existing.updatedAt = new Date().toISOString();
  queues.set(campaignId, existing);
  await persistQueue(campaignId);
  await updateCampaignStatus(campaignId, "Active");
  log.queue(`[${campaignId}] Queue started`);

  await runNext(campaignId);
  return existing;
};

/**
 * Called by the Twilio status webhook when a call reaches a terminal state.
 * Marks the call complete and advances the queue.
 */
export const markCallCompleted = async ({ callSid, callStatus }) => {
  if (!callSid) return null;
  if (isHandled(callSid)) {
    log.queue(`[markCallCompleted] SID=${callSid} already handled — ignoring`);
    return null;
  }

  const campaignId = callToCampaign.get(callSid);
  if (!campaignId) {
    log.queue(`[markCallCompleted] No campaign found for SID=${callSid}`);
    return null;
  }

  const queue = getQueue(campaignId);
  if (!queue) return null;

  // Guard: make sure this SID is actually the active one
  if (queue.activeCallSid && queue.activeCallSid !== callSid) {
    log.warn(`[markCallCompleted] SID mismatch: active=${queue.activeCallSid} received=${callSid}`);
    return queue;
  }

  const phoneNumber = queue.currentPhoneNumber;

  if (callStatus === "completed") {
    if (phoneNumber) queue.completed.push({ phoneNumber, callSid });
  } else {
    // Non-completed terminal status (busy, failed, no-answer, canceled)
    if (phoneNumber) {
      queue.retryCount[phoneNumber] = (queue.retryCount[phoneNumber] || 0) + 1;
      if (queue.retryCount[phoneNumber] < MAX_RETRIES) {
        log.queue(`[${campaignId}] Re-queuing ${phoneNumber} after ${callStatus}`);
        queue.pending.unshift(phoneNumber);
      } else {
        log.queue(`[${campaignId}] Max retries for ${phoneNumber} — failed (${callStatus})`);
        queue.failed.push({ phoneNumber, callSid, reason: callStatus, retries: queue.retryCount[phoneNumber] });
      }
    }
  }

  queue.inProgress = false;
  queue.currentPhoneNumber = null;
  queue.activeCallSid = null;
  queue.updatedAt = new Date().toISOString();
  await persistQueue(campaignId);

  markHandled(callSid);
  callToCampaign.delete(callSid);

  log.queue(`[${campaignId}] Call ${callSid} → ${callStatus} — advancing queue`);
  await runNext(campaignId);
  return queue;
};

/**
 * Get current queue state for a campaign.
 */
export const getQueueStatus = (campaignId) => queues.get(campaignId) || null;

/**
 * Pause a running queue (prevents runNext from firing new calls).
 * Existing in-progress call completes normally.
 */
export const pauseQueue = async (campaignId) => {
  const queue = getQueue(campaignId);
  if (queue) {
    queue.status = "paused";
    queue.updatedAt = new Date().toISOString();
    await persistQueue(campaignId);
    await updateCampaignStatus(campaignId, "Paused");
  }
  return queue;
};

export const resumeQueue = async (campaignId) => {
  const queue = getQueue(campaignId);
  if (queue && queue.status === "paused") {
    queue.status = "running";
    queue.updatedAt = new Date().toISOString();
    await persistQueue(campaignId);
    await updateCampaignStatus(campaignId, "Active");
    if (!queue.inProgress) {
      await runNext(campaignId);
    }
  }
  return queue;
};

export const stopQueue = async (campaignId) => {
  const queue = getQueue(campaignId);
  if (queue) {
    queue.status = "completed";
    queue.pending = []; // clear remaining queue
    queue.updatedAt = new Date().toISOString();
    await persistQueue(campaignId);
    await updateCampaignStatus(campaignId, "Completed");
  }
  return queue;
};
