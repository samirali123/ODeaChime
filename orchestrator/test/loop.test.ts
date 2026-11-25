import assert from "node:assert/strict";
import { test } from "node:test";
import { runTurn } from "../src/chat/loop.ts";
import type { ProviderSession, StepResult, ToolResult } from "../src/models/types.ts";
import { ModelRouter } from "../src/models/router.ts";
import { ToolRegistry, type Tool } from "../src/tools/registry.ts";

/** A scripted model: returns the given steps in order and records what it was sent. */
function fakeSession(steps: StepResult[]) {
  const sent: ToolResult[][] = [];
  const toolNames: string[][] = [];
  const session: ProviderSession = {
    addUser() {},
    addToolResults(r) {
      sent.push(r);
    },
    async step(tools) {
      toolNames.push(tools.map((t) => t.name));
      const next = steps.shift();
      if (!next) throw new Error("no more scripted steps");
      return next;
    },
  };
  return { session, sent, toolNames };
}

const echo: Tool = {
  name: "echo",
  description: "echo",
  inputSchema: { type: "object" },
  minRole: "public",
  async run(input) {
    return `echo:${input.text}`;
  },
};
const staffOnly: Tool = { ...echo, name: "staff_tool", minRole: "staff" };
const ctx = { role: "student" as const, userId: "u", now: new Date() };

test("runs tools, returns results, then the final answer", async () => {
  const { session, sent } = fakeSession([
    { stop: "tools", text: "", toolCalls: [{ id: "1", name: "echo", input: { text: "hi" } }] },
    { stop: "done", text: "All done", toolCalls: [] },
  ]);
  const out = await runTurn(session, new ToolRegistry().register(echo), [{ type: "text", text: "q" }], ctx);
  assert.equal(out.reply, "All done");
  assert.deepEqual(out.toolsUsed, ["echo"]);
  assert.equal(sent[0][0].content, "echo:hi");
});

test("tools above the user's role are hidden and refused", async () => {
  const { session, sent, toolNames } = fakeSession([
    { stop: "tools", text: "", toolCalls: [{ id: "1", name: "staff_tool", input: {} }] },
    { stop: "done", text: "ok", toolCalls: [] },
  ]);
  await runTurn(session, new ToolRegistry().register(echo, staffOnly), [{ type: "text", text: "q" }], ctx);
  assert.deepEqual(toolNames[0], ["echo"]);
  assert.equal(sent[0][0].isError, true);
});

test("a tool that throws becomes an error result, not a crash", async () => {
  const boom: Tool = { ...echo, name: "boom", async run() { throw new Error("device offline"); } };
  const { session, sent } = fakeSession([
    { stop: "tools", text: "", toolCalls: [{ id: "1", name: "boom", input: {} }] },
    { stop: "done", text: "sorry", toolCalls: [] },
  ]);
  await runTurn(session, new ToolRegistry().register(boom), [{ type: "text", text: "q" }], ctx);
  assert.deepEqual(sent[0][0], { callId: "1", name: "boom", content: "device offline", isError: true });
});

test("refusals get a friendly reply", async () => {
  const { session } = fakeSession([{ stop: "refused", text: "", toolCalls: [] }]);
  const out = await runTurn(session, new ToolRegistry(), [{ type: "text", text: "q" }], ctx);
  assert.equal(out.stop, "refused");
  assert.match(out.reply, /can't help/);
});

test("stops after too many tool rounds", async () => {
  const loop: StepResult = { stop: "tools", text: "", toolCalls: [{ id: "1", name: "echo", input: { text: "x" } }] };
  const { session } = fakeSession(Array.from({ length: 10 }, () => ({ ...loop })));
  const out = await runTurn(session, new ToolRegistry().register(echo), [{ type: "text", text: "q" }], ctx, 3);
  assert.equal(out.stop, "tool_limit");
});

test("router: local first, Claude for photos and as fallback, never for local-only", () => {
  const claude = { id: "claude", supportsVision: true, newSession: () => ({}) as ProviderSession };
  const local = { id: "local", supportsVision: false, newSession: () => ({}) as ProviderSession };
  const r = new ModelRouter({ primary: local, fallback: claude, local });
  assert.equal(r.pick({}).id, "local");
  assert.equal(r.pick({ hasImage: true }).id, "claude");
  assert.equal(r.pick({ localOnly: true }).id, "local");
  assert.throws(() => r.pick({ localOnly: true, hasImage: true }));
  assert.equal(r.fallbackAfter(local, {})?.id, "claude");
  assert.equal(r.fallbackAfter(local, { localOnly: true }), undefined);
  assert.equal(r.fallbackAfter(claude, {}), undefined);
  // Fallback switched off: local only.
  const strict = new ModelRouter({ primary: local, local });
  assert.equal(strict.fallbackAfter(local, {}), undefined);
  assert.throws(() => strict.pick({ hasImage: true }));
});
