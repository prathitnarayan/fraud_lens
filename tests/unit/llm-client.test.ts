import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { chatJson, extractJson, LlmError, type LlmConfig } from "@/lib/llm/client";

const cfg: LlmConfig = {
  provider: "aipipe",
  baseUrl: "https://aipipe.org/openrouter/v1",
  apiKey: "secret-token",
  model: "openai/gpt-4.1-nano",
  timeoutMs: 2000,
};
const schema = z.object({ verdict: z.enum(["fraud", "ok"]) });
const msgs = [{ role: "user" as const, content: "hi" }];

const completion = (content: string, status = 200) =>
  new Response(JSON.stringify({ model: "openai/gpt-4.1-nano", choices: [{ message: { content } }] }), { status });

describe("extractJson", () => {
  it("handles plain, fenced and wrapped JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('Sure! {"a":3} hope that helps')).toEqual({ a: 3 });
    expect(() => extractJson("no json")).toThrow();
  });
});

describe("chatJson", () => {
  it("sends bearer auth, JSON mode, and validates output", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(completion('{"verdict":"fraud"}'));
    const res = await chatJson(cfg, msgs, schema, { fetchImpl });
    expect(res.data).toEqual({ verdict: "fraud" });
    expect(res.attempts).toBe(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://aipipe.org/openrouter/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer secret-token");
    expect(JSON.parse(init.body).response_format).toEqual({ type: "json_object" });
  });

  it("retries once on schema-invalid output with a corrective message", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(completion('{"verdict":"maybe"}'))
      .mockResolvedValueOnce(completion('{"verdict":"ok"}'));
    const res = await chatJson(cfg, msgs, schema, { fetchImpl });
    expect(res.data.verdict).toBe("ok");
    expect(res.attempts).toBe(2);
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).messages).toHaveLength(2);
  });

  it("gives up after retries with bad_output", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(completion("garbage"));
    await expect(chatJson(cfg, msgs, schema, { fetchImpl })).rejects.toMatchObject({ kind: "bad_output" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries 429 then succeeds; does not retry 401", async () => {
    const f1 = vi.fn().mockResolvedValueOnce(completion("", 429)).mockResolvedValueOnce(completion('{"verdict":"ok"}'));
    expect((await chatJson(cfg, msgs, schema, { fetchImpl: f1 })).data.verdict).toBe("ok");

    const f2 = vi.fn().mockResolvedValue(completion("", 401));
    await expect(chatJson(cfg, msgs, schema, { fetchImpl: f2 })).rejects.toMatchObject({ kind: "http", status: 401 });
    expect(f2).toHaveBeenCalledTimes(1);
  });

  it("maps timeouts to kind=timeout without retrying", async () => {
    const err = Object.assign(new Error("t"), { name: "TimeoutError" });
    const fetchImpl = vi.fn().mockRejectedValue(err);
    const p = chatJson(cfg, msgs, schema, { fetchImpl });
    await expect(p).rejects.toBeInstanceOf(LlmError);
    await expect(p).rejects.toMatchObject({ kind: "timeout" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never leaks the API key in error messages", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(completion("", 500));
    const e: unknown = await chatJson(cfg, msgs, schema, { fetchImpl }).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(LlmError);
    expect((e as LlmError).message).not.toContain("secret-token");
  });
});
