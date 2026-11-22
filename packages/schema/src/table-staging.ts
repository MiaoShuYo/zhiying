import type { Scene } from './index';
import { resolveVisualBeatTimeline } from './visual-timeline';

export type TableBeatSelection = {
  /** Zero-based source row indices to show at this frame. */
  rowIndices: number[];
  staged: boolean;
  beatId?: string;
  uncoveredTargetIds: string[];
};

/**
 * Selects a complete, readable table slice for the current local frame.
 * A table is staged only when every source row is assigned to a beat; partial
 * user plans fall back to the full table so no source facts disappear.
 */
export function resolveTableRowsForFrame(scene: Scene, frame: number, fps = 30): TableBeatSelection {
  const rows = Array.isArray(scene.visual.rows) ? scene.visual.rows : [];
  const allRows = rows.map((_, index) => index);
  const rowTargetIds = rows.map((_, index) => `table-row-${index + 1}`);
  const beats = resolveVisualBeatTimeline(scene, fps);
  const assigned = new Set(beats.flatMap(beat => beat.targetIds));
  const uncoveredTargetIds = rowTargetIds.filter(targetId => !assigned.has(targetId));
  if (rows.length < 2 || beats.length < 2 || uncoveredTargetIds.length > 0) {
    return { rowIndices: allRows, staged: false, uncoveredTargetIds };
  }

  const rowTargets = new Set(rowTargetIds);
  const rowBeats = beats.filter(beat => beat.targetIds.some(targetId => rowTargets.has(targetId)));
  if (!rowBeats.length) return { rowIndices: allRows, staged: false, uncoveredTargetIds: rowTargetIds };

  const active = beats.find(beat => frame >= beat.startFrame && frame < beat.endFrame);
  const activeRows = active?.targetIds.filter(targetId => rowTargets.has(targetId)) ?? [];
  const nearest = rowBeats.reduce((best, candidate) => {
    const distance = frame < candidate.startFrame ? candidate.startFrame - frame : frame >= candidate.endFrame ? frame - candidate.endFrame + 1 : 0;
    const bestDistance = frame < best.startFrame ? best.startFrame - frame : frame >= best.endFrame ? frame - best.endFrame + 1 : 0;
    return distance < bestDistance ? candidate : best;
  });
  const targetIds = activeRows.length ? activeRows : nearest.targetIds.filter(targetId => rowTargets.has(targetId));
  const rowIndices = targetIds.map(targetId => Number(targetId.slice('table-row-'.length)) - 1)
    .filter(index => Number.isInteger(index) && index >= 0 && index < rows.length)
    .sort((left, right) => left - right);
  if (!rowIndices.length) return { rowIndices: allRows, staged: false, uncoveredTargetIds: rowTargetIds };
  return { rowIndices, staged: true, beatId: activeRows.length ? active!.id : nearest.id, uncoveredTargetIds: [] };
}
