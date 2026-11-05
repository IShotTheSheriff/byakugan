const pad = (n: number) => String(n).padStart(2, '0');

export function formatDate(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

export function formatMoney(value: number) {
  return `$${value.toFixed(2)}`;
}

export const cn = (...names: string[]) => names.join(' ');
