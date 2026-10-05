import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chooseModel, isModelLabel, modelForLabelValue, sessionClaudeConfig } from '../src/agent/model.ts';
import { roleModelLine } from '../src/service.ts';
import { STANDARD_LABELS } from '../src/repo-init/labels.ts';
import { trackerDefaults } from '../src/tracker/registry.ts';
import { resolveConfig } from '../src/workflow/config.ts';

const claudeConfig = (claude: Record<string, unknown>) =>
  resolveConfig({ claude }, { workflowPath: '/w/WORKFLOW.md', env: {}, trackerDefaults }).claude;

describe('model labels', () => {
  it('maps every documented label value to a model Claude Code accepts', () => {
    const expected: Record<string, string> = {
      'claude-opus': 'opus',
      opus: 'opus',
      'claude-opus-5-5': 'claude-opus-5-5',
      'claude-sonnet': 'sonnet',
      'claude-sonnet-5-5': 'claude-sonnet-5-5',
      sonnet: 'sonnet',
      'sonnet-5-5': 'claude-sonnet-5-5',
      haiku: 'haiku',
      'haiku-4-5': 'claude-haiku-4-5',
      'claude-fable-5-1': 'claude-fable-5-1',
      ' Claude-Opus-4-8 ': 'claude-opus-4-8',
    };
    for (const [value, model] of Object.entries(expected)) assert.equal(modelForLabelValue(value), model, value);
  });

  it('rejects values that do not name a model', () => {
    for (const value of ['', 'claude-', 'gpt-4', 'opsu', 'opus-latest', 'sonnet-5.5', 'claude-3-5-sonnet']) {
      assert.equal(modelForLabelValue(value), null, value);
    }
  });

  it('recognizes model labels case-insensitively', () => {
    assert.equal(isModelLabel('Model: opus'), true);
    assert.equal(isModelLabel('model:sonnet'), true);
    assert.equal(isModelLabel('data-model: v2'), false);
    assert.equal(isModelLabel('bug'), false);
  });

  it('picks the model from a label, else the default', () => {
    assert.deepEqual(chooseModel(['bug', 'model: sonnet-5-5'], 'opus'), { model: 'claude-sonnet-5-5', label: 'model: sonnet-5-5', warning: null });
    assert.deepEqual(chooseModel(['Model:Haiku'], 'opus'), { model: 'haiku', label: 'Model:Haiku', warning: null });
    assert.deepEqual(chooseModel(['bug'], 'opus'), { model: 'opus', label: null, warning: null });
    assert.deepEqual(chooseModel([], null), { model: null, label: null, warning: null });
  });

  it('treats labels naming the same model as one choice', () => {
    assert.deepEqual(chooseModel(['model: opus', 'model: claude-opus'], 'sonnet'), { model: 'opus', label: 'model: opus', warning: null });
  });

  it('falls back to the default model for conflicting or unknown labels, with a warning', () => {
    const conflict = chooseModel(['model: opus', 'model: haiku'], 'sonnet');
    assert.equal(conflict.model, 'sonnet');
    assert.equal(conflict.label, null);
    assert.match(conflict.warning ?? '', /conflicting model labels "model: opus", "model: haiku"/);

    const unknown = chooseModel(['model: opsu'], 'sonnet');
    assert.deepEqual([unknown.model, unknown.label], ['sonnet', null]);
    assert.match(unknown.warning ?? '', /unknown model label "model: opsu"/);

    const mixed = chooseModel(['model: opsu', 'model: haiku'], 'sonnet');
    assert.deepEqual([mixed.model, mixed.label], ['haiku', 'model: haiku']);
    assert.match(mixed.warning ?? '', /unknown model label "model: opsu"/);
  });

  it('drops fallback models equal to the session model', () => {
    assert.equal(sessionClaudeConfig(claudeConfig({ model: 'opus', fallback_model: 'sonnet' }), 'sonnet').fallbackModel, null);
    assert.equal(sessionClaudeConfig(claudeConfig({ fallback_model: 'sonnet, haiku' }), 'sonnet').fallbackModel, 'haiku');
    const kept = sessionClaudeConfig(claudeConfig({ model: 'opus', fallback_model: 'sonnet' }), 'haiku');
    assert.deepEqual([kept.model, kept.fallbackModel], ['haiku', 'sonnet']);
    assert.equal(sessionClaudeConfig(claudeConfig({ model: 'opus' }), null).model, null);
  });

  it('merges role overrides: effort and budget replace, tools and system prompt append', () => {
    const base = claudeConfig({
      effort: 'medium',
      max_budget_usd: 5,
      allowed_tools: ['Read'],
      disallowed_tools: ['WebFetch'],
      append_system_prompt: 'Base rules.',
    });
    const merged = sessionClaudeConfig(base, 'opus', {
      model: 'haiku',
      effort: 'high',
      maxBudgetUsd: 1,
      allowedTools: ['Grep'],
      disallowedTools: ['Bash'],
      appendSystemPrompt: 'Review only.',
    });
    assert.equal(merged.model, 'opus');
    assert.equal(merged.effort, 'high');
    assert.equal(merged.maxBudgetUsd, 1);
    assert.deepEqual(merged.allowedTools, ['Read', 'Grep']);
    assert.deepEqual(merged.disallowedTools, ['WebFetch', 'Bash']);
    assert.equal(merged.appendSystemPrompt, 'Base rules.\n\nReview only.');

    const untouched = sessionClaudeConfig(base, null, {});
    assert.deepEqual([untouched.effort, untouched.maxBudgetUsd, untouched.appendSystemPrompt], ['medium', 5, 'Base rules.']);
    assert.equal(sessionClaudeConfig(claudeConfig({}), null, { appendSystemPrompt: 'Only role.' }).appendSystemPrompt, 'Only role.');
  });

  it('only ships standard labels that resolve to a model', () => {
    assert.equal(STANDARD_LABELS.length, 3);
    for (const label of STANDARD_LABELS) {
      assert.ok(isModelLabel(label.name), label.name);
      const choice = chooseModel([label.name.toLowerCase()], null);
      assert.ok(choice.model !== null && choice.warning === null, label.name);
      assert.ok(label.description.includes(choice.model), label.name);
      assert.ok(label.description.length <= 100, label.name);
      assert.match(label.color, /^[0-9a-f]{6}$/);
    }
  });
});

describe('roleModelLine', () => {
  it('names role and model, or default without a model', () => {
    assert.equal(roleModelLine('reviewer', 'opus'), 'role reviewer, model opus');
    assert.equal(roleModelLine('default', null), 'role default, model default');
  });
});
