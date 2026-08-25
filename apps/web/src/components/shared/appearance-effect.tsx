import { useEffect } from 'react';

import { DEFAULT_APPEARANCE, DEFAULT_LOCALE } from '@vyuha/shared';

import { useBranding } from '@/lib/branding/use-branding';
import { DATE_FORMAT, setWorkspaceDateFormat, setWorkspaceLocale } from '@/lib/format';

import { applyAppearance } from './appearance';

/**
 * Mounted once in the shell; follows the branding query, which every
 * signed-in client already polls. Applies the workspace's appearance to
 * the document and its number and date formats to the formatters.
 */
export function AppearanceEffect() {
  const branding = useBranding();
  const appearance = branding.data?.appearance;
  const locale = branding.data?.locale;
  const dateFormat = branding.data?.dateFormat;
  useEffect(() => {
    applyAppearance(document.documentElement, appearance ?? DEFAULT_APPEARANCE);
  }, [appearance]);
  useEffect(() => {
    setWorkspaceLocale(locale ?? DEFAULT_LOCALE);
  }, [locale]);
  useEffect(() => {
    setWorkspaceDateFormat(dateFormat ?? DATE_FORMAT);
  }, [dateFormat]);
  return null;
}
