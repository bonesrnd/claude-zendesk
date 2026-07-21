import { defineTool } from "@resolve/skill-sdk";

import {
  ZendeskReadVoicemailTranscriptChunkInputSchema,
  ZendeskReadVoicemailTranscriptChunkOutputSchema,
  ZendeskTranscribeVoicemailInputSchema,
  ZendeskTranscribeVoicemailOutputSchema,
} from "./schemas";

export const zendeskTranscribeVoicemailTool = defineTool({
  name: "zendesk_transcribe_voicemail",
  description:
    "Transcribe the Zendesk voicemail identified by an opaque handle from zendesk_list_voicemails.",
  risk: "read",
  requiresConfirmation: false,
  execution: "server",
  inputSchema: ZendeskTranscribeVoicemailInputSchema,
  outputSchema: ZendeskTranscribeVoicemailOutputSchema,
  handler() {
    return Promise.reject(
      new Error("Voicemail transcription requires a Worker runtime handler"),
    );
  },
});

export const zendeskReadVoicemailTranscriptChunkTool = defineTool({
  name: "zendesk_read_voicemail_transcript_chunk",
  description:
    "Read a bounded chunk from a retained voicemail transcript using its opaque transcript handle.",
  risk: "read",
  requiresConfirmation: false,
  execution: "server",
  inputSchema: ZendeskReadVoicemailTranscriptChunkInputSchema,
  outputSchema: ZendeskReadVoicemailTranscriptChunkOutputSchema,
  handler() {
    return Promise.reject(
      new Error("Voicemail transcript chunks require a Worker runtime handler"),
    );
  },
});
