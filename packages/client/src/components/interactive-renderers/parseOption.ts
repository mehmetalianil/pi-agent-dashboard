/**
 * parseOption — split an option string into a title and an optional
 * description sub-line on the first ` — ` (em dash) or ` · ` (middot)
 * separator. Used by SelectRenderer rows and the batch wizard so long
 * options render a dimmed description under the title.
 *
 * See change: redesign-ask-user-question-cards.
 */
export function parseOption(option: string): { title: string; description?: string } {
  const sep = /\s(?:—|·)\s/.exec(option);
  if (!sep) return { title: option };
  return {
    title: option.slice(0, sep.index),
    description: option.slice(sep.index + sep[0].length),
  };
}

/** True when an option is a Cancel affordance (case-insensitive). */
export function isCancelOption(option: string): boolean {
  return /^cancel$/i.test(option.trim());
}

/**
 * Split a combined prompt string (`"${question}\n\nContext:\n${context}"` from
 * `pi-ask-user` RPC fallback, or a multi-paragraph prompt whose body contains
 * block Markdown such as tables/lists/fences) into a clean header `title` and
 * a full-Markdown `message` body whenever `rawMessage` is not already set.
 */
export function splitPromptTitleAndMessage(
  rawTitle: string | undefined,
  rawMessage: string | undefined,
): { title: string; message?: string } {
  const titleStr = typeof rawTitle === "string" ? rawTitle : "";
  const msgStr = typeof rawMessage === "string" && rawMessage.trim().length > 0 ? rawMessage : undefined;
  if (msgStr !== undefined || !titleStr) {
    return { title: titleStr, message: msgStr };
  }

  const ctxMarker = "\n\nContext:\n";
  const ctxIdx = titleStr.indexOf(ctxMarker);
  if (ctxIdx !== -1) {
    const head = titleStr.slice(0, ctxIdx).trim();
    const body = titleStr.slice(ctxIdx + ctxMarker.length).trim();
    if (head && body) {
      return { title: head, message: body };
    }
  }

  const dblNewline = titleStr.indexOf("\n\n");
  if (dblNewline !== -1) {
    const head = titleStr.slice(0, dblNewline).trim();
    const body = titleStr.slice(dblNewline + 2).trim();
    const hasBlockMarkdown = /(?:^|\n)\s*(?:\|.*\|.*\n\s*\|[-:| ]+\||```|#{1,6}\s|[-*+]\s|\d+\.\s|>\s)/.test(body);
    if (head && body && hasBlockMarkdown) {
      return { title: head, message: body };
    }
  }

  return { title: titleStr, message: undefined };
}
