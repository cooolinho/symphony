import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chooseEffort, chooseModel, effortForLabelValue, isEffortLabel, isModelLabel, modelForLabelValue, modelOverridesFor, sessionClaudeConfig } from '../src/agent/model.ts';
import { roleModelLine } from '../src/service.ts';
import { STANDARD_LABELS, WORKFLOW_LABELS } from '../src/repo-init/labels.ts';
import { isComplexityLabel, isTypeLabel } from '../src/workflow/classify.ts';
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
      fable: 'fable',
      'claude-fable': 'fable',
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
    assert.deepEqual(chooseModel(['bug', 'model: sonnet-5-5'], 'opus'), { model: 'claude-sonnet-5-5', label: 'model: sonnet-5-5', warning: null, labelIgnored: false, source: 'label' });
    assert.deepEqual(chooseModel(['Model:Haiku'], 'opus'), { model: 'haiku', label: 'Model:Haiku', warning: null, labelIgnored: false, source: 'label' });
    assert.deepEqual(chooseModel(['bug'], 'opus'), { model: 'opus', label: null, warning: null, labelIgnored: false, source: 'role' });
    assert.deepEqual(chooseModel([], null), { model: null, label: null, warning: null, labelIgnored: false, source: null });
  });

  it('treats labels naming the same model as one choice', () => {
    assert.deepEqual(chooseModel(['model: opus', 'model: claude-opus'], 'sonnet'), { model: 'opus', label: 'model: opus', warning: null, labelIgnored: false, source: 'label' });
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

  it('picks the model from complexity when no label applies, else the default', () => {
    const modelByComplexity = { S: 'haiku', L: 'opus', XL: 'opus' };
    const chooseByComplexity = (labels: readonly string[], complexity: 'S' | 'L' | null) =>
      chooseModel(labels, 'sonnet', 'apply', complexity, modelByComplexity);

    assert.deepEqual(chooseByComplexity(['bug'], 'S'), { model: 'haiku', label: null, warning: null, labelIgnored: false, source: 'complexity' });
    assert.deepEqual(chooseByComplexity(['bug'], 'L'), { model: 'opus', label: null, warning: null, labelIgnored: false, source: 'complexity' });
    assert.deepEqual(chooseByComplexity(['bug'], null), { model: 'sonnet', label: null, warning: null, labelIgnored: false, source: 'role' });
    assert.deepEqual(chooseByComplexity([], 'S'), { model: 'haiku', label: null, warning: null, labelIgnored: false, source: 'complexity' });
  });

  it('prefers model labels over complexity', () => {
    const modelByComplexity = { S: 'haiku', L: 'opus' };
    const choice = chooseModel(['model: sonnet'], 'sonnet', 'apply', 'S', modelByComplexity);
    assert.deepEqual(choice, { model: 'sonnet', label: 'model: sonnet', warning: null, labelIgnored: false, source: 'label' });
  });

  it('respects model_by_complexity when modelLabel is "ignore"', () => {
    const modelByComplexity = { S: 'haiku', L: 'opus' };
    const choice = chooseModel(['model: sonnet'], 'sonnet', 'ignore', 'L', modelByComplexity);
    assert.deepEqual(choice, { model: 'opus', label: null, warning: null, labelIgnored: true, source: 'complexity' });
  });

  it('ignores model labels when modelLabel policy is "ignore"', () => {
    assert.deepEqual(chooseModel(['model: sonnet'], 'opus', 'ignore'), { model: 'opus', label: null, warning: null, labelIgnored: true, source: 'role' });
    assert.deepEqual(chooseModel(['bug', 'model: haiku'], 'sonnet', 'ignore'), { model: 'sonnet', label: null, warning: null, labelIgnored: true, source: 'role' });
    assert.deepEqual(chooseModel(['bug'], 'opus', 'ignore'), { model: 'opus', label: null, warning: null, labelIgnored: false, source: 'role' });
    assert.deepEqual(chooseModel([], 'haiku', 'ignore'), { model: 'haiku', label: null, warning: null, labelIgnored: false, source: 'role' });
  });

  it('drops fallback models equal to the session model', () => {
    assert.equal(sessionClaudeConfig(claudeConfig({ model: 'opus', fallback_model: 'sonnet' }), 'sonnet', null).fallbackModel, null);
    assert.equal(sessionClaudeConfig(claudeConfig({ fallback_model: 'sonnet, haiku' }), 'sonnet', null).fallbackModel, 'haiku');
    const kept = sessionClaudeConfig(claudeConfig({ model: 'opus', fallback_model: 'sonnet' }), 'haiku', null);
    assert.deepEqual([kept.model, kept.fallbackModel], ['haiku', 'sonnet']);
    assert.equal(sessionClaudeConfig(claudeConfig({ model: 'opus' }), null, null).model, null);
  });

  it('merges role overrides: budget replaces, tools and system prompt append; model and effort are the chosen ones', () => {
    const base = claudeConfig({
      effort: 'medium',
      max_budget_usd: 5,
      allowed_tools: ['Read'],
      disallowed_tools: ['WebFetch'],
      append_system_prompt: 'Base rules.',
    });
    const merged = sessionClaudeConfig(base, 'opus', 'xhigh', {
      model: 'haiku',
      effort: 'high',
      maxBudgetUsd: 1,
      allowedTools: ['Grep'],
      disallowedTools: ['Bash'],
      appendSystemPrompt: 'Review only.',
    });
    assert.equal(merged.model, 'opus');
    assert.equal(merged.effort, 'xhigh');
    assert.equal(merged.maxBudgetUsd, 1);
    assert.deepEqual(merged.allowedTools, ['Read', 'Grep']);
    assert.deepEqual(merged.disallowedTools, ['WebFetch', 'Bash']);
    assert.equal(merged.appendSystemPrompt, 'Base rules.\n\nReview only.');

    const untouched = sessionClaudeConfig(base, null, 'medium', {});
    assert.deepEqual([untouched.effort, untouched.maxBudgetUsd, untouched.appendSystemPrompt], ['medium', 5, 'Base rules.']);
    assert.equal(sessionClaudeConfig(claudeConfig({}), null, null, { appendSystemPrompt: 'Only role.' }).appendSystemPrompt, 'Only role.');
    assert.equal(sessionClaudeConfig(base, null, null).effort, null);
  });

  describe('claude.by_model', () => {
    const haiku = { permission_mode: 'acceptEdits', allowed_tools: ['Bash', 'Read', 'Write', 'Edit'] };

    it('matches a model by family, version or full id, longest key first, and never without a model', () => {
      const { byModel } = claudeConfig({ by_model: { haiku, 'claude-haiku-4-5': { permission_mode: 'dontAsk' } } });
      for (const model of ['haiku', 'claude-haiku-4-6', 'claude-haiku-5-0-20270101', 'HAIKU']) {
        assert.equal(modelOverridesFor(byModel, model).permissionMode, 'acceptEdits', model);
      }
      for (const model of ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-haiku-4-5[1m]']) {
        assert.equal(modelOverridesFor(byModel, model).permissionMode, 'dontAsk', model);
      }
      for (const model of ['sonnet', 'opus', 'claude-sonnet-5-5', 'claude-haikuu-1', null]) {
        assert.deepEqual(modelOverridesFor(byModel, model), {}, String(model));
      }
    });

    it('replaces the permission mode and appends tools after the role overrides, only for the matching model', () => {
      const base = claudeConfig({
        permission_mode: 'auto',
        on_permission_request: 'deny',
        allowed_tools: ['Bash(git push:*)'],
        by_model: { haiku: { ...haiku, on_permission_request: 'approve', disallowed_tools: ['WebFetch'] } },
      });
      const onHaiku = sessionClaudeConfig(base, 'claude-haiku-4-5-20251001', null, { allowedTools: ['Grep'] });
      assert.equal(onHaiku.permissionMode, 'acceptEdits');
      assert.equal(onHaiku.onPermissionRequest, 'approve');
      assert.deepEqual(onHaiku.allowedTools, ['Bash(git push:*)', 'Grep', 'Bash', 'Read', 'Write', 'Edit']);
      assert.deepEqual(onHaiku.disallowedTools, ['WebFetch']);

      for (const model of ['sonnet', 'opus', null]) {
        const other = sessionClaudeConfig(base, model, null);
        assert.deepEqual([other.permissionMode, other.onPermissionRequest, other.allowedTools], ['auto', 'deny', ['Bash(git push:*)']], String(model));
      }
    });
  });

  it('ships model and effort labels that resolve, plus the workflow labels and type/complexity labels', () => {
    assert.equal(STANDARD_LABELS.length, 16 + WORKFLOW_LABELS.length);
    assert.equal(STANDARD_LABELS.filter((label) => isModelLabel(label.name)).length, 4);
    assert.equal(STANDARD_LABELS.filter((label) => isEffortLabel(label.name)).length, 5);
    assert.equal(STANDARD_LABELS.filter((label) => isTypeLabel(label.name)).length, 3);
    assert.equal(STANDARD_LABELS.filter((label) => isComplexityLabel(label.name)).length, 4);
    assert.deepEqual(WORKFLOW_LABELS.map((label) => label.name), ['auto-code', 'concept', 'plan', 'epic', 'feature', 'design', 'quality', 'maintenance', 'manual-merge', 'needs-human']);
    for (const label of STANDARD_LABELS) {
      if (WORKFLOW_LABELS.includes(label)) {
        assert.ok(!isModelLabel(label.name) && !isEffortLabel(label.name) && !isTypeLabel(label.name) && !isComplexityLabel(label.name), label.name);
      } else if (isModelLabel(label.name)) {
        const choice = chooseModel([label.name.toLowerCase()], null);
        assert.ok(choice.model !== null && choice.warning === null, label.name);
        assert.ok(label.description.includes(choice.model), label.name);
      } else if (isEffortLabel(label.name)) {
        const choice = chooseEffort([label.name.toLowerCase()], null);
        assert.ok(choice.effort !== null && choice.warning === null, label.name);
        assert.ok(label.description.includes(choice.effort), label.name);
      } else if (isTypeLabel(label.name) || isComplexityLabel(label.name)) {
        // Type and complexity labels are validated by their name format
        assert.ok(label.name.startsWith('Type: ') || label.name.startsWith('Complexity: '), label.name);
      } else {
        assert.fail(`unexpected label type: ${label.name}`);
      }
      assert.ok(label.description.length <= 100, label.name);
      assert.match(label.color, /^[0-9a-f]{6}$/);
    }
  });
});

describe('effort labels', () => {
  it('maps every effort level, case-insensitively', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) assert.equal(effortForLabelValue(level), level, level);
    assert.equal(effortForLabelValue(' High '), 'high');
    assert.equal(effortForLabelValue('XHIGH'), 'xhigh');
  });

  it('rejects values that are not an effort level', () => {
    for (const value of ['', 'hi', 'extra-high', 'ultra', 'opus', '5']) assert.equal(effortForLabelValue(value), null, value);
  });

  it('recognizes effort labels case-insensitively and keeps them apart from model labels', () => {
    assert.equal(isEffortLabel('Effort: high'), true);
    assert.equal(isEffortLabel('effort:low'), true);
    assert.equal(isEffortLabel('side-effort: high'), false);
    assert.equal(isEffortLabel('Model: opus'), false);
    assert.equal(isModelLabel('Effort: high'), false);
  });

  it('picks the effort from a label, else the default', () => {
    assert.deepEqual(chooseEffort(['bug', 'effort: high'], 'low'), { effort: 'high', label: 'effort: high', warning: null });
    assert.deepEqual(chooseEffort(['Effort:MAX'], null), { effort: 'max', label: 'Effort:MAX', warning: null });
    assert.deepEqual(chooseEffort(['bug', 'model: opus'], 'medium'), { effort: 'medium', label: null, warning: null });
    assert.deepEqual(chooseEffort([], null), { effort: null, label: null, warning: null });
  });

  it('treats labels naming the same level as one choice', () => {
    assert.deepEqual(chooseEffort(['effort: high', 'Effort: HIGH'], 'low'), { effort: 'high', label: 'effort: high', warning: null });
  });

  it('falls back to the default effort for conflicting or unknown labels, with a warning', () => {
    const conflict = chooseEffort(['effort: low', 'effort: max'], 'medium');
    assert.deepEqual([conflict.effort, conflict.label], ['medium', null]);
    assert.match(conflict.warning ?? '', /conflicting effort labels "effort: low", "effort: max"/);

    const unknown = chooseEffort(['effort: hi'], 'medium');
    assert.deepEqual([unknown.effort, unknown.label], ['medium', null]);
    assert.match(unknown.warning ?? '', /unknown effort label "effort: hi"/);

    const mixed = chooseEffort(['effort: hi', 'effort: low'], 'medium');
    assert.deepEqual([mixed.effort, mixed.label], ['low', 'effort: low']);
    assert.match(mixed.warning ?? '', /unknown effort label "effort: hi"/);
  });

  it('chooses model and effort independently', () => {
    const labels = ['model: sonnet', 'effort: high'];
    assert.equal(chooseModel(labels, 'opus').model, 'sonnet');
    assert.equal(chooseEffort(labels, 'low').effort, 'high');
    assert.equal(chooseModel(labels, 'opus').warning, null);
    assert.equal(chooseEffort(labels, 'low').warning, null);
  });
});

describe('roleModelLine', () => {
  it('names role, model and effort, or default without them', () => {
    assert.equal(roleModelLine('reviewer', 'opus', 'high'), 'role reviewer, model opus, effort high');
    assert.equal(roleModelLine('default', null, null), 'role default, model default, effort default');
    assert.equal(roleModelLine('default', 'sonnet'), 'role default, model sonnet, effort default');
  });
});
