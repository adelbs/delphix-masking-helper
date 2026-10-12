/**
 * Algorithms that come with the Masking Engine (the dlpx-core plugin) and that the presets name
 * instead of creating their own: a domain, or a step of another algorithm, refers to them by name,
 * and the engine already has them — nothing is created or sent.
 *
 * Use one wherever it does the job as it ships; create an algorithm only for what none of them
 * does. Each was compared with the preset algorithm it replaced, through the local runner:
 *
 *   CM Numeric     maps each digit to another and keeps the number of digits, the sign, the decimal
 *                  places and the zeros on the left — for amounts. It replaced Numeric Mappings
 *                  that put any amount into a fixed range and lost its order of magnitude.
 *   Credit Card    another number that passes the Luhn check, keeping the first six digits (the
 *                  issuer, not the holder). Like any Payment Card it fails a value with no digits,
 *                  so the presets keep a Regex Decompose in front that only hands it card shapes.
 *   BloodType SL   one of the eight groups, by keyed hash. It writes O, not 0: Argentina, where the
 *                  group is written 0+, keeps its own lookup.
 *   Brazil CPF     the same output as the Brazil preset's own CPF chain on every CPF compared,
 *                  formatted or not, including those that lost zeros on the left.
 *
 * Compared and left aside: CM Alpha-Numeric (maps hex letters to any letter, breaking a MAC or
 * UUID, and leaves accented letters to chance), CM Digits (the presets' digit mapping is the same
 * but keeps zeros on the left), Brazil CNPJ (masks the branch, which the preset keeps), IBAN (in
 * Costa Rica it changes the reserved zero; Spain needs its second check digit fixed), the name, e-mail,
 * phone and category lookups (English or United States values), Lat_Long Coordinates (moves the
 * point, where the presets generalize it). The Date Shift instances do not run in the local runner,
 * so they could not be compared; the presets keep their own windows.
 */

export const ENGINE = {
  CM_NUMERIC: 'dlpx-core:CM Numeric',
  CREDIT_CARD: 'dlpx-core:Credit Card',
  BLOOD_TYPE: 'dlpx-core:BloodType SL',
  BRAZIL_CPF: 'dlpx-core:Brazil CPF',
}

/** The framework of each, for documentation and display. */
export const ENGINE_FRAMEWORK = {
  [ENGINE.CM_NUMERIC]: 'algorithm.plugin.characterMapping.NumericMapping',
  [ENGINE.CREDIT_CARD]: 'algorithm.plugin.characterMapping.PaymentCard',
  [ENGINE.BLOOD_TYPE]: 'algorithm.plugin.secureLookup.SecureLookup',
  [ENGINE.BRAZIL_CPF]: 'algorithm.plugin.checkdigit.Checkdigit',
}

export const isEngineAlgorithm = (name) => Object.hasOwn(ENGINE_FRAMEWORK, name)
