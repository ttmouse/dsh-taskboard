import { useMemo } from "react";
import { useTaskboardI18n } from "../i18n";

/**
 * Question cards. When an agent needs a decision instead of a paragraph, it
 * writes a fenced block in its comment:
 *
 * ```taskboard-options
 * ["按 A 方案改", "按 B 方案改"]
 * ```
 *
 * The board renders those strings as buttons. Picking one posts it as your
 * comment — exactly the same gesture as typing it, so there is no second
 * interaction model to learn (and the comment itself is what makes the agent
 * continue).
 */

/** Fenced answer-list block; tolerant of surrounding text in the comment. */
const OPTIONS_BLOCK = /```taskboard-options[ \t]*\r?\n([\s\S]*?)```/;

/** Answer strings declared by a comment body (empty when it asks nothing). */
export function parseCommentOptions(body: string): string[] {
  const match = OPTIONS_BLOCK.exec(body);
  if (!match) return [];
  try {
    const parsed: unknown = JSON.parse(match[1].trim());
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string" && item.trim() !== "")
      .slice(0, 8);
  } catch {
    return [];
  }
}

interface CommentOptionsProps {
  /** The comment body that may carry the answer list. */
  body: string;
  /** True once a later comment exists — the question was already answered. */
  stale: boolean;
  /** True while a reply is in flight. */
  disabled: boolean;
  /** Post the chosen answer as the user's comment. */
  onPick: (answer: string) => void;
}

export function CommentOptions({ body, stale, disabled, onPick }: CommentOptionsProps) {
  const { text } = useTaskboardI18n();
  const options = useMemo(() => parseCommentOptions(body), [body]);
  if (options.length === 0) return null;
  return (
    <div className={`comment-options${stale ? " is-stale" : ""}`}>
      {options.map((option) => (
        <button
          type="button"
          className="comment-option-button"
          key={option}
          disabled={disabled || stale}
          onClick={() => onPick(option)}
        >
          {option}
        </button>
      ))}
      {stale && <span className="comment-options-stale">{text("已回答", "Answered")}</span>}
    </div>
  );
}
