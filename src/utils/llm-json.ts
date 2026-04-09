function stripMarkdownCodeFences(text: string): string {
  return text
    .replace(/```(?:json)?\s*/gi, "")
    .replace(/```/g, "")
    .trim();
}

function stripUnsafeControlCharacters(text: string): string {
  return Array.from(text)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
    })
    .join("");
}

function normalizeJsonLikeText(text: string): string {
  return stripMarkdownCodeFences(text)
    .replace(/^\uFEFF/, "")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\u00A0/g, " ")
    .trimStart();
}

function sanitizeJsonLikeText(text: string): string {
  return stripUnsafeControlCharacters(normalizeJsonLikeText(text)).trim();
}

function isLikelyStringTerminator(text: string, quoteIndex: number): boolean {
  for (let index = quoteIndex + 1; index < text.length; index += 1) {
    const char = text[index];
    if (/\s/.test(char)) {
      continue;
    }

    return char === "," || char === "}" || char === "]" || char === ":";
  }

  return true;
}

function repairJsonStringLiterals(text: string): string {
  const normalized = sanitizeJsonLikeText(text);
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];

    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      result += char;
      if (inString) {
        escaped = true;
      }
      continue;
    }

    if (char === '"') {
      if (inString) {
        if (isLikelyStringTerminator(normalized, index)) {
          result += char;
          inString = false;
        } else {
          result += '\\"';
        }
      } else {
        result += char;
        inString = true;
      }
      continue;
    }

    if (inString) {
      if (char === "\n") {
        result += "\\n";
        continue;
      }
      if (char === "\r") {
        continue;
      }
      if (char === "\t") {
        result += "\\t";
        continue;
      }
    }

    result += char;
  }

  return result.replace(/,\s*([}\]])/g, "$1");
}

function extractBalancedJson(
  text: string,
  openingChar: "{" | "[",
): string | null {
  const stripped = sanitizeJsonLikeText(text);
  const start = stripped.indexOf(openingChar);
  if (start === -1) {
    return null;
  }

  const closingChar = openingChar === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < stripped.length; index += 1) {
    const char = stripped[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\" && inString) {
      escaped = true;
      continue;
    }

    if (char === '"') {
      if (inString) {
        if (isLikelyStringTerminator(stripped, index)) {
          inString = false;
        }
      } else {
        inString = true;
      }
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === openingChar) {
      depth += 1;
      continue;
    }

    if (char === closingChar) {
      depth -= 1;
      if (depth === 0) {
        return stripped.slice(start, index + 1);
      }
    }
  }

  return null;
}

function parseCandidate<T>(candidate: string | null): T | null {
  if (!candidate) {
    return null;
  }

  const normalized = sanitizeJsonLikeText(candidate);

  try {
    return JSON.parse(normalized) as T;
  } catch {
    try {
      return JSON.parse(repairJsonStringLiterals(normalized)) as T;
    } catch {
      return null;
    }
  }
}

function extractObjectFromUnknown<T>(value: unknown): T | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as T;
  }

  if (
    Array.isArray(value) &&
    value.length === 1 &&
    value[0] &&
    typeof value[0] === "object" &&
    !Array.isArray(value[0])
  ) {
    return value[0] as T;
  }

  return null;
}

function extractArrayFromUnknown<T>(value: unknown): T[] | null {
  if (Array.isArray(value)) {
    return value as T[];
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of [
    "data",
    "items",
    "results",
    "drafts",
    "posts",
    "candidates",
  ]) {
    if (Array.isArray(record[key])) {
      return record[key] as T[];
    }
  }

  const firstArray = Object.values(record).find((entry) =>
    Array.isArray(entry),
  );
  return Array.isArray(firstArray) ? (firstArray as T[]) : null;
}

export function parseJsonObject<T>(text: string): T | null {
  return (
    extractObjectFromUnknown<T>(parseCandidate<unknown>(text)) ??
    parseCandidate<T>(extractBalancedJson(text, "{")) ??
    extractObjectFromUnknown<T>(
      parseCandidate<unknown>(extractBalancedJson(text, "[")),
    )
  );
}

export function parseJsonArray<T>(text: string): T[] | null {
  return (
    extractArrayFromUnknown<T>(parseCandidate<unknown>(text)) ??
    parseCandidate<T[]>(extractBalancedJson(text, "[")) ??
    extractArrayFromUnknown<T>(
      parseCandidate<unknown>(extractBalancedJson(text, "{")),
    )
  );
}
