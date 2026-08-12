// roles.ts —— 角色颜色辅助函数（动态配置版，从 State.roles 读取）。
export interface RoleConfig {
  label: string;
  color: string;
}

export function darkenColor(hex: string): string {
  const c = (hex.startsWith('#') ? hex.slice(1) : hex).padEnd(6, '0');
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  const f = 0.7;
  return `rgb(${Math.round(r * f)},${Math.round(g * f)},${Math.round(b * f)})`;
}

export function getRoleColor(idx: number | null | undefined, roles: RoleConfig[]): string | null {
  if (idx == null || idx < 0 || idx >= roles.length) return null;
  return roles[idx]?.color ?? null;
}

export function getRoleDarkColor(idx: number | null | undefined, roles: RoleConfig[]): string {
  if (idx == null || idx < 0 || idx >= roles.length) return 'rgba(255,255,255,0.55)';
  const color = roles[idx]?.color;
  return color ? darkenColor(color) : 'rgba(255,255,255,0.55)';
}
