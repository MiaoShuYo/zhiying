import React from 'react';
import { Composition, registerRoot } from 'remotion';
import { ExplainerVideo, getDurationInFrames } from '@m2v/video';
import { StoryboardSchema, type Storyboard } from '@m2v/schema';

function Root() {
  const storyboard = StoryboardSchema.parse({ title: 'Local AI Explainer', styleId: 'minimal-tech', aspectRatio: '16:9', scenes: [{ id: 'placeholder', type: 'title', title: '预览', narration: '正在准备分镜', duration: 3, visual: {} }] });
  return <Composition id="ExplainerVideo" component={ExplainerVideo} durationInFrames={getDurationInFrames(storyboard)} fps={30} width={1920} height={1080} defaultProps={{ storyboard }} calculateMetadata={({ props }) => ({ durationInFrames: getDurationInFrames(props.storyboard) })} />;
}
registerRoot(Root);
