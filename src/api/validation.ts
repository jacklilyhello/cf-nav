import { z } from 'zod';
import { validatePublicUrl } from '../health';
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const text = (max: number) => z.string().trim().max(max);
const publicUrl = text(2048).transform((value, ctx) => {
  try {
    validatePublicUrl(value);
    // Fragments are meaningful for client-side routes and in-page navigation.
    // The health transport strips them only when making its HTTP probe.
    return new URL(value).href;
  } catch {
    ctx.addIssue({ code: 'custom', message: '仅允许公网 HTTP(S) 网址' });
    return z.NEVER;
  }
});
export const categorySchema = z.object({
  id: identifier.optional(),
  name: text(80).min(1),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  description: text(500).default(''),
  sortOrder: z.number().int().min(-10000).max(10000).default(0),
  enabled: z.boolean().default(true),
});
export const linkSchema = z.object({
  id: identifier.optional(),
  categoryId: identifier,
  name: text(120).min(1),
  url: publicUrl,
  description: text(1000).default(''),
  icon: text(500)
    .default('')
    .refine((value) => {
      if (!value || (value.length <= 16 && !value.includes('://'))) return true;
      try {
        return validatePublicUrl(value).protocol === 'https:';
      } catch {
        return false;
      }
    }, '图标使用短文字或公网 HTTPS 地址'),
  sortOrder: z.number().int().min(-10000).max(10000).default(0),
  enabled: z.boolean().default(true),
  featured: z.boolean().default(false),
  notes: text(4000).default(''),
  expectedKeywords: z.array(text(80).min(1)).max(12).default([]),
  checkDisabled: z.boolean().default(false),
  healthOverride: z
    .enum([
      'healthy',
      'needs_review',
      'moved',
      'content_changed',
      'domain_parking',
      'domain_for_sale',
      'not_found',
      'gone',
      'unknown',
    ])
    .nullable()
    .default(null),
});
export const importSchema = z.object({
  version: z.literal(1),
  mode: z.literal('merge').default('merge'),
  categories: z.array(categorySchema).max(100),
  links: z.array(linkSchema).max(1000),
});
