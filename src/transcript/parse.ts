import type {
  TranscriptAttachment,
  TranscriptMessage,
  TranscriptToolCall,
} from "../protocol/types.js";
import { DEFAULT_TOOL_TEXT_CHARS, MAX_TOOL_ARG_CHARS } from "./limits.js";

export interface ParseLimits {
  maxBytes: number;
  maxMessages: number;
  toolTextChars?: number;
}

export interface JsonlParseResult {
  messages: TranscriptMessage[];
  truncated: boolean;
  metadataLines: number;
  badLines: number;
  bytesKept: number;
  totalLines: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function normalizeRole(role: string): string {
  const value = role.trim().toLowerCase();
  if (value === "human" || value === "用户") return "user";
  if (value === "bot" || value === "ai" || value === "model" || value === "助手") return "assistant";
  if (value === "系统") return "system";
  return value;
}

function capJson(value: unknown, dropped: Set<string>, field: string): unknown {
  let text: string;
  try {
    text = JSON.stringify(value) ?? "";
  } catch {
    dropped.add(field);
    return undefined;
  }
  if (text.length <= MAX_TOOL_ARG_CHARS) return value;
  dropped.add(`${field}.truncated`);
  return text.slice(0, MAX_TOOL_ARG_CHARS);
}

function textOf(value: unknown, dropped: Set<string>, field: string, limit: number): string {
  let text = "";
  if (typeof value === "string") text = value;
  else if (Array.isArray(value)) {
    text = value
      .map((item) => {
        if (typeof item === "string") return item;
        const rec = asRecord(item);
        if (rec && typeof rec.text === "string") return rec.text;
        if (rec && typeof rec.content === "string") return rec.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  } else if (value !== undefined && value !== null) {
    const rec = asRecord(value);
    if (rec && typeof rec.text === "string") text = rec.text;
    else {
      dropped.add(field);
      return "";
    }
  }
  if (text.length > limit) {
    dropped.add(`${field}.truncated`);
    return text.slice(0, limit);
  }
  return text;
}

function consumeBlocks(
  role: string,
  content: unknown,
  dropped: Set<string>,
  toolLimit: number,
): { texts: string[]; toolCalls: TranscriptToolCall[]; attachments: TranscriptAttachment[] } {
  const texts: string[] = [];
  const toolCalls: TranscriptToolCall[] = [];
  const attachments: TranscriptAttachment[] = [];

  const takeBlock = (block: unknown, index: number) => {
    if (typeof block === "string") {
      texts.push(block);
      return;
    }
    const rec = asRecord(block);
    if (!rec) {
      dropped.add(`content[${index}]`);
      return;
    }
    const type = typeof rec.type === "string" ? rec.type : "";
    if (type === "text" || type === "output_text" || type === "input_text" || (!type && typeof rec.text === "string")) {
      if (typeof rec.text === "string") texts.push(rec.text);
      else dropped.add(`content[${index}].text`);
      return;
    }
    if (type === "tool_use" || type === "tool_call" || type === "function_call") {
      const fn = asRecord(rec.function);
      const name =
        typeof rec.name === "string"
          ? rec.name
          : fn && typeof fn.name === "string"
            ? fn.name
            : "tool";
      const call: TranscriptToolCall = { name };
      const args = rec.input ?? rec.arguments ?? fn?.arguments;
      if (args !== undefined) {
        const capped = capJson(args, dropped, `tool_calls.${name}.arguments`);
        if (capped !== undefined) call.arguments = capped;
      }
      if (rec.result !== undefined || rec.output !== undefined) {
        call.result = capJson(rec.result ?? rec.output, dropped, `tool_calls.${name}.result`);
      } else {
        dropped.add(`tool_calls.${name}.result`);
      }
      toolCalls.push(call);
      return;
    }
    if (type === "tool_result" || type === "function_result") {
      texts.push(textOf(rec.content ?? rec.output ?? rec.result, dropped, "tool_result", toolLimit));
      return;
    }
    if (type === "image" || type === "image_url" || type === "input_image") {
      attachments.push({
        ...(typeof rec.name === "string" ? { name: rec.name } : {}),
        mime: typeof rec.mime === "string" ? rec.mime : "image",
        omitted: true,
      });
      dropped.add(`attachments.${type}`);
      return;
    }
    dropped.add(type ? `content.${type}` : `content[${index}]`);
  };

  if (typeof content === "string") texts.push(role === "tool" ? textOf(content, dropped, "content", toolLimit) : content);
  else if (Array.isArray(content)) content.forEach(takeBlock);
  else if (content !== undefined && content !== null) dropped.add("content");

  return { texts, toolCalls, attachments };
}

function messageFromParts(
  role: string,
  content: unknown,
  extraDropped: string[],
  toolLimit: number,
  timestamp?: string,
): TranscriptMessage | undefined {
  const dropped = new Set(extraDropped);
  const parts = consumeBlocks(role, content, dropped, toolLimit);
  if (parts.texts.length === 0 && parts.toolCalls.length === 0 && parts.attachments.length === 0) {
    return undefined;
  }
  const message: TranscriptMessage = {
    role,
    content: parts.texts.join("\n"),
  };
  if (parts.toolCalls.length > 0) message.tool_calls = parts.toolCalls;
  if (parts.attachments.length > 0) message.attachments = parts.attachments;
  if (dropped.size > 0) message.dropped_fields = [...dropped];
  if (timestamp) message.timestamp = timestamp;
  return message;
}

const NOTABLE = ["thinking", "reasoning", "images", "attachments", "toolResults", "tool_results"];

export function messageFromUnknown(value: unknown, toolLimit = DEFAULT_TOOL_TEXT_CHARS): TranscriptMessage | "metadata" | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const extra = NOTABLE.filter((key) => key in rec);
  const message = asRecord(rec.message);
  const roleRaw =
    (typeof rec.role === "string" && rec.role) ||
    (message && typeof message.role === "string" && message.role) ||
    (typeof rec.type === "string" && ["user", "assistant", "system", "tool"].includes(rec.type) ? rec.type : "");
  if (!roleRaw) return "metadata";
  const role = normalizeRole(roleRaw);
  const content =
    rec.content !== undefined ? rec.content : message?.content !== undefined ? message.content : rec.text;
  const timestamp =
    (typeof rec.timestamp === "string" && rec.timestamp) ||
    (typeof rec.createdAt === "string" && rec.createdAt) ||
    undefined;
  const built = messageFromParts(role, content ?? "", extra, toolLimit, timestamp || undefined);
  if (!built) return "metadata";
  if (Array.isArray(rec.tool_calls)) {
    const calls = built.tool_calls ? [...built.tool_calls] : [];
    const dropped = new Set(built.dropped_fields ?? []);
    rec.tool_calls.forEach((item, index) => {
      const callRec = asRecord(item);
      if (!callRec) {
        dropped.add(`tool_calls[${index}]`);
        return;
      }
      const name = typeof callRec.name === "string" ? callRec.name : "tool";
      const call: TranscriptToolCall = { name };
      if (callRec.arguments !== undefined || callRec.input !== undefined) {
        const capped = capJson(callRec.arguments ?? callRec.input, dropped, `tool_calls.${name}.arguments`);
        if (capped !== undefined) call.arguments = capped;
      }
      if (callRec.result === undefined && callRec.output === undefined) {
        dropped.add(`tool_calls.${name}.result`);
      } else {
        call.result = capJson(callRec.result ?? callRec.output, dropped, `tool_calls.${name}.result`);
      }
      calls.push(call);
    });
    built.tool_calls = calls;
    if (dropped.size > 0) built.dropped_fields = [...dropped];
  }
  return built;
}

export function parseTranscriptJsonl(raw: string, limits: ParseLimits, alreadyTruncated = false): JsonlParseResult {
  const toolLimit = limits.toolTextChars ?? DEFAULT_TOOL_TEXT_CHARS;
  const lines = raw.split(/\r?\n/);
  const messages: TranscriptMessage[] = [];
  let metadataLines = 0;
  let badLines = 0;
  let bytesKept = 0;
  let truncated = alreadyTruncated;
  let totalLines = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    totalLines += 1;
    const size = Buffer.byteLength(line);
    if (messages.length >= limits.maxMessages || bytesKept + size > limits.maxBytes) {
      truncated = true;
      break;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      badLines += 1;
      continue;
    }
    const message = messageFromUnknown(parsed, toolLimit);
    if (message === "metadata" || message === undefined) {
      if (message === "metadata") metadataLines += 1;
      else badLines += 1;
      bytesKept += size;
      continue;
    }
    messages.push(message);
    bytesKept += size;
  }

  return { messages, truncated, metadataLines, badLines, bytesKept, totalLines };
}

const ROLE_LINE =
  /^(user|assistant|system|tool|human|bot|用户|助手|系统)\s*[:：]\s*(.*)$/i;

export function parsePlaintextTranscript(raw: string, limits: ParseLimits): JsonlParseResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { messages: [], truncated: false, metadataLines: 0, badLines: 0, bytesKept: 0, totalLines: 0 };
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const record = asRecord(parsed);
      const list = Array.isArray(parsed) ? parsed : record && Array.isArray(record.messages) ? record.messages : undefined;
      if (list) {
        const messages: TranscriptMessage[] = [];
        let bytesKept = 0;
        let metadataLines = 0;
        let truncated = false;
        for (const item of list) {
          const size = Buffer.byteLength(JSON.stringify(item) ?? "");
          if (messages.length >= limits.maxMessages || bytesKept + size > limits.maxBytes) {
            truncated = true;
            break;
          }
          const message = messageFromUnknown(item, limits.toolTextChars);
          if (!message || message === "metadata") {
            metadataLines += 1;
            continue;
          }
          messages.push(message);
          bytesKept += size;
        }
        if (messages.length > 0) {
          return { messages, truncated, metadataLines, badLines: 0, bytesKept, totalLines: list.length };
        }
      }
    } catch {
      // Fall through to JSONL or role text. A .json file that is actually JSONL still works.
    }
  }
  if (trimmed.includes("\n{") || trimmed.startsWith("{")) {
    const asJsonl = parseTranscriptJsonl(raw, limits);
    if (asJsonl.messages.length > 0) return asJsonl;
  }
  return parseRoleText(raw, limits);
}

function parseRoleText(raw: string, limits: ParseLimits): JsonlParseResult {
  const lines = raw.split(/\r?\n/);
  const groups: { role: string; lines: string[] }[] = [];
  let current: { role: string; lines: string[] } | null = null;
  let matched = 0;
  for (const line of lines) {
    const header = line.match(ROLE_LINE);
    if (header) {
      matched += 1;
      if (current) groups.push(current);
      current = { role: normalizeRole(header[1]), lines: [header[2]] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) groups.push(current);
  const structured = matched >= 2 || (matched === 1 && lines.filter((line) => line.trim()).length <= 4);
  if (!structured) {
    const limit = limits.maxBytes;
    const truncated = Buffer.byteLength(raw) > limit || raw.length > limit;
    const content = truncated ? raw.slice(0, Math.min(raw.length, limit)) : raw;
    return {
      messages: [
        {
          role: "user",
          content: content.trim(),
          ...(truncated ? { dropped_fields: ["content.truncated"] } : {}),
        },
      ],
      truncated,
      metadataLines: 0,
      badLines: 0,
      bytesKept: Buffer.byteLength(content),
      totalLines: 1,
    };
  }
  const messages: TranscriptMessage[] = [];
  let bytesKept = 0;
  let truncated = false;
  for (const group of groups) {
    const content = group.lines.join("\n").trim();
    const size = Buffer.byteLength(content);
    if (messages.length >= limits.maxMessages || bytesKept + size > limits.maxBytes) {
      truncated = true;
      break;
    }
    const toolish = group.role === "tool" && content.length > (limits.toolTextChars ?? DEFAULT_TOOL_TEXT_CHARS);
    messages.push({
      role: group.role,
      content: toolish ? content.slice(0, limits.toolTextChars ?? DEFAULT_TOOL_TEXT_CHARS) : content,
      ...(toolish ? { dropped_fields: ["content.truncated"] } : {}),
    });
    bytesKept += size;
  }
  return { messages, truncated, metadataLines: 0, badLines: 0, bytesKept, totalLines: groups.length };
}
