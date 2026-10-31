"use client";

import { useCallback, useState } from "react";
import { useSWRConfig } from "swr";
import { useToast } from "@/components/Toast";
import { api, errorMessage } from "@/lib/api";
import type { Company } from "@/lib/types";

type Me = { company: Company };

/**
 * Saves one setting straight away. The screen shows the new value at once and goes back to
 * the old one if the API refuses; the reason is returned in `error`.
 */
export function useSaveSetting(company: Company) {
  const { mutate } = useSWRConfig();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(
    async (patch: Partial<Company>, done: string): Promise<boolean> => {
      setError(null);
      try {
        await mutate<Me>("/auth/me", api.post<Me>("/auth/settings", patch), {
          optimisticData: (current) => ({ company: { ...(current?.company ?? company), ...patch } }),
          rollbackOnError: true,
          populateCache: true,
          revalidate: false,
        });
        toast(done);
        return true;
      } catch (err) {
        setError(errorMessage(err));
        return false;
      }
    },
    [company, mutate, toast],
  );

  return { save, error };
}
