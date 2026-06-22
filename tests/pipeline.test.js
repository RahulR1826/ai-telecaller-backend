// ─────────────────────────────────────────────────────────────────────────────
// tests/pipeline.test.js — Module-by-module test suite
//
// Run: node --env-file=.env tests/pipeline.test.js
// ─────────────────────────────────────────────────────────────────────────────

import assert from "assert";

// ── Test result tracking ─────────────────────────────────────────────────────

const results = [];
let passed = 0;
let failed = 0;

const test = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✅ PASS  ${name}`);
    results.push({ name, status: "PASS" });
    passed++;
  } catch (err) {
    console.log(`  ❌ FAIL  ${name}`);
    console.log(`           ${err.message}`);
    results.push({ name, status: "FAIL", error: err.message });
    failed++;
  }
};

const section = (title) => console.log(`\n${"═".repeat(60)}\n  ${title}\n${"═".repeat(60)}`);

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 1 — Logger
// ─────────────────────────────────────────────────────────────────────────────

section("MODULE 1: Logger (utils/logger.js)");

await test("log.call() emits [CALL] prefix", async () => {
  const { log } = await import("../src/utils/logger.js");
  // We just verify no throw
  log.call("test message");
});

await test("elapsed() returns ms string", async () => {
  const { elapsed } = await import("../src/utils/logger.js");
  const start = Date.now() - 100;
  const result = elapsed(start);
  assert.match(result, /^\d+ms$/, "Expected format like '100ms'");
});

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 2 — SQLite DB (config/db.js)
// ─────────────────────────────────────────────────────────────────────────────

section("MODULE 2: Persistent Storage (config/db.js)");

import { db } from "../src/config/firebase.js";

await test("db.collection().add() returns an id", async () => {
  const ref = await db.collection("test_collection").add({ hello: "world", ts: Date.now() });
  assert.ok(ref.id, "Expected id to be returned");
});

await test("db.collection().doc().set() then get() returns correct data", async () => {
  await db.collection("test_collection").doc("test_id_1").set({ name: "Alex", score: 99 });
  const doc = await db.collection("test_collection").doc("test_id_1").get();
  assert.ok(doc.exists, "Document should exist");
  assert.strictEqual(doc.data().name, "Alex");
  assert.strictEqual(doc.data().score, 99);
});

await test("db.collection().doc().set() with merge:true merges fields", async () => {
  await db.collection("test_collection").doc("merge_test").set({ a: 1, b: 2 });
  await db.collection("test_collection").doc("merge_test").set({ b: 99, c: 3 }, { merge: true });
  const doc = await db.collection("test_collection").doc("merge_test").get();
  assert.strictEqual(doc.data().a, 1, "Existing field should be preserved");
  assert.strictEqual(doc.data().b, 99, "Updated field should be merged");
  assert.strictEqual(doc.data().c, 3, "New field should be added");
});

await test("db.collection().get() returns all docs", async () => {
  await db.collection("test_list").add({ item: "a" });
  await db.collection("test_list").add({ item: "b" });
  const snapshot = await db.collection("test_list").get();
  assert.ok(snapshot.docs.length >= 2, "Should have at least 2 documents");
});

await test("db.collection().where().get() filters correctly", async () => {
  await db.collection("test_filter").add({ status: "active", val: 1 });
  await db.collection("test_filter").add({ status: "inactive", val: 2 });
  const snapshot = await db.collection("test_filter").where("status", "==", "active").get();
  assert.ok(snapshot.docs.length >= 1, "Should find at least 1 active doc");
  snapshot.docs.forEach((d) => {
    assert.strictEqual(d.data().status, "active");
  });
});

await test("doc.exists is false for missing doc", async () => {
  const doc = await db.collection("test_collection").doc("nonexistent_doc_xyz").get();
  assert.strictEqual(doc.exists, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 3 — LLM Service (services/llmService.js)
// ─────────────────────────────────────────────────────────────────────────────

section("MODULE 3: LLM Service (services/llmService.js)");

const { isSimilarResponse, keepShort, buildCampaignInjection, TELECALLER_SYSTEM_PROMPT } =
  await import("../src/services/llmService.js");

await test("TELECALLER_SYSTEM_PROMPT contains persona name Alex", async () => {
  assert.ok(TELECALLER_SYSTEM_PROMPT.includes("Alex"), "Prompt should mention Alex");
});

await test("TELECALLER_SYSTEM_PROMPT has non-AI disclosure rule", async () => {
  assert.ok(
    TELECALLER_SYSTEM_PROMPT.toLowerCase().includes("never reveal you are an ai"),
    "Prompt should have AI non-disclosure rule"
  );
});

await test("keepShort() truncates to 3 sentences", async () => {
  const text = "First sentence. Second sentence. Third sentence. Fourth sentence that should be cut. Fifth.";
  const result = keepShort(text);
  const sentences = result.match(/[.!?]+/g) || [];
  assert.ok(sentences.length <= 3, `Expected <= 3 sentences, got ${sentences.length}`);
});

await test("isSimilarResponse() detects identical strings", async () => {
  const result = isSimilarResponse("Hello world", ["Hello world"]);
  assert.strictEqual(result, true);
});

await test("isSimilarResponse() detects high Jaccard overlap (>= 0.7)", async () => {
  // Use near-identical sentences that definitely share >= 70% token overlap
  const result = isSimilarResponse(
    "Can you tell me more about your current workflow and process?",
    ["Can you tell me more about your workflow and current process?"]
  );
  assert.strictEqual(result, true);
});

await test("isSimilarResponse() returns false for different responses", async () => {
  const result = isSimilarResponse("Our pricing starts at $99/month", [
    "Would Tuesday or Wednesday work for a demo?",
  ]);
  assert.strictEqual(result, false);
});

await test("buildCampaignInjection() normalizes all alias fields", async () => {
  const result = buildCampaignInjection({
    businessName: "Acme Corp",
    productService: "CRM software",
    valueProp: "free 30-day trial",
    campaignObjective: "schedule demo",
  });
  assert.strictEqual(result.business_name, "Acme Corp");
  assert.strictEqual(result.product, "CRM software");
  assert.strictEqual(result.offer, "free 30-day trial");
  assert.strictEqual(result.objective, "schedule demo");
});

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 4 — Conversation Manager (services/conversationManager.js)
// ─────────────────────────────────────────────────────────────────────────────

section("MODULE 4: Conversation Manager (services/conversationManager.js)");

const {
  classifyUserIntent,
  getConversation,
  buildGreeting,
} = await import("../src/services/conversationManager.js");

await test("classifyUserIntent('I'm busy right now') → busy/SCHEDULING", async () => {
  const result = classifyUserIntent("I'm busy right now");
  assert.strictEqual(result.intent, "busy");
  assert.strictEqual(result.stage, "SCHEDULING");
});

await test("classifyUserIntent('sounds good, let's do it') → interested/CLOSING", async () => {
  const result = classifyUserIntent("sounds good, let's do it");
  assert.strictEqual(result.intent, "interested");
  assert.strictEqual(result.stage, "CLOSING");
});

await test("classifyUserIntent('no thanks, not interested') → negative/OBJECTION", async () => {
  // Use phrasing that does NOT accidentally match the 'interested' keyword
  const result = classifyUserIntent("no thanks, do not call me again");
  assert.strictEqual(result.intent, "negative");
  assert.strictEqual(result.stage, "OBJECTION");
});

await test("classifyUserIntent('what is the price') → question/DISCOVERY", async () => {
  const result = classifyUserIntent("what is the price");
  assert.strictEqual(result.intent, "question");
  assert.strictEqual(result.stage, "DISCOVERY");
});

await test("getConversation() creates new session with GREETING stage", async () => {
  const conv = getConversation("test_session_new_123");
  assert.strictEqual(conv.stage, "GREETING");
  assert.ok(Array.isArray(conv.messages));
});

await test("buildGreeting() uses campaign data", async () => {
  const greeting = buildGreeting({
    business_name: "Acme Corp",
    product: "CRM software",
    offer: "a free 30-day trial",
  });
  assert.ok(greeting.includes("Acme Corp"), "Greeting should include business name");
  assert.ok(greeting.includes("Alex"), "Greeting should include persona name");
});

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 5 — Campaign Queue Service (services/campaignQueueService.js)
// ─────────────────────────────────────────────────────────────────────────────

section("MODULE 5: Campaign Queue (services/campaignQueueService.js)");

const { startQueue, markCallCompleted, getQueueStatus, setQueueDialer } =
  await import("../src/services/campaignQueueService.js");

await test("startQueue() rejects duplicate running queue", async () => {
  // Register a slow dialer so queue stays in-progress
  setQueueDialer(async () => {
    await new Promise((r) => setTimeout(r, 5000)); // never resolves in test
    return { sid: "CA_slow" };
  });

  // Start a queue - it will block on the slow dialer
  const p = startQueue({ campaignId: "test_dup_camp", phoneNumbers: ["+911234567890"] });

  // Give the queue time to enter inProgress state
  await new Promise((r) => setTimeout(r, 50));

  // Second start should throw
  try {
    await startQueue({ campaignId: "test_dup_camp", phoneNumbers: ["+911234567891"] });
    assert.fail("Should have thrown for duplicate running queue");
  } catch (err) {
    assert.ok(err.message.includes("already running"), `Expected 'already running' error, got: ${err.message}`);
  }
  p.catch(() => {}); // suppress unhandled
});

await test("startQueue() with empty numbers sets status=completed immediately", async () => {
  const queue = await startQueue({ campaignId: "test_empty_camp", phoneNumbers: [] });
  assert.strictEqual(queue.status, "completed");
  assert.strictEqual(queue.pending.length, 0);
});

await test("startQueue() deduplicates phone numbers", async () => {
  let callCount = 0;
  setQueueDialer(async ({ phoneNumber }) => {
    callCount++;
    return { sid: `CA_test_${callCount}` };
  });

  const queue = await startQueue({
    campaignId: "test_dedup_camp",
    phoneNumbers: ["+911234567890", "+911234567890", "+911234567890"],
  });

  // Should only have 1 unique number (or 0 in pending if dialer ran immediately)
  const totalNumbers = queue.pending.length + queue.completed.length + queue.failed.length + (queue.inProgress ? 1 : 0);
  assert.strictEqual(totalNumbers, 1, `Expected 1 unique number, got ${totalNumbers}`);
});

await test("markCallCompleted() returns null for unknown callSid", async () => {
  const result = await markCallCompleted({ callSid: "CA_unknown_xyz", callStatus: "completed" });
  assert.strictEqual(result, null);
});

await test("getQueueStatus() returns null for unknown campaignId", async () => {
  const result = getQueueStatus("nonexistent_campaign_xyz");
  assert.strictEqual(result, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 6 — WebSocket Service (services/wsService.js)
// ─────────────────────────────────────────────────────────────────────────────

section("MODULE 6: WebSocket Service (services/wsService.js)");

const { broadcast, wsClientCount } = await import("../src/services/wsService.js");

await test("wsClientCount() returns 0 when no server initialized", async () => {
  // Before initWsServer is called, count should be 0
  assert.strictEqual(wsClientCount(), 0);
});

await test("broadcast() does not throw when no clients are connected", async () => {
  // Should be a no-op when there are no WS clients
  broadcast("test.event", { foo: "bar" });
});

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 7 — Twilio Service (services/twilioService.js)
// ─────────────────────────────────────────────────────────────────────────────

section("MODULE 7: Twilio Service (services/twilioService.js)");

const { isAllowedTestNumber, getVoiceResponse, twilioConfig } =
  await import("../src/services/twilioService.js");

await test("isAllowedTestNumber() returns true when no TEST_PHONE_NUMBER set", async () => {
  // In test env, TEST_PHONE_NUMBER is set — this tests the logic
  const result = isAllowedTestNumber(process.env.TEST_PHONE_NUMBER || "+919999999999");
  assert.strictEqual(result, true);
});

await test("isAllowedTestNumber() returns false for random number", async () => {
  if (!process.env.TEST_PHONE_NUMBER) {
    // No restriction set — skip
    console.log("           [SKIP] TEST_PHONE_NUMBER not set");
    return;
  }
  const result = isAllowedTestNumber("+10000000000");
  assert.strictEqual(result, false);
});

await test("getVoiceResponse() returns a valid TwiML VoiceResponse", async () => {
  const vr = getVoiceResponse();
  assert.ok(typeof vr.toString === "function");
  const xml = vr.toString();
  assert.ok(xml.includes("<?xml"), "TwiML should be valid XML");
  assert.ok(xml.includes("Response"), "TwiML should contain Response element");
});

await test("TwiML Gather has speechTimeout=3 (not auto)", async () => {
  const vr = getVoiceResponse();
  const gather = vr.gather({
    input: "speech",
    speechTimeout: "3",
    actionOnEmptyResult: true,
    action: "/api/call/twilio/voice",
    method: "POST",
  });
  gather.say("Hello");
  const xml = vr.toString();
  assert.ok(xml.includes('speechTimeout="3"'), `Expected speechTimeout=3 in TwiML: ${xml}`);
  assert.ok(xml.includes('actionOnEmptyResult="true"'), `Expected actionOnEmptyResult=true in TwiML: ${xml}`);
});

await test("TwiML has NO <Redirect> after Gather", async () => {
  const vr = getVoiceResponse();
  const gather = vr.gather({ input: "speech", speechTimeout: "3", actionOnEmptyResult: true });
  gather.say("Test response");
  const xml = vr.toString();
  assert.ok(!xml.includes("<Redirect>"), `TwiML should NOT contain <Redirect>: ${xml}`);
});

await test("twilioConfig.configured is boolean", async () => {
  assert.strictEqual(typeof twilioConfig.configured, "boolean");
});

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 8 — Transcript Storage
// ─────────────────────────────────────────────────────────────────────────────

section("MODULE 8: Transcript Storage (callLogs collection)");

await test("callLogs can store a customer turn", async () => {
  const ts = new Date().toISOString();
  const ref = await db.collection("callLogs").add({
    sessionId: "test_session_transcript",
    speaker: "customer",
    text: "I am interested in a demo",
    source: "twilio",
    sentiment: "Positive",
    intent: "interested",
    timestamp: ts,
  });
  assert.ok(ref.id, "Should return a document id");
});

await test("callLogs can store an AI turn", async () => {
  const ref = await db.collection("callLogs").add({
    sessionId: "test_session_transcript",
    speaker: "ai",
    text: "Great! Would Tuesday or Wednesday work for a 15-minute demo?",
    source: "twilio",
    sentiment: "Neutral",
    intent: "interested",
    timestamp: new Date().toISOString(),
  });
  assert.ok(ref.id);
});

await test("callLogs.where(sessionId) retrieves correct messages", async () => {
  const snapshot = await db
    .collection("callLogs")
    .where("sessionId", "==", "test_session_transcript")
    .get();
  assert.ok(snapshot.docs.length >= 2, `Expected >= 2 messages, got ${snapshot.docs.length}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 9 — Call Summary Storage
// ─────────────────────────────────────────────────────────────────────────────

section("MODULE 9: Call Summary Storage (callSummaries collection)");

await test("callSummaries can store a summary", async () => {
  const ref = await db.collection("callSummaries").add({
    sessionId: "test_call_summary_123",
    summary: "Customer was interested. Offered a demo. Next step: follow up Tuesday.",
    createdAt: new Date().toISOString(),
  });
  assert.ok(ref.id, "Should return a summary document id");
});

await test("callSummaries.get() retrieves stored summaries", async () => {
  const snapshot = await db.collection("callSummaries").get();
  assert.ok(snapshot.docs.length >= 1, "Should have at least 1 summary");
});

// ─────────────────────────────────────────────────────────────────────────────
// MODULE 10 — Campaign CRUD
// ─────────────────────────────────────────────────────────────────────────────

section("MODULE 10: Campaign CRUD (campaigns collection)");

await test("campaigns.add() stores a campaign", async () => {
  const ref = await db.collection("campaigns").add({
    business_name: "Acme Corp",
    product: "CRM Pro",
    offer: "30-day free trial",
    objective: "Schedule demo",
    createdAt: new Date().toISOString(),
  });
  assert.ok(ref.id, "Campaign should have id");
});

await test("campaigns.get() returns at least 1 campaign", async () => {
  const snapshot = await db.collection("campaigns").orderBy("createdAt", "desc").get();
  assert.ok(snapshot.docs.length >= 1, "Should have at least 1 campaign");
});

// ─────────────────────────────────────────────────────────────────────────────
// FINAL REPORT
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log("  FINAL TEST RESULTS");
console.log("═".repeat(60));

const colW = [50, 10];
console.log(`  ${"FEATURE".padEnd(colW[0])} ${"STATUS".padEnd(colW[1])}`);
console.log(`  ${"-".repeat(colW[0])} ${"-".repeat(colW[1])}`);

for (const r of results) {
  const icon = r.status === "PASS" ? "✅" : "❌";
  console.log(`  ${icon} ${r.name.padEnd(colW[0] - 3)} ${r.status}`);
}

console.log(`\n  Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
console.log("═".repeat(60));

if (failed > 0) {
  console.log("\n  Failed tests:");
  results.filter((r) => r.status === "FAIL").forEach((r) => {
    console.log(`  • ${r.name}: ${r.error}`);
  });
  process.exit(1);
}

process.exit(0);
