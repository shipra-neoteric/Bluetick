import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/webhooks/ssrf", () => ({
  isDeliverableUrl: async (u: string) => !/localhost|127\.0\.0\.1|10\.\d/.test(u),
}));

import { fillJsonTemplate, parseCurl, shellSplit } from "./curl";
import { performApiCall } from "./call-api";

describe("parseCurl (Import from cURL, A20.06)", () => {
  it("reads method, URL, headers and body", () => {
    const p = parseCurl(`curl -X POST 'https://api.example.test/leads' \\
      -H 'Authorization: Bearer abc' -H "Content-Type: application/json" \\
      --data-raw '{"name":"Asha","note":"it'\\''s ok"}'`);
    expect(p.method).toBe("POST");
    expect(p.url).toBe("https://api.example.test/leads");
    expect(p.headers).toEqual([
      { key: "Authorization", value: "Bearer abc" },
      { key: "Content-Type", value: "application/json" },
    ]);
    expect(JSON.parse(p.body)).toEqual({ name: "Asha", note: "it's ok" });
  });
  it("defaults to GET without data, POST with data, and handles --json / -u", () => {
    expect(parseCurl("curl https://x.test/a").method).toBe("GET");
    expect(parseCurl("curl https://x.test/a -d a=1").method).toBe("POST");
    const j = parseCurl(`curl --json '{"a":1}' --url=https://x.test/j -u user:pass`);
    expect(j.headers.map((h) => h.key)).toEqual(["Content-Type", "Accept", "Authorization"]);
    expect(j.headers[2].value).toBe("Basic dXNlcjpwYXNz");
    expect(j.url).toBe("https://x.test/j");
  });
  it("only parses — shell syntax is text, never run", () => {
    const p = parseCurl("curl 'https://x.test/$(rm -rf /)'");
    expect(p.url).toBe("https://x.test/$(rm -rf /)");
  });
  it("rejects what it can't read", () => {
    expect(() => parseCurl("wget https://x.test")).toThrow(/starts with "curl"/);
    expect(() => parseCurl("curl -H 'x: y'")).toThrow(/No URL/);
    expect(() => shellSplit("curl 'unclosed")).toThrow(/Unclosed/);
    expect(() => parseCurl("curl -X TRACE https://x.test")).toThrow(/isn't supported/);
  });
});

describe("fillJsonTemplate", () => {
  it("fills string by string so quotes can't break the JSON", () => {
    const out = fillJsonTemplate('{"name":"{{contact.name}}","n":2}', () => 'Ra"vi');
    expect(JSON.parse(out)).toEqual({ name: 'Ra"vi', n: 2 });
  });
  it("fills plain text when the body isn't JSON", () => {
    expect(fillJsonTemplate("a={{x}}", (s) => s.replace("{{x}}", "1"))).toBe("a=1");
  });
});

describe("performApiCall", () => {
  afterEach(() => vi.unstubAllGlobals());
  const fill = (s: string) => s.replace("{{vars.id}}", "42");

  it("calls the API, maps the response and reports success", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { id: "L-9", tags: ["a"] } }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await performApiCall(
      {
        method: "POST",
        url: "https://api.example.test/leads/{{vars.id}}",
        headers: [{ key: "X-Key", value: "k" }, { key: "Host", value: "evil" }],
        body: '{"id":"{{vars.id}}"}',
        response_map: [{ path: "data.id", var: "lead_id" }, { path: "data.tags", var: "tags" }, { path: "x", var: "bad var" }],
      },
      fill,
    );
    expect(r).toMatchObject({ ok: true, status: 201, mapped: { lead_id: "L-9", tags: '["a"]' } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.test/leads/42");
    expect(init).toMatchObject({ method: "POST", redirect: "manual", body: '{"id":"42"}' });
    expect(init.headers).toEqual({ "X-Key": "k", "Content-Type": "application/json" }); // Host dropped
  });

  it("reports a non-2xx answer as a failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const r = await performApiCall({ method: "GET", url: "https://api.example.test/x", headers: [] }, fill);
    expect(r).toMatchObject({ ok: false, status: 500, body: "nope", error: "The API answered 500." });
  });

  it("refuses private addresses and bad URLs without calling", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await performApiCall({ method: "GET", url: "http://127.0.0.1/admin", headers: [] }, fill)).error).toMatch(/not allowed/);
    expect((await performApiCall({ method: "GET", url: "ftp://x", headers: [] }, fill)).error).toMatch(/must start/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
