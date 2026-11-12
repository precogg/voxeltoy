import { createContext, useContext } from "solid-js";
import type { Session } from "./session";

/** What is open: the local draft, a shared snapshot or a live session. */
export const SessionContext = createContext<Session>();

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used inside <SessionContext.Provider>");
  return session;
}
