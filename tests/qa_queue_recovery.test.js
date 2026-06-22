import { startQueue, getQueueStatus } from "../src/services/campaignQueueService.js";
import assert from "assert";
import fs from "fs";

const test = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✅ PASS  ${name}`);
  } catch (err) {
    console.log(`  ❌ FAIL  ${name}`);
    console.log(`           ${err.message}`);
    process.exit(1);
  }
};

const main = async () => {
  console.log("Starting QA: Queue Recovery After Restart...\n");

  await test("Queue persistence - Recovery after restart", async () => {
    const campaignId = "recovery_test_camp_" + Date.now();
    
    // Simulate starting a queue
    await startQueue({ campaignId, phoneNumbers: ["+10000000000"] });

    // Wait a bit for async persist Queue
    await new Promise((r) => setTimeout(r, 500));

    const { db } = await import("../src/config/firebase.js");
    const snap = await db.collection("queues").doc(campaignId).get();
    
    assert.ok(snap.exists, "Queue should be persisted to DB");
    assert.strictEqual(snap.data().campaignId, campaignId);
    
    // Simulate restart
    const { hydrateQueues, getQueueStatus } = await import("../src/services/campaignQueueService.js");
    await hydrateQueues();
    
    const q1 = getQueueStatus(campaignId);
    assert.ok(q1, "Queue should be hydrated back to memory");
    assert.strictEqual(q1.status, "running", "Queue status should be running");
  });
};

main();
