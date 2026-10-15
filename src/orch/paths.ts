import type { AgentMessage } from "@earendil-works/pi-agent-core";

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export function canonicalPath(value: string, caller = "/root"): string {
  if (!value || value !== value.trim())
    throw new Error("Agent path must not be empty or contain surrounding whitespace");
  const path = value.startsWith("/") ? value : `${caller}/${value}`;
  const parts = path.slice(1).split("/");
  if (!parts.every((part) => SEGMENT.test(part)) || parts.length > 32) {
    throw new Error(
      "Agent paths require slash-separated names (letters, digits, - or _); no dot segments, escapes, empty segments or trailing slash",
    );
  }
  return path;
}
export function parentPath(path: string): string | null {
  canonicalPath(path);
  const last = path.lastIndexOf("/");
  return last === 0 ? null : path.slice(0, last);
}
export function isDescendant(path: string, ancestor: string): boolean {
  return path.startsWith(`${ancestor}/`);
}

/**
 * Tool result synthesized for a call still pending at fork time: the parent
 * spawned this thread before that tool ran, so its result can never be in the
 * snapshot. Amnesiating the call instead made children inherit "I announced
 * the calls" as bare text, and protocol-native models (kimi-k3) reacted by
 * emitting their native tool-call markup as plain text. Keeping the call and
 * closing it with an honest result preserves API-legal call/result pairs and
 * tells the child what actually happened.
 */
function supersededResult(
  assistant: AgentMessage,
  call: { id: string; name: string },
): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [
      {
        type: "text",
        text: `Call superseded: the parent session forked this thread before this tool executed, so its result is not part of this thread's history. The call did not run here. If you still need this work, issue the tool call yourself.`,
      },
    ],
    isError: false,
    timestamp: assistant.timestamp,
  } as unknown as AgentMessage;
}

/**
 * Snapshot conversation, not the parent's prompt/loadout; retain only matched tool
 * exchanges. Calls still pending at fork time are kept and closed with a synthesized
 * superseded result (see {@link supersededResult}) instead of being dropped.
 */
export function inheritContext(messages: readonly AgentMessage[]): AgentMessage[] {
  const copy = structuredClone(messages);
  const matchedCalls = new Set<string>();
  const matchedResults = new Set<number>();
  const pending = new Map<string, { messageIndex: number; blockIndex: number }[]>();

  for (const [messageIndex, message] of copy.entries()) {
    if (message.role === "assistant") {
      if (message.stopReason === "error" || message.stopReason === "aborted") continue;
      for (const [blockIndex, block] of message.content.entries()) {
        if (block.type !== "toolCall") continue;
        const queue = pending.get(block.id);
        const occurrence = { messageIndex, blockIndex };
        if (queue) queue.push(occurrence);
        else pending.set(block.id, [occurrence]);
      }
      continue;
    }
    if (message.role === "toolResult") {
      const queue = pending.get(message.toolCallId);
      const occurrence = queue?.shift();
      if (!occurrence) continue;
      matchedCalls.add(`${occurrence.messageIndex}:${occurrence.blockIndex}`);
      matchedResults.add(messageIndex);
      if (queue && !queue.length) pending.delete(message.toolCallId);
      continue;
    }
  }
  // Calls still queued never received a result inside the snapshot: the fork
  // happened before their tool ran.
  const supersededCalls = new Set<string>();
  for (const queue of pending.values()) {
    for (const occurrence of queue) {
      supersededCalls.add(`${occurrence.messageIndex}:${occurrence.blockIndex}`);
    }
  }

  return copy.flatMap((message, messageIndex): AgentMessage[] => {
    // Only the system prompt/loadout is replaced; custom and shell messages are real conversation context.
    if (message.role === "system") return [];
    if (message.role === "assistant") {
      if (message.stopReason === "error" || message.stopReason === "aborted") return [];
      const supersededHere: { id: string; name: string }[] = [];
      message.content = message.content.filter((block, blockIndex) => {
        if (block.type !== "toolCall") return true;
        if (matchedCalls.has(`${messageIndex}:${blockIndex}`)) return true;
        if (!supersededCalls.has(`${messageIndex}:${blockIndex}`)) return false;
        supersededHere.push(block as unknown as { id: string; name: string });
        return true;
      });
      if (!message.content.length) return [];
      // A tools-only assistant without remaining calls should not claim a toolUse stop.
      if (
        message.stopReason === "toolUse" &&
        !message.content.some((block) => block.type === "toolCall")
      )
        message.stopReason = "stop";
      const out: AgentMessage[] = [message];
      for (const call of supersededHere) out.push(supersededResult(message, call));
      return out;
    }
    if (message.role === "toolResult" && !matchedResults.has(messageIndex)) return [];
    return [message];
  });
}
