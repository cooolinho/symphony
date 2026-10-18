import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classify, isTypeLabel, isComplexityLabel, isNeedsHumanLabel } from '../src/workflow/classify.ts';

describe('classify', () => {
  describe('type classification', () => {
    it('recognizes canonical Type: labels', () => {
      assert.equal(classify(['type: bugfix']).type, 'bugfix');
      assert.equal(classify(['type: feature']).type, 'feature');
      assert.equal(classify(['type: refactor']).type, 'refactor');
    });

    it('handles Type: labels case-insensitively', () => {
      assert.equal(classify(['Type: BUGFIX']).type, 'bugfix');
      assert.equal(classify(['TYPE:Feature']).type, 'feature');
    });

    it('recognizes alias labels (bug, enhancement, refactoring)', () => {
      assert.equal(classify(['bug']).type, 'bugfix');
      assert.equal(classify(['enhancement']).type, 'feature');
      assert.equal(classify(['refactoring']).type, 'refactor');
    });

    it('handles alias labels case-insensitively', () => {
      assert.equal(classify(['BUG']).type, 'bugfix');
      assert.equal(classify(['Enhancement']).type, 'feature');
      assert.equal(classify(['REFACTORING']).type, 'refactor');
    });

    it('prefers Type: over alias labels when both present', () => {
      assert.equal(classify(['bug', 'type: feature']).type, 'feature');
      assert.equal(classify(['enhancement', 'type: refactor']).type, 'refactor');
    });

    it('returns null for conflicting Type: labels', () => {
      const result = classify(['type: bugfix', 'type: feature']);
      assert.equal(result.type, null);
      assert.match(result.warning ?? '', /conflicting type labels/);
    });

    it('returns null for conflicting alias labels', () => {
      const result = classify(['bug', 'enhancement']);
      assert.equal(result.type, null);
      assert.match(result.warning ?? '', /conflicting type labels/);
    });

    it('lets a Type: label win over alias labels', () => {
      const result = classify(['bug', 'type: feature']);
      assert.equal(result.type, 'feature');
      assert.equal(result.warning, null);
    });

    it('returns null for unknown Type: values', () => {
      const result = classify(['type: bug']);
      assert.equal(result.type, null);
      assert.match(result.warning ?? '', /unknown type label/);
    });

    it('ignores unknown alias labels and picks from known ones', () => {
      assert.equal(classify(['unknown', 'bug']).type, 'bugfix');
    });

    it('returns null when no type labels', () => {
      assert.equal(classify(['some-label', 'another']).type, null);
      assert.equal(classify([]).type, null);
    });

    it('tracks the source label in typeLabel', () => {
      assert.equal(classify(['type: bugfix']).typeLabel, 'type: bugfix');
      assert.equal(classify(['BUG']).typeLabel, 'BUG');
      assert.equal(classify(['some-label']).typeLabel, null);
    });
  });

  describe('complexity classification', () => {
    it('recognizes canonical Complexity: labels', () => {
      assert.equal(classify(['complexity: S']).complexity, 'S');
      assert.equal(classify(['complexity: M']).complexity, 'M');
      assert.equal(classify(['complexity: L']).complexity, 'L');
      assert.equal(classify(['complexity: XL']).complexity, 'XL');
    });

    it('handles Complexity: labels case-insensitively', () => {
      assert.equal(classify(['Complexity: s']).complexity, 'S');
      assert.equal(classify(['COMPLEXITY:m']).complexity, 'M');
      assert.equal(classify(['complexity: xl']).complexity, 'XL');
    });

    it('returns null for conflicting Complexity: labels', () => {
      const result = classify(['complexity: S', 'complexity: L']);
      assert.equal(result.complexity, null);
      assert.match(result.warning ?? '', /conflicting complexity labels/);
    });

    it('returns null for unknown Complexity: values', () => {
      const result = classify(['complexity: XL+']);
      assert.equal(result.complexity, null);
      assert.match(result.warning ?? '', /unknown complexity label/);
    });

    it('returns null when no complexity labels', () => {
      assert.equal(classify(['some-label']).complexity, null);
      assert.equal(classify([]).complexity, null);
    });

    it('tracks the source label in complexityLabel', () => {
      assert.equal(classify(['complexity: S']).complexityLabel, 'complexity: S');
      assert.equal(classify(['Complexity: L']).complexityLabel, 'Complexity: L');
      assert.equal(classify(['some-label']).complexityLabel, null);
    });
  });

  describe('combined classification', () => {
    it('classifies both type and complexity independently', () => {
      const result = classify(['bug', 'complexity: M']);
      assert.equal(result.type, 'bugfix');
      assert.equal(result.complexity, 'M');
      assert.equal(result.warning, null);
    });

    it('handles issues with only type', () => {
      const result = classify(['type: feature']);
      assert.equal(result.type, 'feature');
      assert.equal(result.complexity, null);
      assert.equal(result.warning, null);
    });

    it('handles issues with only complexity', () => {
      const result = classify(['complexity: L']);
      assert.equal(result.type, null);
      assert.equal(result.complexity, 'L');
      assert.equal(result.warning, null);
    });

    it('combines warnings from both type and complexity', () => {
      const result = classify(['bug', 'enhancement', 'complexity: S', 'complexity: L']);
      assert.match(result.warning ?? '', /conflicting type labels/);
      assert.match(result.warning ?? '', /conflicting complexity labels/);
    });

    it('handles a realistic issue with multiple labels', () => {
      const result = classify(['feature', 'model: sonnet', 'effort: high', 'complexity: M', 'design']);
      assert.equal(result.type, 'feature');
      assert.equal(result.complexity, 'M');
      assert.equal(result.warning, null);
    });
  });

  describe('label predicate functions', () => {
    it('recognizes Type: labels', () => {
      assert.equal(isTypeLabel('Type: bugfix'), true);
      assert.equal(isTypeLabel('type: feature'), true);
      assert.equal(isTypeLabel('TYPE:refactor'), true);
      assert.equal(isTypeLabel(' type: bugfix '), true);
      assert.equal(isTypeLabel('feature'), false);
      assert.equal(isTypeLabel('type-bugfix'), false);
    });

    it('recognizes Complexity: labels', () => {
      assert.equal(isComplexityLabel('Complexity: S'), true);
      assert.equal(isComplexityLabel('complexity: M'), true);
      assert.equal(isComplexityLabel('COMPLEXITY:L'), true);
      assert.equal(isComplexityLabel(' complexity: XL '), true);
      assert.equal(isComplexityLabel('S'), false);
      assert.equal(isComplexityLabel('complexity-S'), false);
    });

    it('recognizes needs-human label', () => {
      assert.equal(isNeedsHumanLabel('needs-human'), true);
      assert.equal(isNeedsHumanLabel('Needs-Human'), true);
      assert.equal(isNeedsHumanLabel('NEEDS-HUMAN'), true);
      assert.equal(isNeedsHumanLabel(' needs-human '), true);
      assert.equal(isNeedsHumanLabel('needs-human-review'), false);
      assert.equal(isNeedsHumanLabel('human'), false);
    });
  });

  describe('custom type aliases', () => {
    it('uses provided aliases instead of defaults', () => {
      const result = classify(['urgent'], { typeAliases: { urgent: 'bugfix', 'low-priority': 'refactor' } });
      assert.equal(result.type, 'bugfix');
    });

    it('prefers canonical labels over custom aliases', () => {
      const result = classify(['urgent', 'type: feature'], { typeAliases: { urgent: 'bugfix' } });
      assert.equal(result.type, 'feature');
    });

    it('handles conflicts between custom aliases', () => {
      const result = classify(['urgent', 'low-priority'], { typeAliases: { urgent: 'bugfix', 'low-priority': 'refactor' } });
      assert.equal(result.type, null);
      assert.match(result.warning ?? '', /conflicting type labels/);
    });
  });
});
