"use client";

import { useActionState } from "react";
import { runDetectionAction, type DetectionState } from "@/app/actions/detection";

export function RunDetectionButton() {
  const [state, action, pending] = useActionState<DetectionState>(runDetectionAction, { ok: true, message: "" });
  return (
    <form action={action} className="flex items-center gap-3">
      <button type="submit" disabled={pending} className="btn-primary">
        {pending ? "Running…" : "Run detection"}
      </button>
      {state.message && (
        <span role="status" className={`text-xs ${state.ok ? "text-neutral-600" : "text-red-700"}`}>
          {state.message}
        </span>
      )}
    </form>
  );
}
