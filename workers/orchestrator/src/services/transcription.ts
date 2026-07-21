import { experimental_transcribe } from "ai";
import { createWorkersAI } from "workers-ai-provider";

import {
  ZendeskListVoicemailsOutputSchema,
  ZendeskReadVoicemailTranscriptChunkInputSchema,
  ZendeskReadVoicemailTranscriptChunkOutputSchema,
  ZendeskTranscribeVoicemailOutputSchema,
  ZendeskVoicemailArtifactSchema,
  ZendeskVoicemailHandleSchema,
  ZendeskVoicemailTranscriptArtifactSchema,
  ZendeskVoicemailTranscriptHandleSchema,
} from "@resolve/contracts";
import type {
  ZendeskTranscribeVoicemailOutput,
  ZendeskVoicemailArtifact,
  ZendeskVoicemailTranscriptArtifact,
} from "@resolve/contracts";
import type { z } from "zod";

import { fetchBoundedAudio } from "./audio-fetch";

export interface TranscriptSegment {
  text: string;
  startSecond: number;
  endSecond: number;
}

export interface AudioTranscript {
  text: string;
  language?: string;
  segments?: TranscriptSegment[];
}

type ZendeskListVoicemailsOutput = z.infer<
  typeof ZendeskListVoicemailsOutputSchema
>;
type ZendeskReadVoicemailTranscriptChunkOutput = z.infer<
  typeof ZendeskReadVoicemailTranscriptChunkOutputSchema
>;

const TRANSCRIPT_PREVIEW_CHARS = 1_000;

export interface RetainedVoicemailResult {
  modelOutput: {
    voicemails: Array<{
      handle: string;
      createdAt: string;
      hasExistingTranscript: boolean;
      transcriptPreview?: string;
    }>;
    citations: ZendeskListVoicemailsOutput["citations"];
  };
  retainedArtifacts: Record<string, ZendeskVoicemailArtifact>;
}

export function retainZendeskVoicemails(
  value: unknown,
): RetainedVoicemailResult {
  const output = ZendeskListVoicemailsOutputSchema.parse(value);
  const citation = output.citations[0];
  if (output.voicemails.length > 0 && !citation) {
    throw new Error("Zendesk voicemail results require a ticket citation");
  }

  const retainedArtifacts: Record<string, ZendeskVoicemailArtifact> = {};
  const voicemails = output.voicemails.map((voicemail) => {
    const handle = ZendeskVoicemailHandleSchema.parse(
      `vm_${crypto.randomUUID()}`,
    );
    const transcript = voicemail.transcriptionText.trim().replace(/\s+/g, " ");
    retainedArtifacts[handle] = ZendeskVoicemailArtifactSchema.parse({
      kind: "zendesk_voicemail",
      voicemail,
      citation,
    });
    return {
      handle,
      createdAt: voicemail.createdAt,
      hasExistingTranscript: transcript.length > 0,
      ...(transcript ? { transcriptPreview: transcript.slice(0, 48) } : {}),
    };
  });

  return {
    modelOutput: { voicemails, citations: output.citations },
    retainedArtifacts,
  };
}

export async function transcribeAudio(
  audio: Uint8Array,
  mediaType: string,
  ai: Ai,
  signal: AbortSignal,
): Promise<AudioTranscript> {
  const workersai = createWorkersAI({ binding: ai });
  const options = {
    model: workersai.transcription("@cf/openai/whisper-large-v3-turbo"),
    audio,
    mediaType,
    abortSignal: signal,
  };
  const transcript = await experimental_transcribe(options);

  return {
    text: transcript.text,
    ...(transcript.language ? { language: transcript.language } : {}),
    ...(transcript.segments.length > 0
      ? {
          segments: transcript.segments.map((segment) => ({
            text: segment.text,
            startSecond: segment.startSecond,
            endSecond: segment.endSecond,
          })),
        }
      : {}),
  };
}

export async function transcribeVoicemail(
  input: ZendeskVoicemailArtifact,
  signal: AbortSignal,
  ai: Ai,
): Promise<ZendeskVoicemailTranscriptArtifact> {
  const existing = input.voicemail.transcriptionText.trim();
  if (existing) {
    return ZendeskVoicemailTranscriptArtifactSchema.parse({
      kind: "zendesk_voicemail_transcript",
      text: existing,
      source: "zendesk_existing",
      citations: [input.citation],
    });
  }

  const audio = await fetchBoundedAudio(input.voicemail.recordingUrl, signal);
  const transcript = await transcribeAudio(
    audio.bytes,
    audio.mediaType,
    ai,
    signal,
  );
  return ZendeskVoicemailTranscriptArtifactSchema.parse({
    kind: "zendesk_voicemail_transcript",
    ...transcript,
    source: "cloudflare_workers_ai",
    citations: [input.citation],
  });
}

export function retainVoicemailTranscript(
  value: unknown,
  retainArtifact: (handle: string, value: unknown) => void,
): ZendeskTranscribeVoicemailOutput {
  const transcript = ZendeskVoicemailTranscriptArtifactSchema.parse(value);
  const handle = ZendeskVoicemailTranscriptHandleSchema.parse(
    `vmt_${crypto.randomUUID()}`,
  );
  retainArtifact(handle, transcript);
  const preview = transcript.text.slice(0, TRANSCRIPT_PREVIEW_CHARS);
  return ZendeskTranscribeVoicemailOutputSchema.parse({
    handle,
    preview,
    transcriptLength: transcript.text.length,
    status:
      transcript.text.length > TRANSCRIPT_PREVIEW_CHARS
        ? "truncated"
        : "complete",
    ...(transcript.language ? { language: transcript.language } : {}),
    source: transcript.source,
    citations: transcript.citations,
  });
}

export function readVoicemailTranscriptChunk(
  inputValue: unknown,
  artifactValue: unknown,
): ZendeskReadVoicemailTranscriptChunkOutput {
  const input =
    ZendeskReadVoicemailTranscriptChunkInputSchema.parse(inputValue);
  const artifact =
    ZendeskVoicemailTranscriptArtifactSchema.parse(artifactValue);
  if (input.offset >= artifact.text.length) {
    throw new Error("Transcript offset is outside the retained transcript");
  }
  const text = artifact.text.slice(input.offset, input.offset + input.length);
  const nextOffset = input.offset + text.length;
  return ZendeskReadVoicemailTranscriptChunkOutputSchema.parse({
    handle: input.handle,
    offset: input.offset,
    text,
    transcriptLength: artifact.text.length,
    nextOffset,
    status: nextOffset >= artifact.text.length ? "complete" : "more",
    citations: artifact.citations,
  });
}
