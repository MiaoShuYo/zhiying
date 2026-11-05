import { z } from 'zod';

export const StyleIdSchema = z.enum(['minimal-tech', 'clean-light', 'academic', 'social-short', 'whiteboard']);
