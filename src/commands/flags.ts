import { UserInputError } from "../core/errors.js";
import {
  DEFAULT_TRANSCRIPT_MAX_BYTES,
  DEFAULT_TRANSCRIPT_MAX_MESSAGES,
} from "../transcript/limits.js";

export function positiveInt(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 50_000_000) {
    throw new UserInputError(`${label} must be a positive integer.`);
  }
  return value;
}

export function transcriptLimits(opts: { transcriptMaxBytes?: string; transcriptMaxMessages?: string }): {
  transcriptMaxBytes: number;
  transcriptMaxMessages: number;
} {
  return {
    transcriptMaxBytes: positiveInt(opts.transcriptMaxBytes, DEFAULT_TRANSCRIPT_MAX_BYTES, "--transcript-max-bytes"),
    transcriptMaxMessages: positiveInt(
      opts.transcriptMaxMessages,
      DEFAULT_TRANSCRIPT_MAX_MESSAGES,
      "--transcript-max-messages",
    ),
  };
}
