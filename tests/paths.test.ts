import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { canonicalPath, inheritContext, isDescendant, parentPath } from "../src/orch/paths.ts";

test("canonical ancestry is structural, not prefix matching or URL normalization", () => {
  assert.equal(
    canonicalPath("coding-researcher", "/root/worker"),
    "/root/worker/coding-researcher",
  );
  assert.equal(parentPath("/a/b/c"), "/a/b");
  assert.equal(parentPath("/k"), null);
  assert.equal(isDescendant("/root/ab", "/root/a"), false);
  for (const path of [
    "",
    "/root/../worker",
    "/root//worker",
    "/root/worker/",
    "/root/%61",
    " /root/a",
    "/root/a?b",
    "/root/a\\b",
  ])
    assert.throws(() => canonicalPath(path));
});

test("context snapshots strip unfinished/orphaned tool exchanges and clone messages", () => {
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 };
  const assistant = (text: string, calls: [string, string][], stopReason = "toolUse") =>
    ({
      role: "assistant",
      content: [
        { type: "text", text },
        ...calls.map(([id, name]) => ({ type: "toolCall", id, name, arguments: {} })),
      ],
      api: "openai-responses",
      provider: "openai",
      model: "model",
      usage: { ...usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason,
      timestamp: 1,
    }) as AgentMessage;
  const result = (toolCallId: string, text: string) =>
    ({
      role: "toolResult",
      toolCallId,
      toolName: "read",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: 1,
    }) as AgentMessage;
  const messages = [
    { role: "system", content: "parent prompt", timestamp: 1 },
    { role: "user", content: "parent context", timestamp: 1 },
    { role: "custom", customType: "note", content: "keep custom", display: false, timestamp: 1 },
    { role: "bashExecution", command: "echo", output: "keep shell", exitCode: 0, timestamp: 1 },
    assistant("Checking", [
      ["repeat", "read"],
      ["pending", "agent_spawn"],
    ]),
    result("repeat", "first result"),
    result("repeat", "duplicate orphan result"),
    result("orphan", ""),
    assistant("Retrying", [["repeat", "read"]]),
    result("repeat", "second result"),
    assistant("Still waiting", [["repeat", "read"]]),
    assistant("Broken", [["ignored", "read"]], "error"),
    result("ignored", "ignored result"),
  ] as unknown as AgentMessage[];

  const inherited = inheritContext(messages) as any[];
  const summary = inherited.map((message) =>
    message.role === "assistant"
      ? [message.stopReason, ...message.content.map((block: any) => block.id ?? block.text)]
      : message.role === "toolResult"
        ? message.content[0].text
        : message.role,
  );
  const supersededText = `Call superseded: the parent session forked this thread before this tool executed, so its result is not part of this thread's history. The call did not run here. If you still need this work, issue the tool call yourself.`;
  assert.deepEqual(summary, [
    "user",
    "custom",
    "bashExecution",
    ["toolUse", "Checking", "repeat", "pending"],
    supersededText,
    "first result",
    ["toolUse", "Retrying", "repeat"],
    "second result",
    ["toolUse", "Still waiting", "repeat"],
    supersededText,
  ]);
  // Calls without results in the snapshot are kept and closed with a superseded
  // result instead of being amnesiated (which taught children their calls "turn
  // into text").
  assert.equal(inherited[4].role, "toolResult");
  assert.equal(inherited[4].toolCallId, "pending");
  assert.equal(inherited[4].toolName, "agent_spawn");
  assert.equal(inherited[4].isError, false);
  assert.equal(inherited[9].role, "toolResult");
  assert.equal(inherited[9].toolCallId, "repeat");
  assert.equal(inherited[9].toolName, "read");
  assert.equal(inherited[9].isError, false);
  assert.equal((inherited[3] as any).stopReason, "toolUse");
  assert.equal((inherited[8] as any).stopReason, "toolUse");
  inherited[1].content = "child mutation";
  inherited[3].content[0].text = "changed";
  assert.equal((messages[2] as any).content, "keep custom");
  assert.equal((messages[4] as any).content[0].text, "Checking");
});

test("in-flight spawn calls are kept and closed with a superseded result", () => {
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 };
  const spawnTurn = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Now spawn the other two agents in parallel." },
      { type: "text", text: "Disparo os três e concilio quando voltarem:" },
      {
        type: "toolCall",
        id: "call_spawn_inflight",
        name: "agent_spawn",
        arguments: { path: "/root/bridge-mechanism" },
      },
    ],
    api: "openai-completions",
    provider: "cloudwalk",
    model: "kimi-k3",
    usage: { ...usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 1,
  } as unknown as AgentMessage;
  const messages = [
    { role: "user", content: "investigate the seat regression using subagents", timestamp: 1 },
    spawnTurn,
    // No toolResult for call_spawn_inflight: the fork happened while the spawn executed.
  ] as unknown as AgentMessage[];

  const inherited = inheritContext(messages) as any[];
  assert.equal(inherited.length, 3);
  const assistant = inherited[1];
  const superseded = inherited[2];
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.stopReason, "toolUse");
  assert.deepEqual(
    assistant.content.map((block: any) => block.type),
    ["thinking", "text", "toolCall"],
  );
  assert.equal(assistant.content[2].id, "call_spawn_inflight");
  assert.equal(superseded.role, "toolResult");
  assert.equal(superseded.toolCallId, "call_spawn_inflight");
  assert.equal(superseded.toolName, "agent_spawn");
  assert.equal(superseded.isError, false);
  assert.match(superseded.content[0].text, /forked this thread before this tool executed/);
  assert.equal(superseded.timestamp, assistant.timestamp);
  // Original snapshot stays untouched.
  assert.equal((messages[1] as any).content.length, 3);
});
