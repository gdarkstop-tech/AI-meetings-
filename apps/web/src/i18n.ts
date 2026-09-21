/**
 * Minimal typed i18n. Every user-visible string lives here — no hardcoded text
 * in components — and the direction follows the active locale.
 */
export type Locale = 'ar' | 'en';

export const DICTIONARY = {
  en: {
    'app.name': 'ALIA Meetings',
    'app.phase': 'Phase 1 — foundation',
    'nav.signOut': 'Sign out',
    'nav.workspace': 'Workspace',
    'auth.signIn': 'Sign in',
    'auth.signUp': 'Create account',
    'auth.email': 'Email',
    'auth.name': 'Full name',
    'auth.password': 'Password',
    'auth.passwordHint': 'At least 12 characters.',
    'auth.toggleToRegister': 'Need an account? Create one',
    'auth.toggleToLogin': 'Already have an account? Sign in',
    'auth.submitting': 'Working…',
    'auth.tagline': 'Meeting intelligence for bilingual teams.',
    'dashboard.title': 'Dashboard',
    'dashboard.welcome': 'Signed in as',
    'dashboard.role': 'Your role',
    'dashboard.permissions': 'Permissions',
    'dashboard.time': 'Local time',
    'dashboard.capabilities': 'System capabilities',
    'dashboard.capabilitiesNote':
      'Features are reported honestly. Nothing below is simulated: a provider without configuration is unavailable, not faked.',
    'dashboard.audit': 'Recent audit events',
    'dashboard.auditVerified': 'Hash chain verified',
    'dashboard.auditBroken': 'Hash chain verification FAILED',
    'dashboard.noMeetings': 'Meetings are not implemented yet. They arrive in Phase 2.',
    'status.available': 'Available',
    'status.not_configured': 'Not configured',
    'status.not_implemented': 'Not implemented',
    'language.switch': 'العربية',
    'error.generic': 'Something went wrong.',
  },
  ar: {
    'app.name': 'ALIA للاجتماعات',
    'app.phase': 'المرحلة ١ — الأساس',
    'nav.signOut': 'تسجيل الخروج',
    'nav.workspace': 'مساحة العمل',
    'auth.signIn': 'تسجيل الدخول',
    'auth.signUp': 'إنشاء حساب',
    'auth.email': 'البريد الإلكتروني',
    'auth.name': 'الاسم الكامل',
    'auth.password': 'كلمة المرور',
    'auth.passwordHint': 'اثنا عشر حرفًا على الأقل.',
    'auth.toggleToRegister': 'ليس لديك حساب؟ أنشئ واحدًا',
    'auth.toggleToLogin': 'لديك حساب بالفعل؟ سجّل الدخول',
    'auth.submitting': 'جارٍ التنفيذ…',
    'auth.tagline': 'ذكاء الاجتماعات للفرق ثنائية اللغة.',
    'dashboard.title': 'لوحة التحكم',
    'dashboard.welcome': 'مسجّل الدخول باسم',
    'dashboard.role': 'دورك',
    'dashboard.permissions': 'الصلاحيات',
    'dashboard.time': 'التوقيت المحلي',
    'dashboard.capabilities': 'قدرات النظام',
    'dashboard.capabilitiesNote':
      'حالة كل ميزة معروضة بصدق. لا شيء هنا محاكى: أي مزوّد غير مهيّأ يظهر كغير متاح ولا يتم تزييفه.',
    'dashboard.audit': 'أحدث أحداث السجل',
    'dashboard.auditVerified': 'سلسلة التحقق سليمة',
    'dashboard.auditBroken': 'فشل التحقق من سلسلة السجل',
    'dashboard.noMeetings': 'الاجتماعات غير مُنفّذة بعد. تأتي في المرحلة ٢.',
    'status.available': 'متاح',
    'status.not_configured': 'غير مهيّأ',
    'status.not_implemented': 'غير مُنفّذ',
    'language.switch': 'English',
    'error.generic': 'حدث خطأ ما.',
  },
} as const;

export type TranslationKey = keyof (typeof DICTIONARY)['en'];

export function translate(locale: Locale, key: TranslationKey): string {
  return DICTIONARY[locale][key] ?? DICTIONARY.en[key] ?? key;
}

export function directionFor(locale: Locale): 'rtl' | 'ltr' {
  return locale === 'ar' ? 'rtl' : 'ltr';
}

export function formatDateTime(value: string | Date, locale: Locale, timeZone: string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(date);
}
