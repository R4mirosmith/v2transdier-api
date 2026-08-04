/**
 * Convierte cualquier valor DECIMAL de MariaDB a centavos enteros.
 * Evita errores de punto flotante al sumar dinero en JavaScript.
 */
export function moneyToCents(value) {
  if (value === null || value === undefined || value === '') return 0;

  const raw = String(value).trim().replace(/\s/g, '').replace(',', '.');
  const match = raw.match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match) return 0;

  const sign = match[1] === '-' ? -1 : 1;
  const whole = Number(match[2] || 0);
  const fraction = String(match[3] || '').padEnd(3, '0');
  const cents = Number(fraction.slice(0, 2) || 0);
  const roundUp = Number(fraction[2] || 0) >= 5 ? 1 : 0;

  return sign * ((whole * 100) + cents + roundUp);
}

export function centsToMoney(cents) {
  return Number((Number(cents || 0) / 100).toFixed(2));
}

export function sumMoney(values = []) {
  return centsToMoney(values.reduce((total, value) => total + moneyToCents(value), 0));
}

export function addMoney(...values) {
  return sumMoney(values);
}

export function subtractMoney(minuend, subtrahend) {
  return centsToMoney(moneyToCents(minuend) - moneyToCents(subtrahend));
}
