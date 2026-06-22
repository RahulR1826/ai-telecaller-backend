import { generateSummaryResponse } from "../src/services/llmService.js";
import assert from "assert";

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
  console.log("Starting QA: JSON Summary Generation...\n");

  await test("generateSummaryResponse extracts JSON successfully", async () => {
    const messages = [
      { role: "user", content: "What is the price of this service?" },
      { role: "assistant", content: "It depends on your scale. What volume are you handling right now?" },
      { role: "user", content: "About 500 calls a day. I'm interested. Call me back tomorrow at 2 PM to schedule a demo." },
      { role: "assistant", content: "Perfect, I've got you locked in for tomorrow at 2 PM." }
    ];

    const result = await generateSummaryResponse({ messages });
    
    assert.ok(result.summary, "Should have summary field");
    assert.strictEqual(typeof result.leadScore, "number", "Should have numeric leadScore");
    assert.ok(["demo_booked", "callback_requested", "not_interested", "follow_up_needed"].includes(result.actionItem), "Should have valid actionItem");
    assert.ok(result.demoTime === null || typeof result.demoTime === "string", "Should have demoTime");
    assert.ok(Array.isArray(result.objections), "Should have objections array");
  });
};

main();
