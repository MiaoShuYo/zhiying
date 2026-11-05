import { z } from 'zod';
import { StyleIdSchema } from './style-id';

const HexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i);

export const BrandPaletteSchema = z.object({
  bg: HexColorSchema,
  fg: HexColorSchema,
  muted: HexColorSchema,
  accent: HexColorSchema,
  card: HexColorSchema,
  secondary: HexColorSchema,
});

export const BrandLogoSchema = z.object({
  enabled: z.boolean().default(true),
  src: z.string().min(1),
  position: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']).default('top-right'),
  width: z.number().min(40).max(500).default(160),
  opacity: z.number().min(0).max(1).default(1),
  margin: z.number().min(0).max(200).default(40),
});

export const BrandTypographySchema = z.object({
  headingFont: z.string().trim().min(1).max(100),
  bodyFont: z.string().trim().min(1).max(100),
});

export const BrandSnapshotSchema = z.object({
  name: z.string().trim().min(1).max(40),
  baseStyleId: StyleIdSchema,
  colors: BrandPaletteSchema,
  typography: BrandTypographySchema,
  logo: BrandLogoSchema.optional(),
});

export const BrandKitSchema = BrandSnapshotSchema.extend({
  id: z.string().min(1).max(64),
  isDefault: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type BrandPalette = z.infer<typeof BrandPaletteSchema>;
export type BrandLogo = z.infer<typeof BrandLogoSchema>;
export type BrandTypography = z.infer<typeof BrandTypographySchema>;
export type BrandSnapshot = z.infer<typeof BrandSnapshotSchema>;
export type BrandKit = z.infer<typeof BrandKitSchema>;
