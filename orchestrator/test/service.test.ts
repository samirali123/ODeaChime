import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatError, ChatService } from "../src/chat/service.ts";
import { ModelRouter } from "../src/models/router.ts";
import { ModelUnavailableError, type ModelProvider, type ProviderSession } from "../src/models/types.ts";
import { ToolRegistry } from "../src/tools/registry.ts";

/** A model that answers "reply N" where N counts turns within its session. */
function countingModel(): ModelProvider & { sessions: number } {
  const model = {
    id: "fake",
    supportsVision: false,
    sessions: 0,
    newSession(): ProviderSession {
      model.sessions++;
      let turns = 0;
      return {
        addUser() {},
        addToolResults() {},
        async step() {
          return { stop: "done" as const, text: `reply ${++turns}`, toolCalls: [] };
        },
      };
    },
  };
  return model;
}

function service(model: ModelProvider, messagesPerHour = 100, extra: { fallback?: ModelProvider; minRole?: "staff" } = {}) {
  return new ChatService({
    router: new ModelRouter({ primary: model, fallback: extra.fallback }),
    minRole: extra.minRole,
    registry: new ToolRegistry(),
    timeZone: "America/Los_Angeles",
    messagesPerHour,
    maxMessageChars: 4000,
    conversationTtlMinutes: 60,
  });
}

const alice = { id: "alice", role: "student" as const };
const bob = { id: "bob", role: "student" as const };

test("web: a returned conversation id continues the same conversation", async () => {
  const model = countingModel();
  const chat = service(model);
  const first = await chat.ask({ user: alice, channel: "web", message: "hi" });
  const second = await chat.ask({ user: alice, channel: "web", message: "again", conversationId: first.conversationId });
  assert.equal(second.reply, "reply 2");
  assert.equal(model.sessions, 1);
});

test("someone else's conversation id starts a fresh conversation", async () => {
  const model = countingModel();
  const chat = service(model);
  const first = await chat.ask({ user: alice, channel: "web", message: "hi" });
  const other = await chat.ask({ user: bob, channel: "web", message: "hi", conversationId: first.conversationId });
  assert.equal(other.reply, "reply 1");
  assert.notEqual(other.conversationId, first.conversationId);
});

test("teams: a stable key keeps one conversation per chat, and reset clears it", async () => {
  const chat = service(countingModel());
  const key = "teams:conv-1:aad-1";
  await chat.ask({ user: alice, channel: "teams", message: "a", conversationId: key, conversationKeyIsStable: true });
  const second = await chat.ask({ user: alice, channel: "teams", message: "b", conversationId: key, conversationKeyIsStable: true });
  assert.equal(second.conversationId, key);
  assert.equal(second.reply, "reply 2");
  chat.reset(key);
  const third = await chat.ask({ user: alice, channel: "teams", message: "c", conversationId: key, conversationKeyIsStable: true });
  assert.equal(third.reply, "reply 1");
});

test("rate limit per user", async () => {
  const chat = service(countingModel(), 2);
  await chat.ask({ user: alice, channel: "web", message: "1" });
  await chat.ask({ user: alice, channel: "web", message: "2" });
  await assert.rejects(chat.ask({ user: alice, channel: "web", message: "3" }), (e: unknown) => e instanceof ChatError && e.status === 429);
  await chat.ask({ user: bob, channel: "web", message: "1" }); // others unaffected
});

test("empty messages are rejected", async () => {
  const chat = service(countingModel());
  await assert.rejects(chat.ask({ user: alice, channel: "web", message: "   " }), (e: unknown) => e instanceof ChatError && e.status === 400);
});

test("staff-only launch: students are turned away, staff get answers", async () => {
  const chat = service(countingModel(), 100, { minRole: "staff" });
  await assert.rejects(chat.ask({ user: alice, channel: "web", message: "hi" }), (e: unknown) => e instanceof ChatError && e.status === 403);
  const out = await chat.ask({ user: { id: "teacher", role: "staff" }, channel: "web", message: "hi" });
  assert.equal(out.reply, "reply 1");
});

test("when the local model is down, the fallback answers", async () => {
  const down: ModelProvider = {
    id: "local",
    supportsVision: false,
    newSession: () => ({
      addUser() {},
      addToolResults() {},
      async step(): Promise<never> {
        throw new ModelUnavailableError("local");
      },
    }),
  };
  const backup = countingModel();
  const chat = service(down, 100, { fallback: backup });
  const out = await chat.ask({ user: alice, channel: "web", message: "hi" });
  assert.equal(out.model, "fake");
  assert.equal(out.reply, "reply 1");
  // Without a fallback the error surfaces.
  await assert.rejects(service(down).ask({ user: alice, channel: "web", message: "hi" }), ModelUnavailableError);
});
