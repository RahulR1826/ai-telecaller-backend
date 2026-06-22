import { db } from "../db/db.js";

// In-memory store as fallback
const callbackStore = [];

/**
 * Save a callback/reschedule event.
 * Creates/updates Lead and FollowUp in DB so Calendar and Leads pages show the data.
 */
export const addCallbackRecord = async ({ callSid, to, actionItem, demoTime, summary, leadScore, campaignId, campaignName: providedCampaignName }) => {
  const record = {
    callSid,
    phone: to,
    actionItem,
    demoTime,
    summary,
    leadScore,
    campaignId,
    createdAt: new Date().toISOString(),
    status: "pending"
  };

  callbackStore.push(record);

  // Resolve campaign name
  let campaignName = providedCampaignName || "Unknown Campaign";
  try {
    if (campaignId) {
      const campaign = await db.campaign.findUnique({ where: { id: campaignId } });
      if (campaign) campaignName = campaign.name;
    } else if (callSid) {
      // Try to find campaign from call record
      const call = await db.call.findUnique({ where: { callSid } });
      if (call?.campaignId) {
        const campaign = await db.campaign.findUnique({ where: { id: call.campaignId } });
        if (campaign) campaignName = campaign.name;
        if (call.campaignId) record.campaignId = call.campaignId;
      }
    }
  } catch (_) {}

  // Upsert Lead by phone
  try {
    if (to) {
      const leadStatus = actionItem === "demo_booked" ? "booked" : "callback";
      const lead = await db.lead.upsert({
        where: { phone: to },
        update: {
          status: leadStatus,
          leadScore: leadScore || 0,
          callbackTime: demoTime || null,        // stored as plain string e.g. "Wednesday at 5:00 PM"
          nextAction: `${actionItem} - ${campaignName}`,
          notes: summary || null,
          campaignId: record.campaignId || null,
        },
        create: {
          phone: to,
          name: to,
          status: leadStatus,
          leadScore: leadScore || 0,
          callbackTime: demoTime || null,
          nextAction: `${actionItem} - ${campaignName}`,
          notes: summary || null,
          campaignId: record.campaignId || null,
        }
      });

      // Safely parse demoTime into a real Date for scheduledAt (may be natural language)
      let scheduledAt = null;
      if (demoTime) {
        const parsed = parseFuzzyDate(demoTime);
        if (parsed) scheduledAt = parsed;
      }

      // Create FollowUp entry for Calendar
      await db.followUp.create({
        data: {
          leadId: lead.id,
          type: actionItem === "demo_booked" ? "Demo" : "Callback",
          message: `Campaign: ${campaignName} | ${actionItem === "demo_booked" ? "Demo" : "Callback"} at ${demoTime || "TBD"} | ${summary || ""}`,
          status: "pending",
          scheduledAt: scheduledAt,
        }
      }).catch(err => {
        console.warn("[callbackRepo] FollowUp create failed (non-fatal):", err.message);
      });
    }
  } catch (err) {
    console.warn("[callbackRepo] DB save failed (non-fatal):", err.message);
  }

  return record;
};

/**
 * Parse a fuzzy date string like "Wednesday at 5:00 PM" or "Tuesday morning"
 * into the next upcoming occurrence of that day/time.
 */
function parseFuzzyDate(text) {
  const days = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
  const lower = (text || "").toLowerCase();

  // Try native parse first (works for ISO strings)
  const native = new Date(text);
  if (!isNaN(native.getTime()) && native.getFullYear() > 2000) return native;

  const dayMatch = lower.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (!dayMatch) return null;

  const targetDay = days.indexOf(dayMatch[1]);
  const now = new Date();
  const result = new Date(now);
  let daysAhead = targetDay - now.getDay();
  if (daysAhead <= 0) daysAhead += 7; // next occurrence
  result.setDate(now.getDate() + daysAhead);

  // Try to extract hour
  const timeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)/);
  if (timeMatch) {
    let hour = parseInt(timeMatch[1]);
    const isPm = timeMatch[3].startsWith("p");
    if (isPm && hour < 12) hour += 12;
    if (!isPm && hour === 12) hour = 0;
    result.setHours(hour, parseInt(timeMatch[2] || "0"), 0, 0);
  } else if (lower.includes("morning")) {
    result.setHours(9, 0, 0, 0);
  } else if (lower.includes("afternoon")) {
    result.setHours(14, 0, 0, 0);
  } else if (lower.includes("evening")) {
    result.setHours(18, 0, 0, 0);
  }

  return result;
}

export const getCampaignCallbacks = async () => {
  try {
    return await db.followUp.findMany({
      include: { lead: true },
      orderBy: { createdAt: "desc" }
    });
  } catch {
    return callbackStore;
  }
};

export const getAllCallbacks = () => callbackStore;
