import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { withOfflineHarness } from "./helpers/integrationHarness.ts";

const plain = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  provider: "integration-test",
  model: "offline",
  api: "openai-completions",
  stopReason: "stop",
  timestamp: Date.now(),
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});

const withCall = (
  text: string,
  name: string,
  args: Record<string, string | boolean>,
): AssistantMessage => ({
  ...plain(text),
  content: [
    { type: "text", text },
    { type: "toolCall", id: `call-${name}`, name, arguments: args },
  ],
  stopReason: "toolUse",
});

test(
  "forked child inherits in-flight spawn call closed with superseded result",
  { timeout: 30000 },
  async () => {
    await withOfflineHarness(
      {
        agentFiles: {
          worker: "---\nname: worker\ndescription: Test worker\n---\nDo the work.\n",
        },
        builtinTools: true,
        onRequest(request) {
          if (!request.path) {
            // Root: 1) a completed tool exchange, 2) the spawn announcement + call.
            if (request.pathCall === 1)
              return withCall("Checking first.", "bash", { command: "echo parent-step-1" });
            if (request.pathCall === 2)
              return withCall("Disparo o filho agora:", "agent_spawn", {
                path: "probe",
                type: "worker",
                task: "Work",
                wait: true,
              });
            return plain("done");
          }
          if (request.path === "/root/probe") {
            assert.match(
              request.messagesText,
              /parent-step-1/,
              "matched earlier exchange keeps its real result",
            );
            assert.match(
              request.messagesText,
              /Disparo o filho agora:/,
              "spawn turn keeps its announcement text",
            );
            assert.match(
              request.messagesText,
              /Call superseded: the parent session forked this thread before this tool executed/,
              "in-flight spawn call is closed with the superseded result",
            );
            assert.doesNotMatch(
              request.messagesText,
              /"call-agent_spawn"\s*,\s*"role"\s*:\s*"user"/,
              "no fabricated user message for the pending call",
            );
            return plain("child done");
          }
          return plain("ok");
        },
      },
      async ({ cwd, open, close, requests, errors }) => {
        const session = await open(SessionManager.create(cwd));
        await session.prompt("Investigate using a subagent.");
        try {
          assert.deepEqual(errors, []);
          assert.ok(
            requests.some((r) => r.path === "/root/probe"),
            "child ran",
          );
          const rootAfterSpawn = requests.find((r) => !r.path && r.pathCall === 3);
          assert.ok(rootAfterSpawn, "root continued after the spawn returned");
          assert.match(
            rootAfterSpawn!.messagesText,
            /"type"\s*:\s*"worker"/,
            "parent keeps the real spawn result in its own context",
          );
        } finally {
          await close(session);
        }
      },
    );
  },
);
