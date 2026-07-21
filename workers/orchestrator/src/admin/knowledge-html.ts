import type { KnowledgeDocument } from "../repositories/knowledge";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function documentRows(documents: readonly KnowledgeDocument[]): string {
  if (documents.length === 0) {
    return '<p class="empty">No Markdown files have been indexed.</p>';
  }
  return documents
    .map(
      (
        document,
      ) => `<article class="document" id="document-${escapeHtml(document.id)}" data-document-id="${escapeHtml(document.id)}">
  <div>
    <h2>${escapeHtml(document.filename)}</h2>
    <p><span class="status status-${escapeHtml(document.status)}">${escapeHtml(document.status)}</span> · ${document.chunkCount} chunks</p>
    <p class="updated">Updated ${escapeHtml(document.updatedAt)}</p>
  </div>
  <div class="actions">
    <button type="button" data-action="replace">Replace</button>
    <button type="button" class="danger" data-action="delete">Delete</button>
  </div>
</article>`,
    )
    .join("\n");
}

export function renderKnowledgeAdminHtml(
  documents: readonly KnowledgeDocument[],
  nonce: string,
): string {
  const safeNonce = escapeHtml(nonce);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Resolve Knowledge</title>
  <style nonce="${safeNonce}">
    :root { color-scheme: dark; font-family: "JetBrains Mono", "Cascadia Mono", monospace; background: #11100f; color: #f5f0e8; }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 280px; }
    main { width: min(920px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0; }
    h1 { margin: 0; font-size: clamp(1.6rem, 6vw, 3.4rem); letter-spacing: -0.06em; }
    .lede, .updated, .empty { color: #aca59b; }
    #dropzone { margin: 32px 0 20px; padding: 48px 24px; border: 1px dashed #81796e; background: #181614; text-align: center; cursor: pointer; }
    #dropzone.active { border-color: #ffb347; background: #211b14; }
    button { border: 1px solid #81796e; border-radius: 2px; padding: 9px 13px; background: #211f1c; color: inherit; font: inherit; cursor: pointer; }
    button:hover, button:focus-visible { border-color: #ffb347; outline: none; }
    .danger { color: #ff8d85; }
    .document { display: flex; align-items: center; justify-content: space-between; gap: 20px; border-top: 1px solid #39342f; padding: 20px 0; }
    .document h2 { margin: 0 0 8px; overflow-wrap: anywhere; font-size: 1rem; }
    .document p { margin: 4px 0; font-size: .8rem; }
    .actions { display: flex; gap: 8px; flex: none; }
    .status { color: #ffb347; }
    .status-indexed { color: #87d68d; }
    .status-failed, .status-delete_failed { color: #ff8d85; }
    .status-deleting { color: #ffb347; }
    #progress { min-height: 42px; margin-bottom: 28px; }
    progress { width: 100%; accent-color: #ffb347; }
    #message { white-space: pre-wrap; overflow-wrap: anywhere; color: #ffb347; }
    @media (max-width: 560px) { .document { align-items: flex-start; flex-direction: column; } }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="lede">RESOLVE / ADMIN</p>
      <h1>Workflow knowledge</h1>
      <p class="lede">Cloudflare Access-protected Markdown ingestion and semantic indexing.</p>
    </header>
    <section id="dropzone" tabindex="0" role="button" aria-controls="file-input">
      <strong>Drop Markdown files</strong>
      <p class="lede">or select up to 50 .md files; each is uploaded separately (5 MB max)</p>
    </section>
    <input id="file-input" type="file" accept=".md,text/markdown" multiple hidden>
    <input id="replace-input" type="file" accept=".md,text/markdown" hidden>
    <section id="progress" aria-live="polite">
      <strong>Upload progress</strong>
      <progress id="progress-bar" max="100" value="0"></progress>
      <p id="message"></p>
    </section>
    <section aria-label="Indexed files">
      ${documentRows(documents)}
    </section>
  </main>
  <script nonce="${safeNonce}">
    (() => {
      const dropzone = document.querySelector("#dropzone");
      const picker = document.querySelector("#file-input");
      const replacePicker = document.querySelector("#replace-input");
      const progress = document.querySelector("#progress-bar");
      const message = document.querySelector("#message");
      const UPLOAD_CONCURRENCY = 3;
      let replaceId = null;

      const upload = (file, method, url, onProgress = () => {}) => new Promise((resolve) => {
        const form = new FormData();
        form.append("file", file);
        const request = new XMLHttpRequest();
        request.open(method, url);
        request.upload.addEventListener("progress", (event) => {
          if (event.lengthComputable) onProgress((event.loaded / event.total) * 100);
        });
        request.addEventListener("load", () => {
          if (request.status >= 200 && request.status < 300) {
            resolve({ ok: true, status: request.status });
            return;
          }
          let error = "Upload failed.";
          try {
            const body = JSON.parse(request.responseText);
            error = body.result?.error || body.error || error;
          } catch {}
          resolve({ ok: false, status: request.status, error });
        });
        request.addEventListener("error", () => {
          resolve({ ok: false, status: 0, error: "Network error while uploading." });
        });
        request.send(form);
      });

      const uploadFiles = async (files) => {
        const selected = Array.from(files);
        const bounded = selected.slice(0, 50);
        const failures = [];
        const outcomes = [];
        const progressByFile = new Map();
        let nextIndex = 0;
        const updateProgress = () => {
          const total = [...progressByFile.values()].reduce((sum, value) => sum + value, 0);
          progress.value = bounded.length === 0 ? 0 : total / bounded.length;
        };
        const worker = async () => {
          while (nextIndex < bounded.length) {
            const index = nextIndex++;
            const file = bounded[index];
            progressByFile.set(index, 0);
            message.textContent = "Uploading " + file.name + " (" + (index + 1) + "/" + bounded.length + ")";
            const result = await upload(file, "POST", "/admin/api/knowledge", (value) => {
              progressByFile.set(index, value);
              updateProgress();
            });
            outcomes[index] = result.ok
              ? file.name + ": queued"
              : file.name + ": " + result.error;
            progressByFile.set(index, 100);
            updateProgress();
            if (!result.ok) failures.push(file.name + ": " + result.error);
          }
        };
        const workers = Array.from(
          { length: Math.min(UPLOAD_CONCURRENCY, bounded.length) },
          () => worker(),
        );
        await Promise.all(workers);
        if (failures.length === 0) location.reload();
        else message.textContent = outcomes.join("\\n");
      };

      dropzone.addEventListener("click", () => picker.click());
      dropzone.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") picker.click();
      });
      dropzone.addEventListener("dragover", (event) => {
        event.preventDefault();
        dropzone.classList.add("active");
      });
      dropzone.addEventListener("dragleave", () => dropzone.classList.remove("active"));
      dropzone.addEventListener("drop", (event) => {
        event.preventDefault();
        dropzone.classList.remove("active");
        void uploadFiles(event.dataTransfer.files);
      });
      picker.addEventListener("change", () => void uploadFiles(picker.files));

      document.addEventListener("click", async (event) => {
        const button = event.target.closest("button[data-action]");
        if (!button) return;
        const row = button.closest("[data-document-id]");
        if (!row) return;
        const id = row.dataset.documentId;
        if (button.dataset.action === "replace") {
          replaceId = id;
          replacePicker.click();
          return;
        }
        if (button.dataset.action === "delete" && confirm("Delete this knowledge file and its semantic index?")) {
          const response = await fetch("/admin/api/knowledge/" + encodeURIComponent(id), { method: "DELETE" });
          if (response.ok) row.remove();
          else message.textContent = "Delete failed.";
        }
      });
      replacePicker.addEventListener("change", async () => {
        if (!replaceId || !replacePicker.files?.[0]) return;
        const result = await upload(replacePicker.files[0], "PUT", "/admin/api/knowledge/" + encodeURIComponent(replaceId));
        if (result.ok) location.reload();
        else message.textContent = result.error;
      });
    })();
  </script>
</body>
</html>`;
}
