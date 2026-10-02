export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_ENV: 'staging' | 'production';
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ADMIN_EMAIL_HASH: string;
  APP_VERSION?: string;
  PUBLIC_ORIGIN?: string;
}
export interface Category {
  id: string;
  name: string;
  slug: string;
  description: string;
  sortOrder: number;
  enabled: boolean;
  updatedAt: string;
  deletedAt?: string | null;
}
export interface Link {
  id: string;
  categoryId: string;
  name: string;
  url: string;
  description: string;
  icon: string;
  iconMode: 'auto' | 'manual' | 'none';
  iconCheckedAt: string | null;
  sortOrder: number;
  enabled: boolean;
  featured: boolean;
  notes: string;
  expectedKeywords: string[];
  expectedTitle: string;
  expectedDescription: string;
  contentStatus: 'match' | 'partial' | 'changed' | 'mismatch' | 'unknown';
  similarityScore: number | null;
  redirectChain: { url: string; status: number; location: string }[];
  healthStatus: string;
  healthOverride: string | null;
  checkDisabled: boolean;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  nextCheckAt: string;
  finalUrl: string | null;
  httpStatus: number | null;
  consecutiveFailures: number;
  lastError: string | null;
  observedTitle: string | null;
  healthEvidence: string[];
  updatedAt: string;
  deletedAt?: string | null;
}
