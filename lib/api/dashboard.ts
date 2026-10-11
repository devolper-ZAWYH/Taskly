import { rpc } from "@/lib/api/rpc"
import type { Dashboard } from "@/lib/types"

/** The dashboard for one workspace, computed for the viewer's local `today` (YYYY-MM-DD). */
export const getDashboard = (accountId: string, today: string): Promise<Dashboard> =>
  rpc("getDashboard", accountId, today)
