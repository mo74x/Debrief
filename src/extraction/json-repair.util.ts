/**
 * Deterministic repair pass for malformed LLM JSON outputs.
 * Strips markdown wrappers, removes trailing commas, and balances truncated delimiters.
 */
export function repairLlmJson(rawText: string): unknown {
  let cleaned = rawText.trim();

  // 1. Strip markdown ```json ... ``` fences if present
  cleaned = cleaned
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  // 2. Isolate from first '{' to last '}' (or end of string if truncated)
  const firstBrace = cleaned.indexOf('{');
  if (firstBrace !== -1) {
    cleaned = cleaned.slice(firstBrace);
  }

  // Fast path: already valid JSON
  try {
    return JSON.parse(cleaned);
  } catch {
    // Continue to deterministic repair steps
  }

  // 3. Remove trailing commas before } or ]
  cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');

  // 4. Escape literal unescaped newlines/tabs inside JSON string literals & track open delimiters
  let inString = false;
  let escaped = false;
  const stack: ('{' | '[')[] = [];
  let sanitized = '';

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];

    if (escaped) {
      sanitized += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      sanitized += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      sanitized += ch;
      continue;
    }

    if (inString) {
      if (ch === '\n') {
        sanitized += '\\n';
      } else if (ch === '\r') {
        sanitized += '\\r';
      } else if (ch === '\t') {
        sanitized += '\\t';
      } else {
        sanitized += ch;
      }
      continue;
    }

    if (ch === '{' || ch === '[') {
      stack.push(ch);
    } else if (ch === '}' && stack[stack.length - 1] === '{') {
      stack.pop();
    } else if (ch === ']' && stack[stack.length - 1] === '[') {
      stack.pop();
    }

    sanitized += ch;
  }

  // 5. Close dangling string and any unclosed brackets/braces
  if (inString) {
    sanitized += '"';
  }
  sanitized = sanitized.replace(/,\s*$/, '');

  while (stack.length > 0) {
    const opener = stack.pop();
    sanitized += opener === '{' ? '}' : ']';
  }

  return JSON.parse(sanitized);
}
