import { randomUUID } from "node:crypto";
import type {
  NoteContentContext,
  NoteIdentity,
  PublishPayload,
  StructuredNoteContent,
} from "./types.js";

const stripNewlines = (value: string): string => value.replace(/\r?\n/g, "");

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function normalizeBlocks(value: string): string[] {
  const lines = value.replace(/\r/g, "").split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      current.push(line);
      continue;
    }

    if (!inFence && /^-{3,}$/.test(trimmed)) {
      if (current.length > 0) {
        blocks.push(current.join("\n").trim());
        current = [];
      }
      continue;
    }

    if (!inFence && trimmed === "") {
      if (current.length > 0) {
        blocks.push(current.join("\n").trim());
        current = [];
      }
      continue;
    }

    current.push(line);
  }

  if (current.length > 0) {
    blocks.push(current.join("\n").trim());
  }

  return blocks.filter(Boolean);
}

export function parseInlineMarkdown(text: string): string {
  const codeSegments: string[] = [];
  const placeholderPrefix = "[[NOTE-CODE-";
  const withCode = text.replace(/`([^`]+)`/g, (_match, code: string) => {
    const index = codeSegments.push(`<code>${code}</code>`) - 1;
    return `${placeholderPrefix}${index}]]`;
  });

  const withBold = withCode.replace(
    /\*\*(.+?)\*\*|__(.+?)__/g,
    (_match, boldA?: string, boldB?: string) =>
      `<b>${boldA ?? boldB ?? ""}</b>`,
  );
  const withItalic = withBold.replace(
    /\*(.+?)\*|_(.+?)_/g,
    (_match, italicA?: string, italicB?: string) =>
      `<i>${italicA ?? italicB ?? ""}</i>`,
  );

  return withItalic.replace(
    /\[\[NOTE-CODE-(\d+)\]\]/g,
    (_match, index: string) => codeSegments[Number(index)] ?? "",
  );
}

export function buildBlockHtml(
  block: string,
  seed: string,
): { id: string; html: string } {
  const id = `${seed}-${randomUUID().slice(0, 8)}`;
  const rawLines = block.replace(/\r/g, "").split("\n");
  const trimmedLines = rawLines.map((line) => line.trim());
  const nonEmptyLines = trimmedLines.filter((line) => line.length > 0);

  if (nonEmptyLines.length === 0) {
    return { id, html: "" };
  }

  const firstLine = nonEmptyLines[0];

  if (firstLine.startsWith("```")) {
    const lang = escapeHtml(firstLine.slice(3).trim());
    const closingIndex = trimmedLines.lastIndexOf("```");
    const codeLines =
      closingIndex > 0 ? rawLines.slice(1, closingIndex) : rawLines.slice(1);
    const code = escapeHtml(codeLines.join("\n"));
    const langAttr = lang ? ` class="language-${lang}"` : "";
    return {
      id,
      html: `<pre name="${id}" id="${id}"><code${langAttr}>${code}</code></pre>`,
    };
  }

  const h3 = firstLine.match(/^### (.+)$/);
  if (h3) {
    return {
      id,
      html: `<h4 name="${id}" id="${id}">${parseInlineMarkdown(escapeHtml(h3[1]))}</h4>`,
    };
  }

  const h2 = firstLine.match(/^## (.+)$/);
  if (h2) {
    return {
      id,
      html: `<h3 name="${id}" id="${id}">${parseInlineMarkdown(escapeHtml(h2[1]))}</h3>`,
    };
  }

  const h1 = firstLine.match(/^# (.+)$/);
  if (h1) {
    return {
      id,
      html: `<h2 name="${id}" id="${id}">${parseInlineMarkdown(escapeHtml(h1[1]))}</h2>`,
    };
  }

  type Run = { type: "ul" | "ol" | "p"; lines: string[] };
  const runs: Run[] = [];

  for (const line of nonEmptyLines) {
    const last = runs[runs.length - 1];
    const type: Run["type"] = /^[-*] /.test(line)
      ? "ul"
      : /^\d+\. /.test(line)
        ? "ol"
        : "p";

    if (last && last.type === type) {
      last.lines.push(line);
    } else {
      runs.push({ type, lines: [line] });
    }
  }

  const parts = runs.map((run, index) => {
    const attrs = index === 0 ? ` name="${id}" id="${id}"` : "";

    if (run.type === "ul") {
      const items = run.lines
        .map(
          (line) =>
            `<li>${parseInlineMarkdown(escapeHtml(line.replace(/^[-*] /, "")))}</li>`,
        )
        .join("");
      return `<ul${attrs}>${items}</ul>`;
    }

    if (run.type === "ol") {
      const items = run.lines
        .map(
          (line) =>
            `<li>${parseInlineMarkdown(escapeHtml(line.replace(/^\d+\. /, "")))}</li>`,
        )
        .join("");
      return `<ol${attrs}>${items}</ol>`;
    }

    return `<p${attrs}>${run.lines.map((line) => parseInlineMarkdown(escapeHtml(line))).join("<br>")}</p>`;
  });

  return { id, html: parts.join("") };
}

export function buildParagraphs(
  value: string,
  seed: string,
): Array<{ id: string; html: string }> {
  return normalizeBlocks(value).map((block) => buildBlockHtml(block, seed));
}

export function buildStructuredNoteContent(
  context: NoteContentContext,
): StructuredNoteContent {
  const saleSettingRequested =
    context.salesMode === "free_paid" &&
    context.paidContentMarkdown.trim().length > 0;

  if (!saleSettingRequested) {
    const paragraphs = buildParagraphs(
      context.noteBody,
      `job-${context.jobId}-body`,
    );
    const fullHtml = paragraphs.map((item) => item.html).join("");
    return {
      fullHtml,
      freeHtml: fullHtml,
      paidHtml: "",
      separator: null,
      bodyLength: stripNewlines(context.noteBody).length,
    };
  }

  const freeMarkdown = [
    context.freePreviewMarkdown.trim().length > 0
      ? context.freePreviewMarkdown
      : context.noteBody,
    context.transitionCtaText.trim().length > 0
      ? context.transitionCtaText
      : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");

  const freeParagraphs = buildParagraphs(
    freeMarkdown,
    `job-${context.jobId}-free`,
  );
  const paidParagraphs = buildParagraphs(
    context.paidContentMarkdown,
    `job-${context.jobId}-paid`,
  );

  if (freeParagraphs.length === 0 || paidParagraphs.length === 0) {
    const paragraphs = buildParagraphs(
      context.noteBody,
      `job-${context.jobId}-body`,
    );
    const fullHtml = paragraphs.map((item) => item.html).join("");
    return {
      fullHtml,
      freeHtml: fullHtml,
      paidHtml: "",
      separator: null,
      bodyLength: stripNewlines(context.noteBody).length,
    };
  }

  const freeHtml = freeParagraphs.map((item) => item.html).join("");
  const paidHtml = paidParagraphs.map((item) => item.html).join("");
  const bodyLengthSource = `${
    context.freePreviewMarkdown.trim().length > 0
      ? context.freePreviewMarkdown
      : context.noteBody
  }${context.paidContentMarkdown}`;

  return {
    fullHtml: `${freeHtml}${paidHtml}`,
    freeHtml,
    paidHtml,
    separator: freeParagraphs.at(-1)?.id ?? null,
    bodyLength: stripNewlines(bodyLengthSource).length,
  };
}

export function buildPublishPayload(
  note: NoteIdentity,
  context: NoteContentContext & { priceYen?: number },
  structured: StructuredNoteContent,
): PublishPayload {
  const saleSettingRequested =
    context.salesMode === "free_paid" &&
    Boolean(structured.separator) &&
    structured.paidHtml.length > 0;

  return {
    author_ids: [],
    body_length: structured.bodyLength,
    disable_comment: false,
    exclude_from_creator_top: false,
    exclude_ai_learning_reward: false,
    free_body: structured.freeHtml,
    hashtags: [],
    image_keys: [],
    index: false,
    is_refund: false,
    limited: saleSettingRequested,
    magazine_ids: [],
    magazine_keys: [],
    name: context.title,
    pay_body: saleSettingRequested ? structured.paidHtml : "",
    price: saleSettingRequested ? (context.priceYen ?? 300) : 0,
    send_notifications_flag: true,
    separator: saleSettingRequested ? structured.separator : null,
    slug: note.slug,
    status: "published",
    circle_permissions: [],
    discount_campaigns: [],
    lead_form: {
      is_active: false,
      consent_url: "",
    },
    line_add_friend: {
      is_active: false,
      keyword: "",
      add_friend_url: "",
    },
    line_add_friend_access_token: "",
  };
}
