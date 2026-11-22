import { z } from 'zod';
import { MotionActionSchema } from './motion';

/** The five editorial layouts supported by the standard Scene renderer. */
export const VisualTemplateIdSchema = z.enum(['hero', 'comparison', 'diagram', 'timeline', 'chart']);
export type VisualTemplateId = z.infer<typeof VisualTemplateIdSchema>;

export const VisualIntentSchema = z.enum([
  'hook', 'comparison', 'flow', 'timeline', 'data-story', 'explanation', 'summary',
]);
export type VisualIntent = z.infer<typeof VisualIntentSchema>;

/** Semantic beat data stays attached to the source Scene; frame positions are always recomputed. */
export const VisualBeatSchema = z.object({
  id: z.string().min(1).max(80),
  /** Empty for a visual-only beat when there are more items than narration clauses. */
  narrationText: z.string().max(800).default(''),
  /** A verbatim segment of the visible source text, when the visual content itself is staged. */
  contentText: z.string().max(1200).optional(),
  targetIds: z.array(z.string().min(1).max(80)).max(40).default([]),
  label: z.string().max(120).optional(),
});
export type VisualBeat = z.infer<typeof VisualBeatSchema>;

/**
 * Versioned, serializable plan for one standard Scene. It contains semantic references only:
 * model output cannot supply stylesheets, scripts, URLs, or executable render instructions.
 */
export const VisualPlanSchema = z.object({
  version: z.literal(1).default(1),
  registryVersion: z.string().min(1).max(32).default('1'),
  narrativeIntent: VisualIntentSchema.default('explanation'),
  templateId: VisualTemplateIdSchema,
  keyFocus: z.string().max(300).optional(),
  selectionReason: z.enum(['title-or-text', 'two-column-comparison', 'ordered-flow', 'chronological-events', 'numeric-data']).optional(),
  beats: z.array(VisualBeatSchema).max(80).default([]),
  motionPresets: z.array(MotionActionSchema).max(240).default([]),
  /** source element id -> target id; only identifiers are stored, never markup or code. */
  elementMap: z.record(z.string().min(1).max(80)).default({}),
  manualOverride: z.boolean().default(false),
  provenance: z.enum(['rule', 'local-model', 'user']).default('rule'),
});
export type VisualPlan = z.infer<typeof VisualPlanSchema>;

export const visualTemplateSceneTypes = {
  hero: ['title', 'text'],
  comparison: ['comparison'],
  diagram: ['diagram'],
  timeline: ['timeline'],
  chart: ['chart'],
} as const;

/** Validate that a plan is appropriate for the standard Scene it will render. */
export function visualTemplateSupportsScene(templateId: VisualTemplateId, sceneType: string): boolean {
  return (visualTemplateSceneTypes[templateId] as readonly string[]).includes(sceneType);
}
