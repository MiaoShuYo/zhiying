import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SceneSchema, StoryboardSchema, decideVisualTemplate, selectRuleVisualPlans } from '../src/index';

const fixtures = [
  { id: 'hero', type: 'title', visual: { text: '请求延迟降低。' } },
  { id: 'comparison', type: 'comparison', visual: { columns: [{ title: '同步', items: ['等待'] }, { title: '异步', items: ['继续'] }] } },
  { id: 'diagram', type: 'diagram', visual: { nodes: [{ id: 'in', label: '输入' }, { id: 'out', label: '输出' }] } },
  { id: 'timeline', type: 'timeline', visual: { items: [{ date: '一', label: '接收' }, { date: '二', label: '完成' }] } },
  { id: 'chart', type: 'chart', visual: { data: [{ label: '一季度', value: 12 }] } },
] as const;

test('rule template selection is repeatable for all standard scene shapes', () => {
  const expected = ['hero', 'comparison', 'diagram', 'timeline', 'chart'];
  for (const [index, fixture] of fixtures.entries()) {
    const scene = SceneSchema.parse({ ...fixture, narration: '固定来源旁白。' });
    const first = decideVisualTemplate(scene);
    const second = decideVisualTemplate(scene);
    assert.deepEqual(first, second, `${fixture.id} rule choice is deterministic`);
    assert.equal(first?.templateId, expected[index]);
  }
});

test('rule selection applies to generated scenes and preserves a user lock until explicit reselect', () => {
  const generated = fixtures.map(fixture => SceneSchema.parse({ ...fixture, narration: '原始旁白。' }));
  const generatedBoard = StoryboardSchema.parse({ title: '规则选模', styleId: 'minimal-tech', transition: 'none', scenes: generated });
  const selected = selectRuleVisualPlans(generatedBoard);
  assert.deepEqual(selected.scenes.map(scene => scene.visualPlan?.provenance), Array(5).fill('rule'));
  assert.deepEqual(selected.scenes.map(scene => scene.visualPlan?.manualOverride), Array(5).fill(false));

  const manuallyChosen = SceneSchema.parse({
    ...fixtures[0], narration: '原始旁白。',
    visualPlan: { templateId: 'hero', keyFocus: '用户焦点', provenance: 'user', manualOverride: true },
  });
  const boardWithLock = StoryboardSchema.parse({ title: '手工覆盖', styleId: 'minimal-tech', transition: 'none', scenes: [manuallyChosen] });
  const automaticPass = selectRuleVisualPlans(boardWithLock);
  assert.deepEqual(automaticPass.scenes[0], manuallyChosen, 'ordinary automatic selection does not overwrite a manually locked scene');

  const decision = decideVisualTemplate(manuallyChosen);
  assert.ok(decision);
  const explicitlyReselected = SceneSchema.parse({
    ...manuallyChosen,
    visualPlan: { ...manuallyChosen.visualPlan, ...decision, manualOverride: false, provenance: 'rule' },
  });
  assert.equal(explicitlyReselected.visualPlan?.manualOverride, false, 'explicit reselect clears the lock');
  assert.equal(explicitlyReselected.visualPlan?.provenance, 'rule');
  assert.equal(explicitlyReselected.visualPlan?.keyFocus, '用户焦点', 'reselect keeps the user-authored focus');
  assert.equal(explicitlyReselected.narration, manuallyChosen.narration);

  const productionTools = readFileSync(new URL('../../../apps/web/src/components/production-tools.tsx', import.meta.url), 'utf8');
  const editor = readFileSync(new URL('../../../apps/web/src/components/project-editor.tsx', import.meta.url), 'utf8');
  assert.match(productionTools, /function chooseVisualTemplate[\s\S]*?manualOverride: true, provenance: 'user'[\s\S]*?patchScene\(/, 'manual template picker routes changes through the undoable scene patch');
  assert.match(productionTools, /function patchScene\([\s\S]*?setUndoBoard\(board\)[\s\S]*?onChange\(/, 'template and density edits save the previous board for undo');
  assert.match(productionTools, /data-template-thumbnail=\{templateId\}/, 'each candidate exposes its local visual thumbnail');
  assert.match(productionTools, /aria-label="候选视觉模板"[\s\S]*?onClick=\{\(\) => chooseVisualTemplate\(templateId\)\}/, 'candidate cards select their corresponding template');
  assert.match(productionTools, /function reselectVisualTemplate\(\)[\s\S]*?decideVisualTemplate\(scene\)[\s\S]*?manualOverride: false, provenance: 'rule'/, 'reselect button applies the deterministic rule and clears the user lock');
  assert.match(editor, /boardUndo\.current = \[\.\.\.boardUndo\.current\.slice\(-49\), JSON\.parse\(JSON\.stringify\(previous\)\) as Storyboard\]/, 'editor snapshots the previous storyboard before an edit');
  assert.match(editor, /const undoBoard = useCallback\(\(\) => \{[\s\S]*?boardUndo\.current\.pop\(\)[\s\S]*?setData\(current => \(\{ \.\.\.current, storyboard: previous \}\)\)/, 'editor undo restores the previous storyboard snapshot');
  assert.match(editor, /title="撤销上一步分镜修改（Ctrl\+Z）" onClick=\{undoBoard\}/, 'the undo control is visible in the project editor');
});
