import twilio from "twilio";

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  PUBLIC_BASE_URL,
  TEST_PHONE_NUMBER,
} = process.env;

const configured = Boolean(
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_PHONE_NUMBER && PUBLIC_BASE_URL
);

const client = configured
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null;

let resolvedPublicBaseUrl = null;

const isValidPublicBaseUrl = (value = "") => {
  try {
    const parsed = new URL(String(value).trim());
    return parsed.protocol === "https:" && !parsed.hostname.includes("localhost") && !parsed.hostname.startsWith("127.");
  } catch {
    return false;
  }
};

const discoverNgrokUrl = async () => {
  try {
    const response = await fetch("http://127.0.0.1:4040/api/tunnels");
    if (!response.ok) return null;
    const data = await response.json();
    const tunnels = Array.isArray(data?.tunnels) ? data.tunnels : [];
    const httpsTunnel = tunnels.find((tunnel) => String(tunnel.public_url || "").startsWith("https://"));
    return httpsTunnel?.public_url || null;
  } catch (error) {
    console.warn("[twilio] ngrok tunnel discovery failed:", error.message);
    return null;
  }
};

export const resolvePublicBaseUrl = async () => {
  if (resolvedPublicBaseUrl) return resolvedPublicBaseUrl;

  let attemptUrl = null;

  const ngrokUrl = await discoverNgrokUrl();
  if (ngrokUrl) {
    attemptUrl = ngrokUrl.replace(/\/$/, "");
    console.log(`[twilio] auto-detected ngrok public url: ${attemptUrl}`);
  } else if (isValidPublicBaseUrl(PUBLIC_BASE_URL)) {
    attemptUrl = PUBLIC_BASE_URL.replace(/\/$/, "");
  }

  if (!attemptUrl) {
    throw new Error("PUBLIC_BASE_URL is invalid and ngrok tunnel could not be discovered.");
  }

  // Validate the URL is reachable locally via ngrok/public base
  try {
    const healthCheck = await fetch(`${attemptUrl}/api/health`, { method: "GET" });
    if (!healthCheck.ok) throw new Error("Status code not OK");
  } catch (error) {
    throw new Error(`The webhook URL (${attemptUrl}) is unreachable. Please restart ngrok using 'ngrok http 5000' and update your .env file if necessary.`);
  }

  resolvedPublicBaseUrl = attemptUrl;
  return resolvedPublicBaseUrl;
};

export const getVoiceResponse = () => new twilio.twiml.VoiceResponse();

export const isAllowedTestNumber = (number = "") => {
  if (!TEST_PHONE_NUMBER) return true;
  return String(number).trim() === String(TEST_PHONE_NUMBER).trim();
};

export const startOutboundCall = async ({ to, sessionId, allowAnyNumber = false, campaignId = null }) => {
  if (!configured) {
    throw new Error("Twilio is not fully configured in environment");
  }

  if (!allowAnyNumber && !isAllowedTestNumber(to)) {
    throw new Error(`Only test number is allowed: ${TEST_PHONE_NUMBER}`);
  }

  const publicBaseUrl = await resolvePublicBaseUrl();
  const voiceWebhook = new URL("/api/call/twilio/voice", publicBaseUrl);
  if (sessionId) {
    voiceWebhook.searchParams.set("sessionId", sessionId);
  }
  if (campaignId) {
    voiceWebhook.searchParams.set("campaignId", campaignId);
  }

  const statusWebhook = new URL("/api/call/twilio/status", publicBaseUrl);
  if (campaignId) {
    statusWebhook.searchParams.set("campaignId", campaignId);
  }

  let formattedTo = String(to).trim();
  if (!formattedTo.startsWith("+")) {
    formattedTo = "+" + formattedTo;
  }

  const call = await client.calls.create({
    to: formattedTo,
    from: TWILIO_PHONE_NUMBER,
    url: voiceWebhook.toString(),
    method: "POST",
    statusCallback: statusWebhook.toString(),
    statusCallbackMethod: "POST",
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
  });

  return call;
};

export const fetchCallBySid = async (callSid) => {
  if (!configured || !client) {
    throw new Error("Twilio client is not configured");
  }

  return client.calls(callSid).fetch();
};

export const twilioConfig = {
  configured,
  testPhoneNumber: TEST_PHONE_NUMBER || null,
};
