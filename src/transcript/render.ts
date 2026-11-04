import type { Transcript, TranscriptMessage } from "../protocol/types.js";

export function renderTranscriptMarkdown(transcript: Transcript): string {
  const lines = [
    "# Transcript",
    "",
    "有损对话摘录。附件未内嵌，工具结果可能被截断。此文件不会写入聊天界面，也不会写入加密的本地库。",
    "",
  ];
  if (transcript.source_session_id) lines.push(`- session: ${transcript.source_session_id}`);
  if (transcript.notes) lines.push(`- notes: ${transcript.notes}`);
  lines.push("");
  transcript.messages.forEach((message, index) => {
    lines.push(`## ${index + 1}. ${message.role}`);
    if (message.timestamp) lines.push(`_${message.timestamp}_`, "");
    lines.push(message.content || "_(empty)_", "");
    if (message.tool_calls?.length) {
      for (const call of message.tool_calls) {
        lines.push(`- tool \`${call.name}\`${call.result === undefined ? "（result dropped）" : ""}`);
      }
      lines.push("");
    }
    if (message.attachments?.length) {
      for (const attachment of message.attachments) {
        lines.push(`- attachment omitted: ${attachment.name ?? attachment.mime ?? "file"}`);
      }
      lines.push("");
    }
    if (message.dropped_fields?.length) {
      lines.push(`- dropped: ${message.dropped_fields.join(", ")}`, "");
    }
  });
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

export function previewTranscriptText(transcript: Transcript, limit = 8): string {
  const lines: string[] = [`messages: ${transcript.messages.length}`];
  if (transcript.source_session_id) lines.push(`session: ${transcript.source_session_id}`);
  if (transcript.notes) lines.push(`notes: ${transcript.notes}`);
  const shown = transcript.messages.slice(0, limit);
  for (const [index, message] of shown.entries()) {
    lines.push(previewLine(index, message));
  }
  if (transcript.messages.length > limit) {
    lines.push(`… ${transcript.messages.length - limit} more`);
  }
  return lines.join("\n");
}

function previewLine(index: number, message: TranscriptMessage): string {
  const body = message.content.replace(/\s+/g, " ").slice(0, 180);
  const dropped = message.dropped_fields?.length ? ` [dropped: ${message.dropped_fields.join(", ")}]` : "";
  return `${index + 1}. ${message.role}: ${body}${dropped}`;
}
