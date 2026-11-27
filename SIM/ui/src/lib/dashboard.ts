/**
 * Что свод читает. Среза цеха здесь нет и быть не может: у клиента нет метода shop.
 */
import type { RolesResponse, SessionResponse } from '../../../api-client/types.ts';

export interface DashboardClient {
  session(id: string, shift?: number): Promise<SessionResponse>;
  roles(id: string, shift?: number): Promise<RolesResponse>;
}

export interface DashboardLoad {
  readonly current: SessionResponse;
  readonly previous: SessionResponse | null;
  readonly roles: RolesResponse;
}

export async function loadDashboard(api: DashboardClient, sessionId: string, shift: number): Promise<DashboardLoad> {
  const [current, roles, previous] = await Promise.all([
    api.session(sessionId, shift),
    api.roles(sessionId, shift),
    shift > 0 ? api.session(sessionId, shift - 1) : Promise.resolve(null),
  ]);
  return { current, roles, previous };
}
