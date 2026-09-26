import "server-only";
import { parseServerEnv, type ServerEnv } from "@/lib/env";

let cached: ServerEnv | undefined;

export function getServerEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}
