"use client";

import { useCallback, useState } from "react";
import styles from "../auth.module.css";

/**
 * Shakes failed fields once per attempt. Call `shake()` when a submit fails, and put
 * `shakeClass(isBad)` on the wrapper of each control. The class name alternates between two
 * identical animations so the shake replays on the next attempt without remounting the input.
 */
export function useShake() {
  const [run, setRun] = useState(0);
  const shake = useCallback(() => setRun((n) => n + 1), []);
  const shakeClass = (bad: boolean): string | undefined => (bad && run > 0 ? (run % 2 === 1 ? styles.shakeA : styles.shakeB) : undefined);
  return { shake, shakeClass };
}
