/** Claude Code aliases that always mean the newest model of their family. */
const MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku']);
/** A model family with a version ("opus-5-5", "haiku-4-5"), completed to the full model id. */
const VERSIONED_MODEL = /^(?:opus|sonnet|haiku|fable)(?:-\d+)+$/;

/**
 * Maps a label value to a model name Claude Code accepts: "opus" and "claude-opus" become the alias "opus"
 * (newest Opus), "sonnet-5-5" and "claude-sonnet-5-5" the model id "claude-sonnet-5-5". Null for anything else.
 */
export function modelForLabelValue(value: string): string | null {
  const name = value.trim().toLowerCase().replace(/^claude-/, '');
  if (MODEL_ALIASES.has(name)) return name;
  if (VERSIONED_MODEL.test(name)) return `claude-${name}`;
  return null;
}

/** A model name or id without the "claude-" prefix and a context-window suffix ("[1m]"), lowercased. */
export function bareModelName(model: string): string {
  return model.trim().toLowerCase().replace(/\[[^\]]*\]$/, '').replace(/^claude-/, '');
}
