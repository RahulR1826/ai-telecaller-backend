import http from "http";
import axios from "axios";
import { WebSocket } from "ws";
import assert from "assert";

// Mock env variables for the test before importing anything else
process.env.PORT = "5001";
process.env.USE_FIRESTORE = "false";
// Override Twilio config to ensure it doesn't actually dial real numbers
// and to avoid ngrok requirement during local test
process.env.PUBLIC_BASE_URL = "http://localhost:5001";

import app from "../src/app.js";
import { initWsServer } from "../src/services/wsService.js";
import { db } from "../src/config/firebase.js";
import { twilioConfig } from "../src/services/twilioService.js";

// Force twilio not to make real calls during test
twilioConfig.configured = false; 

const port = 5001;
const baseUrl = `http://localhost:${port}`;
const wsUrl = `ws://localhost:${port}/ws`;

const results = [];
let passed = 0;
let failed = 0;

const logResult = (name, status, error = null) => {
  const result = { name, status, error };
  results.push(result);
  if (status === "PASS") {
    passed++;
    console.log(`  ✅ PASS  ${name}`);
  } else {
    failed++;
    console.log(`  ❌ FAIL  ${name}`);
    console.log(`           ${error}`);
  }
};

const runTest = async (name, fn) => {
  try {
    const res = await fn();
    logResult(name, "PASS");
    return res;
  } catch (err) {
    logResult(name, "FAIL", err.message);
  }
};

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const main = async () => {
  console.log("Starting Runtime Verification Tests...\n");

  const server = http.createServer(app);
  initWsServer(server);

  await new Promise((resolve) => server.listen(port, resolve));
  console.log(`Test server running on port ${port}\n`);

  // We will collect ws events
  const wsEvents = [];
  let wsConnected = false;

  const ws = new WebSocket(wsUrl);
  ws.on("open", () => {
    wsConnected = true;
  });
  ws.on("message", (data) => {
    try {
      const parsed = JSON.parse(data);
      wsEvents.push(parsed);
    } catch(e) {}
  });

  // Wait for WS to connect
  for (let i = 0; i < 20; i++) {
    if (wsConnected) break;
    await wait(100);
  }

  // 1. Persistent storage test
  await runTest("1. Persistent storage test", async () => {
    const docId = `test_doc_${Date.now()}`;
    await db.collection("test_runtime").doc(docId).set({ foo: "bar" });
    const doc = await db.collection("test_runtime").doc(docId).get();
    assert.strictEqual(doc.exists, true, "Document should exist");
    assert.strictEqual(doc.data().foo, "bar", "Document data should match");
  });

  // 2. Campaign execution & Queue test with 3 numbers
  let campaignId;
  await runTest("6. Campaign execution test (Create)", async () => {
    const res = await axios.post(`${baseUrl}/api/campaign`, {
      businessName: "Runtime Corp",
      product: "Test Suite",
      offer: "Free runtime check",
      objective: "Verify stability"
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.data.id);
    campaignId = res.data.id;
  });

  await runTest("2. Queue test with 3 numbers", async () => {
    // Start queue
    const res = await axios.post(`${baseUrl}/api/campaign/start`, {
      campaignId,
      phoneNumbers: ["+918000000001", "+918000000002", "+918000000003"]
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.acceptedNumbers.length, 3);
    
    // Wait for queue to process. Since twilioConfig.configured = false, dialer will fail instantly.
    // It will retry 2 times for each number, so 3 retries each = 9 dial attempts.
    // Wait for the queue to finish.
    let statusRes;
    for (let i = 0; i < 40; i++) {
      statusRes = await axios.get(`${baseUrl}/api/campaign/${campaignId}/queue`);
      if (statusRes.data.status === "completed") break;
      await wait(500);
    }
    
    assert.strictEqual(statusRes.data.status, "completed", "Queue should complete");
    assert.strictEqual(statusRes.data.failed.length, 3, "All 3 numbers should fail because twilio is disabled in test");
  });

  // 7. Real conversation test
  const callSid = `test_call_${Date.now()}`;
  await runTest("7. Real conversation test", async () => {
    // Simulate webhook - Initial Call (no speech result)
    let res = await axios.post(`${baseUrl}/api/call/twilio/voice`, {
      CallSid: callSid,
      Direction: "outbound-api",
      From: "+10000000000",
      To: "+10000000001",
      CampaignId: campaignId
    });
    
    assert.strictEqual(res.status, 200);
    assert.ok(res.data.includes("<Gather"), "TwiML should contain Gather");
    assert.ok(res.data.includes("<Say"), "TwiML should contain Say");
    
    // Simulate webhook - Customer speaks
    res = await axios.post(`${baseUrl}/api/call/twilio/voice`, {
      CallSid: callSid,
      Direction: "outbound-api",
      From: "+10000000000",
      To: "+10000000001",
      CampaignId: campaignId,
      SpeechResult: "What is the price of this service?"
    });

    assert.strictEqual(res.status, 200);
    assert.ok(res.data.includes("<Gather"), "TwiML should contain Gather after reply");
  });

  // 3. Transcript retrieval test
  await runTest("3. Transcript retrieval test", async () => {
    const res = await axios.get(`${baseUrl}/api/call/${callSid}/transcript`);
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.data.messages));
    assert.ok(res.data.messages.length >= 2, "Transcript should contain customer and AI messages");
  });

  // 5. Call summary test
  await runTest("5. Call summary test", async () => {
    // Send status callback for completion
    const res = await axios.post(`${baseUrl}/api/call/twilio/status`, {
      CallSid: callSid,
      CallStatus: "completed",
      CallDuration: "15"
    });
    assert.strictEqual(res.status, 200);

    // Wait for summary to be generated (takes a few seconds)
    let summaryFound = false;
    for (let i = 0; i < 20; i++) {
      const summaries = await db.collection("callSummaries").where("sessionId", "==", callSid).get();
      if (summaries.docs.length > 0) {
        summaryFound = true;
        break;
      }
      await wait(1000);
    }
    assert.ok(summaryFound, "Call summary should be generated and stored");
  });

  // 4. WebSocket event test
  await runTest("4. WebSocket event test", async () => {
    // Verify that wsEvents captured the events during the conversation
    const eventNames = wsEvents.map(e => e.event);
    assert.ok(eventNames.includes("connected"), "Should have connected event");
    assert.ok(eventNames.includes("call.started"), "Should have call.started event");
    assert.ok(eventNames.includes("conversation.message"), "Should have conversation.message event");
    assert.ok(eventNames.includes("call.ended"), "Should have call.ended event");
    assert.ok(eventNames.includes("call.summary"), "Should have call.summary event");
  });

  // Generate Report
  ws.close();
  server.close();
  
  console.log(`\n${"═".repeat(60)}`);
  console.log("  RUNTIME VERIFICATION RESULTS");
  console.log("═".repeat(60));

  const colW = [50, 10];
  console.log(`  ${"TEST NAME".padEnd(colW[0])} ${"STATUS".padEnd(colW[1])}`);
  console.log(`  ${"-".repeat(colW[0])} ${"-".repeat(colW[1])}`);

  for (const r of results) {
    const icon = r.status === "PASS" ? "✅" : "❌";
    console.log(`  ${icon} ${r.name.padEnd(colW[0] - 3)} ${r.status}`);
  }

  console.log(`\n  Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
  console.log("═".repeat(60));
  
  if (failed > 0) process.exit(1);
  process.exit(0);
};

main().catch(console.error);
