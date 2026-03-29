import { describe, expect, it } from "vitest";
import {
  buildBlockHtml,
  buildPublishPayload,
  buildStructuredNoteContent,
  normalizeBlocks,
  parseInlineMarkdown,
} from "../src/adapters/note-api/html-builder.js";
import type { NoteContentContext } from "../src/adapters/note-api/types.js";

const makeContext = (
  overrides: Partial<NoteContentContext> = {},
): NoteContentContext => ({
  jobId: 7,
  title: "テスト記事",
  noteBody: "導入\n\n本文",
  freePreviewMarkdown: "導入",
  paidContentMarkdown: "本文",
  salesMode: "normal",
  transitionCtaText: "",
  ...overrides,
});

describe("normalizeBlocks", () => {
  it("空行と '---' をブロック区切りとして扱う", () => {
    expect(normalizeBlocks("A\n\n---\n\nB")).toEqual(["A", "B"]);
  });

  it("コードブロック内は分割しない", () => {
    expect(
      normalizeBlocks("```ts\nconst a = 1;\n\nconst b = 2;\n```"),
    ).toHaveLength(1);
  });
});

describe("parseInlineMarkdown", () => {
  it("太字・斜体・インラインコードを変換する", () => {
    expect(parseInlineMarkdown("a **b** and *c* and `d`")).toBe(
      "a <b>b</b> and <i>c</i> and <code>d</code>",
    );
  });
});

describe("buildBlockHtml", () => {
  it("見出しを note 用の階層へ変換する", () => {
    const result = buildBlockHtml("# 見出し", "seed");
    expect(result.id).toMatch(/^seed-/);
    expect(result.html).toContain("<h2");
    expect(result.html).toContain("見出し");
  });

  it("リストを HTML に変換する", () => {
    const result = buildBlockHtml("- one\n- two", "seed");
    expect(result.html).toContain("<ul");
    expect(result.html).toContain("<li>one</li>");
    expect(result.html).toContain("<li>two</li>");
  });

  it("コードブロックを pre/code に変換する", () => {
    const result = buildBlockHtml("```ts\nconst a = 1;\n```", "seed");
    expect(result.html).toContain("<pre");
    expect(result.html).toContain('<code class="language-ts">');
    expect(result.html).toContain("const a = 1;");
  });

  it("段落を p に変換する", () => {
    const result = buildBlockHtml("最初の行\n次の行", "seed");
    expect(result.html).toContain("<p");
    expect(result.html).toContain("<br>");
  });
});

describe("buildStructuredNoteContent", () => {
  it("通常モードでは全文を無料本文として扱う", () => {
    const structured = buildStructuredNoteContent(makeContext());
    expect(structured.fullHtml).toBe(structured.freeHtml);
    expect(structured.paidHtml).toBe("");
    expect(structured.separator).toBeNull();
  });

  it("free_paid モードでは無料/有料を分離する", () => {
    const structured = buildStructuredNoteContent(
      makeContext({
        salesMode: "free_paid",
        freePreviewMarkdown: "導入\n\nCTAの前",
        paidContentMarkdown: "有料の本文",
        transitionCtaText: "続きはこちら",
      }),
    );

    expect(structured.separator).toBeTruthy();
    expect(structured.freeHtml).toContain("導入");
    expect(structured.freeHtml).toContain("続きはこちら");
    expect(structured.paidHtml).toContain("有料の本文");
    expect(structured.fullHtml).toContain(structured.freeHtml);
    expect(structured.fullHtml).toContain(structured.paidHtml);
    expect(structured.bodyLength).toBeGreaterThan(0);
  });
});

describe("buildPublishPayload", () => {
  it("free_paid の structured から公開 payload を作る", () => {
    const context = makeContext({
      salesMode: "free_paid",
      freePreviewMarkdown: "導入",
      paidContentMarkdown: "有料の本文",
    });
    const structured = buildStructuredNoteContent(context);
    const payload = buildPublishPayload(
      { id: 1, key: "note-key", slug: "note-slug" },
      context,
      structured,
    );

    expect(payload.status).toBe("published");
    expect(payload.name).toBe("テスト記事");
    expect(payload.slug).toBe("note-slug");
    expect(payload.separator).toBe(structured.separator);
    expect(payload.pay_body).toBe(structured.paidHtml);
    expect(payload.free_body).toBe(structured.freeHtml);
    expect(payload.price).toBe(300);
  });
});
