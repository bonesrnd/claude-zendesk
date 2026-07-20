import {
  createContext,
  type PropsWithChildren,
  useContext,
  useEffect,
  useMemo,
} from "react";

import type { ZafClient } from "../types/zaf";

const ZafContext = createContext<ZafClient | undefined>(undefined);

export function ZafClientProvider({ children }: PropsWithChildren) {
  const client = useMemo(() => ZAFClient.init(), []);

  useEffect(() => {
    client.on("app.registered", () => {
      void client.invoke("resize", { width: "100%", height: "720px" });
    });
  }, [client]);

  return <ZafContext.Provider value={client}>{children}</ZafContext.Provider>;
}

export function useZafClient(): ZafClient {
  const client = useContext(ZafContext);
  if (!client) {
    throw new Error("useZafClient must be used inside ZafClientProvider");
  }
  return client;
}
