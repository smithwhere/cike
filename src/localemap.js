'use strict';
/**
 * Map ISO country code to a likely browser locale.
 * Used when profile.locale is 'auto' (follow proxy region).
 */
const COUNTRY_LOCALE = {
  US: 'en-US', GB: 'en-GB', CA: 'en-CA', AU: 'en-AU', NZ: 'en-NZ', IE: 'en-IE',
  CN: 'zh-CN', TW: 'zh-TW', HK: 'zh-HK',
  JP: 'ja-JP', KR: 'ko-KR',
  DE: 'de-DE', FR: 'fr-FR', ES: 'es-ES', IT: 'it-IT', PT: 'pt-PT', BR: 'pt-BR',
  NL: 'nl-NL', SE: 'sv-SE', NO: 'nb-NO', DK: 'da-DK', FI: 'fi-FI',
  PL: 'pl-PL', RU: 'ru-RU', UA: 'uk-UA', TR: 'tr-TR',
  IN: 'en-IN', SG: 'en-SG', MY: 'ms-MY', TH: 'th-TH', VN: 'vi-VN', ID: 'id-ID', PH: 'en-PH',
  MX: 'es-MX', AR: 'es-AR', CL: 'es-CL', CO: 'es-CO',
  AE: 'ar-AE', SA: 'ar-SA', EG: 'ar-EG', IL: 'he-IL',
  ZA: 'en-ZA', NG: 'en-NG',
};

const LOCALES = [...new Set([...Object.values(COUNTRY_LOCALE),
  'fr-CA', 'es-US', 'es-419', 'en-HK', 'zh-SG', 'fr-CH', 'de-CH', 'it-CH', 'nl-BE', 'fr-BE',
])];
const TIMEZONES = [
  'UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix',
  'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'America/Toronto',
  'America/Vancouver', 'America/Mexico_City', 'America/Bogota', 'America/Lima',
  'America/Santiago', 'America/Sao_Paulo', 'America/Argentina/Buenos_Aires', 'America/Manaus',
  'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Madrid', 'Europe/Rome',
  'Europe/Amsterdam', 'Europe/Warsaw', 'Europe/Kyiv', 'Europe/Moscow', 'Europe/Istanbul',
  'Europe/Zurich', 'Europe/Brussels', 'Europe/Dublin', 'Europe/Lisbon',
  'Africa/Cairo', 'Africa/Lagos', 'Africa/Johannesburg', 'Asia/Jerusalem', 'Asia/Riyadh',
  'Asia/Dubai', 'Asia/Kolkata', 'Asia/Kathmandu', 'Asia/Dhaka', 'Asia/Bangkok', 'Asia/Jakarta',
  'Asia/Kuala_Lumpur', 'Asia/Singapore', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei',
  'Asia/Manila', 'Asia/Seoul', 'Asia/Tokyo', 'Australia/Perth', 'Australia/Brisbane',
  'Australia/Sydney', 'Australia/Adelaide', 'Australia/Darwin', 'Pacific/Auckland',
];

function localeForCountry(countryCode) {
  if (!countryCode) return null;
  return COUNTRY_LOCALE[countryCode.toUpperCase()] || null;
}

module.exports = { localeForCountry, COUNTRY_LOCALE, LOCALES, TIMEZONES };
