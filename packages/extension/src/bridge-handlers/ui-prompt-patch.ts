/**
 * `ctx.ui` → PromptBus patch applied at `session_start`.
 *
 * Extracted from `bridge-handlers/lifecycle.ts` (change: test-trust-audit, design D2). Holds no
 * module-level state and never imports the bridge entry point.
 */

import type { ImageContent } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { MAX_PER_MESSAGE_BYTES as ATTACH_MAX_PER_MESSAGE_BYTES, persistAttachment } from "../ask-user-attachments.js";
import { decodeMultiselectAnswer } from "../multiselect-decode.js";
import { createNotifyProxy } from "../notify-proxy.js";
import type { PromptBus } from "../prompt-bus.js";
import { buildPromptMeta } from "../prompt-meta.js";
import { createTuiPromptAdapter } from "../tui-prompt-adapter.js";
import type { BridgeInstance } from "./instance.js";

/**
 * Capture the original `ctx.ui` dialog methods, register the TUI adapter against them, then
 * replace `ctx.ui.select/input/confirm/editor/multiselect/batch/inputWithImages/notify` with
 * PromptBus wrappers so every extension prompt routes through the bus to the dashboard.
 *
 * Order matters: the originals are captured BEFORE patching and the TUI adapter is registered
 * BEFORE patching (it presents prompts through the unpatched methods).
 * See changes: fix-multiselect-tui-arm-self-cancel, split-notify-from-prompt-request.
 */
export function patchUiForPromptBus(inst: BridgeInstance, ctx: any, promptBus: PromptBus): void {
    // Capture original ctx.ui method references BEFORE patching
    const originalNotify = ctx.ui.notify?.bind(ctx.ui);
    const prevCustom = typeof ctx.ui.custom === "function" ? ctx.ui.custom.bind(ctx.ui) : undefined;
    const originals = {
      select: ctx.ui.select?.bind(ctx.ui) as ((q: string, opts: string[], extra?: any) => Promise<string | undefined>) | undefined,
      input: ctx.ui.input?.bind(ctx.ui) as ((q: string, placeholder?: string, extra?: any) => Promise<string | undefined>) | undefined,
      confirm: ctx.ui.confirm?.bind(ctx.ui) as ((q: string, msg: string, extra?: any) => Promise<boolean>) | undefined,
      editor: ctx.ui.editor?.bind(ctx.ui) as ((q: string, prefill?: string, extra?: any) => Promise<string | undefined>) | undefined,
      // NOTE: the `custom` field is intentionally NOT captured here. A
      // previous change (fix-multiselect-auto-cancel-on-dashboard) added a
      // TUI multiselect arm that awaited the original ctx.ui.custom binding,
      // but pi 0.70's RPC mode defines that primitive as a no-op (returns
      // undefined synchronously), causing the TUI adapter to auto-cancel the
      // dashboard-rendered dialog within one event-loop tick. The arm has
      // been removed; see change fix-multiselect-tui-arm-self-cancel for full
      // rationale. A repo lint (no-tui-multiselect-arm-regression.test.ts)
      // prevents reintroduction by banning the co-occurrence of two
      // substrings (the captured original binding and the TUI arm match).
    };

    // Register TUI adapter — presents prompts in the terminal using original
    // (unpatched) ctx.ui methods. Must be registered BEFORE patching ctx.ui.
    if (ctx.hasUI) {
      promptBus.registerAdapter(createTuiPromptAdapter(originals, promptBus));
    }

    // Replace ctx.ui dialog methods with PromptBus wrappers.
    // All extension commands that call ctx.ui.select/input/confirm/editor
    // now route through the bus, which distributes to all registered adapters.
    {
      const bus = promptBus;
      // Build a `metadata` envelope for bus.request that includes both
      // `message` (existing) and `toolCallId` (new — added by change
      // `fix-interactive-ui-reorder` so the client reducer can pair the
      // resulting interactiveUi row with its parent toolResult row).
      // Free-floating callers (slash commands, architect prompts) omit
      // `opts.toolCallId` and the metadata field stays undefined.
      // Also carries an optional namespaced `opts.pluginMeta` → `metadata.plugin`
      // (validated; see prompt-meta.ts). See change: add-browser-editor-pane-tab.
      const buildMeta = (opts: any, explicitMessage?: string) => buildPromptMeta(opts, explicitMessage);

      // Extract `\n\nContext:\n` appended by `pi-ask-user` RPC fallback into
      // `metadata.message` when the caller did not pass `opts.message`, so the
      // dashboard renders the context block through full `MarkdownContent`.
      const splitEmbeddedContext = (
        rawTitle: string,
        opts?: any,
      ): { question: string; explicitMessage?: string } => {
        if (typeof rawTitle !== "string" || (opts && typeof opts.message === "string" && opts.message.length > 0)) {
          return { question: rawTitle };
        }
        const marker = "\n\nContext:\n";
        const idx = rawTitle.indexOf(marker);
        if (idx === -1) return { question: rawTitle };
        const head = rawTitle.slice(0, idx).trim();
        const body = rawTitle.slice(idx + marker.length).trim();
        if (!head || !body) return { question: rawTitle };
        return { question: head, explicitMessage: body };
      };

      (ctx.ui as any).select = (title: string, options: string[], opts?: any) => {
        const { question, explicitMessage } = splitEmbeddedContext(title, opts);
        return bus.request({ pipeline: "command", type: "select", question, options, metadata: buildMeta(opts, explicitMessage) })
          .then(r => r.cancelled ? undefined : r.answer);
      };

      (ctx.ui as any).input = (title: string, placeholder?: string, opts?: any) => {
        const { question, explicitMessage } = splitEmbeddedContext(title, opts);
        return bus.request({ pipeline: "command", type: "input", question, defaultValue: placeholder, metadata: buildMeta(opts, explicitMessage) })
          .then(r => r.cancelled ? undefined : r.answer);
      };

      // Persist pasted images for an ask_user input answer to disk + emit one
      // asset_register per new hash (dashboard thumbnail). Returns absolute
      // paths the LLM can Read. Drops over per-image / cumulative caps.
      // Closes over sessionId, connection, getEmittedAssetHashes (all in
      // scope here). See change: add-ask-user-input-multiline-paste.
      const persistAnswerImages = (
        images: ImageContent[],
      ): Array<{ path: string; mimeType: string; bytes: number }> => {
        const out: Array<{ path: string; mimeType: string; bytes: number }> = [];
        const emitted = inst.getEmittedAssetHashes(inst.sessionId);
        let cumulative = 0;
        for (const image of images) {
          const persisted = persistAttachment({ sessionId: inst.sessionId, image });
          if (!persisted) continue;
          if (cumulative + persisted.bytes > ATTACH_MAX_PER_MESSAGE_BYTES) {
            console.warn(`[bridge] ask_user image over cumulative cap dropped (${persisted.hash})`);
            continue;
          }
          cumulative += persisted.bytes;
          if (!emitted.has(persisted.hash)) {
            emitted.add(persisted.hash);
            inst.connection.send({
              type: "asset_register",
              sessionId: inst.sessionId,
              hash: persisted.hash,
              mimeType: persisted.mimeType,
              data: image.data,
            });
          }
          out.push({ path: persisted.path, mimeType: persisted.mimeType, bytes: persisted.bytes });
        }
        return out;
      };

      // ctx.ui.inputWithImages is NOT a built-in pi method. The ask_user tool
      // calls it for method:"input" so pasted images survive (ctx.ui.input
      // decodes to a bare string, dropping PromptResponse.images). Resolves
      // to: undefined (cancel) | string (no images) | {value, attachments}
      // (images). See change: add-ask-user-input-multiline-paste, design.md
      // Decision 1.
      (ctx.ui as any).inputWithImages = (title: string, placeholder?: string, opts?: any) => {
        const { question, explicitMessage } = splitEmbeddedContext(title, opts);
        return bus.request({ pipeline: "command", type: "input", question, defaultValue: placeholder, metadata: buildMeta(opts, explicitMessage) })
          .then(r => {
            if (r.cancelled) return undefined;
            const atts = r.images?.length ? persistAnswerImages(r.images) : [];
            return atts.length ? { value: r.answer ?? "", attachments: atts } : (r.answer ?? "");
          });
      };

      (ctx.ui as any).confirm = (title: string, message?: string, opts?: any) =>
        bus.request({ pipeline: "command", type: "confirm", question: title, metadata: buildMeta(opts, message) })
          .then(r => !r.cancelled && r.answer === "true");

      (ctx.ui as any).editor = (title: string, prefill?: string, opts?: any) =>
        bus.request({ pipeline: "command", type: "editor", question: title, defaultValue: prefill, metadata: buildMeta(opts) })
          .then(r => r.cancelled ? undefined : r.answer);

      // ── Multiselect ──────────────────────────────────────────────
      // ctx.ui.multiselect is NOT a built-in pi method — we attach it here
      // so that polyfillMultiselect (and any other consumer) routes through
      // PromptBus. The dashboard adapter renders a real browser dialog via
      // MultiselectRenderer; there is intentionally no TUI adapter arm for
      // multiselect (pi 0.70 RPC mode's ctx.ui.custom is a no-op, so any TUI
      // arm would auto-cancel the dashboard render in <1s). See changes
      // fix-multiselect-auto-cancel-on-dashboard (initial bus routing) and
      // fix-multiselect-tui-arm-self-cancel (TUI arm removal).
      if (typeof (ctx.ui as any).multiselect === "function") {
        // Defensive: future upstream pi may add a built-in multiselect.
        // Override is intentional — the bus-routed version is what
        // participates in PromptBus first-response-wins semantics.
        // eslint-disable-next-line no-console
        console.warn("[bridge] ctx.ui.multiselect already exists — overriding for PromptBus routing");
      }
      (ctx.ui as any).multiselect = (title: string, options: string[], opts?: any) => {
        const { question, explicitMessage } = splitEmbeddedContext(title, opts);
        return bus.request({
          pipeline: "command",
          type: "multiselect",
          question,
          options,
          metadata: buildMeta(opts, explicitMessage),
        }).then(decodeMultiselectAnswer);
      };

      // ── Batch ────────────────────────────────────────────────────
      // ctx.ui.batch is NOT a built-in pi method. The ask_user tool calls it
      // to dispatch a multi-question batch as ONE bus request carrying
      // `questions[]` in metadata; the dashboard renders a BatchRenderer
      // wizard and returns one `{answers}` response (JSON-encoded in the bus
      // `answer` string). Resolves to BatchAnswer[] on submit, or undefined on
      // cancel. See change: redesign-ask-user-question-cards.
      (ctx.ui as any).batch = (title: string, questions: unknown[], opts?: any) =>
        bus.request({
          pipeline: "command",
          type: "batch",
          question: title,
          metadata: { ...(buildMeta(opts) ?? {}), questions },
        }).then((r) => {
          if (r.cancelled || r.answer == null) return undefined;
          try {
            const parsed = JSON.parse(r.answer);
            if (!Array.isArray(parsed)) return undefined;
            // Persist any input-step images and rewrite that answer to
            // {value, attachments}, dropping the raw base64 `images`.
            // See change: add-ask-user-input-multiline-paste.
            return parsed.map((a: any) => {
              if (a && typeof a === "object" && Array.isArray(a.images) && a.images.length) {
                const atts = persistAnswerImages(a.images);
                const { images: _drop, ...rest } = a;
                return atts.length ? { ...rest, attachments: atts } : rest;
              }
              return a;
            });
          } catch {
            return undefined;
          }
        });

      // Notify is fire-and-forget: call original + forward to dashboard on the
      // dedicated `notify` channel. See change: split-notify-from-prompt-request.
      (ctx.ui as any).notify = createNotifyProxy({
        sessionId: inst.sessionId,
        send: (msg) => inst.connection.send(msg),
        originalNotify,
      });

      // Bridge `pi-ask-user` custom components (`AskComponent` and `BatchAskComponent`)
      // in RPC/headless dashboard mode where `prevCustom` resolves to `undefined`.
      // Instead of letting `pi-ask-user` degrade to `askViaDialogs` (which strips
      // option descriptions and asks batch questions one-by-one), route them
      // through `ctx.ui.batch`, `ctx.ui.multiselect`, and `ctx.ui.select` with
      // full Markdown `message` and `"title — description"` options.
      (ctx.ui as any).custom = async (factory: any, customOpts?: any) => {
        if (prevCustom) {
          const nativeRes = await prevCustom(factory, customOpts);
          if (nativeRes !== undefined) return nativeRes;
        }
        if (typeof factory !== "function") return undefined;

        let comp: any;
        try {
          const tuiStub = { terminal: { rows: 24, columns: 80 }, requestRender: () => {} };
          const themeStub = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
          const kbStub = { getKeys: () => [], matches: () => false };
          comp = factory(tuiStub, themeStub, kbStub, () => {});
        } catch {
          return undefined;
        }

        const formatOpt = (o: { title: string; description?: string }) =>
          typeof o?.description === "string" && o.description.trim()
            ? `${o.title} — ${o.description.trim()}`
            : String(o?.title ?? "");

        const decodePickedTitle = (
          val: string,
          opts: Array<{ title: string; description?: string }>,
        ): { title: string; isCustom: boolean } => {
          const match = opts.find((o) => formatOpt(o) === val || o.title === val);
          return match ? { title: match.title, isCustom: false } : { title: val, isCustom: true };
        };

        // 1. BatchAskComponent from `pi-ask-user`
        if (comp && Array.isArray(comp.questions) && Array.isArray(comp.pages)) {
          const mappedQuestions = comp.questions.map((q: any) => {
            const qOpts = Array.isArray(q.options) ? q.options : [];
            const method = q.allowMultiple
              ? "multiselect"
              : qOpts.length > 0
                ? "select"
                : "input";
            return {
              method,
              title: q.question ?? "Question",
              message: q.context,
              options: qOpts.length > 0 ? qOpts.map(formatOpt) : undefined,
              ...(method === "select" || method === "multiselect"
                ? { allowOther: q.allowFreeform !== false }
                : {}),
            };
          });
          const batchTitle =
            (typeof comp.heading === "string" && comp.heading.trim()) ||
            comp.questions[0]?.question ||
            "Questions";
          const batchAns: Array<any> | undefined = await (ctx.ui as any).batch(
            batchTitle,
            mappedQuestions,
          );
          if (!Array.isArray(batchAns)) return null;
          return comp.questions.map((q: any, i: number) => {
            const a = batchAns[i];
            const qOpts: Array<{ title: string; description?: string }> = Array.isArray(q.options) ? q.options : [];
            if (qOpts.length === 0) {
              const text = typeof a === "object" && a && "value" in a ? String(a.value ?? "").trim() : String(a ?? "").trim();
              return text ? { status: "answered", response: { kind: "freeform", text } } : { status: "skipped" };
            }
            if (q.allowMultiple) {
              const vals: string[] = Array.isArray(a?.values) ? a.values : Array.isArray(a) ? a : [];
              const titles = vals.map((v) => decodePickedTitle(String(v), qOpts).title).filter(Boolean);
              return titles.length > 0
                ? { status: "answered", response: { kind: "selection", selections: titles } }
                : { status: "skipped" };
            }
            const rawVal = typeof a === "object" && a && "value" in a ? String(a.value ?? "") : String(a ?? "");
            if (!rawVal) return { status: "skipped" };
            const decoded = decodePickedTitle(rawVal, qOpts);
            return decoded.isCustom
              ? { status: "answered", response: { kind: "freeform", text: decoded.title } }
              : { status: "answered", response: { kind: "selection", selections: [decoded.title] } };
          });
        }

        // 2. Single AskComponent from `pi-ask-user`
        if (comp && typeof comp.question === "string" && Array.isArray(comp.options)) {
          const qOpts: Array<{ title: string; description?: string }> = comp.options;
          const formattedOpts = qOpts.map(formatOpt);
          const msgOpts: Record<string, unknown> = {
            ...(comp.context ? { message: comp.context } : {}),
            ...(comp.allowFreeform !== false ? { allowOther: true } : {}),
          };
          if (comp.allowMultiple) {
            const picked = await (ctx.ui as any).multiselect(comp.question, formattedOpts, msgOpts);
            if (!Array.isArray(picked) || picked.length === 0) return null;
            return {
              kind: "selection",
              selections: picked.map((v: string) => decodePickedTitle(String(v), qOpts).title),
            };
          }
          const picked = await (ctx.ui as any).select(comp.question, formattedOpts, msgOpts);
          if (typeof picked !== "string" || !picked.trim()) return null;
          const decoded = decodePickedTitle(picked, qOpts);
          return decoded.isCustom
            ? { kind: "freeform", text: decoded.title }
            : { kind: "selection", selections: [decoded.title] };
        }

        return undefined;
      };
    }
}
