import { useCallback,useEffect,useMemo,useState } from "react";
import {
  defaultExternalPreviewPreferences,
  readExternalPreviewPreferences,
  saveExternalPreviewPreferences,
  type ExternalPreviewPreferences
} from "../lib/externalPreviewPreferences.js";
import { readLanguageChoice,saveLanguageChoice,translate,type LanguageCode } from "../lib/i18n.js";
import { readTimeFormatPreference,saveTimeFormatPreference,type TimeFormatPreference } from "../lib/timeFormat.js";
import { applyThemeChoice,readThemeChoice,saveThemeChoice } from "./navigation.js";
import type { ThemeChoice,Translate } from "./types.js";

export function usePresentationPreferences(userId: string | null) {
  const [theme, setTheme] = useState<ThemeChoice>(() => readThemeChoice());
  const [language, setLanguage] = useState<LanguageCode>(() => readLanguageChoice());
  const [timeFormat, setTimeFormat] = useState<TimeFormatPreference>(() => readTimeFormatPreference(window.localStorage));
  const [previewOverride, setPreviewOverride] = useState<{ userId: string; value: ExternalPreviewPreferences } | null>(null);
  const storedPreviewPreferences = useMemo(
    () => userId ? readExternalPreviewPreferences(window.localStorage, userId) : { ...defaultExternalPreviewPreferences },
    [userId]
  );
  const externalPreviews = previewOverride?.userId === userId
    ? previewOverride.value
    : storedPreviewPreferences;
  const t = useCallback<Translate>((key, values) => translate(language, key, values), [language]);

  useEffect(() => applyThemeChoice(theme), [theme]);
  useEffect(() => { document.documentElement.lang = language; }, [language]);

  const changeLanguage = useCallback((next: LanguageCode) => {
    saveLanguageChoice(next);
    setLanguage(next);
  }, []);
  const changeTheme = useCallback((next: ThemeChoice) => {
    saveThemeChoice(next);
    setTheme(next);
  }, []);
  const changeTimeFormat = useCallback((next: TimeFormatPreference) => {
    saveTimeFormatPreference(window.localStorage, next);
    setTimeFormat(next);
  }, []);
  const changeExternalPreview = useCallback((provider: keyof ExternalPreviewPreferences, enabled: boolean) => {
    if (!userId) return;
    setPreviewOverride((current) => {
      const base = current?.userId === userId ? current.value : readExternalPreviewPreferences(window.localStorage, userId);
      const value = { ...base, [provider]: enabled };
      saveExternalPreviewPreferences(window.localStorage, userId, value);
      return { userId, value };
    });
  }, [userId]);

  return {
    theme,
    language,
    timeFormat,
    externalPreviews,
    t,
    changeLanguage,
    changeTheme,
    changeTimeFormat,
    changeExternalPreview
  };
}
